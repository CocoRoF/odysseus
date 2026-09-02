"""워크스페이스 파일 유틸 — IDE·에이전트·러너가 공유하는 단일 진실(DB) 위의 공통 연산.

경로 규칙: 슬래시 구분 상대 경로("src/main.py"). 선행 슬래시·"."·".." 세그먼트 금지.
"""

import uuid

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from .config import settings
from .models import Event, WorkspaceFile


class WorkspaceError(Exception):
    def __init__(self, code: int, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def normalize_path(path: str) -> str:
    """경로 정규화 + 탈출 차단. 위반 시 WorkspaceError(400)."""
    p = (path or "").strip().replace("\\", "/").lstrip("/")
    if not p or len(p) > 500:
        raise WorkspaceError(400, "경로가 비어 있거나 너무 깁니다")
    parts = [seg for seg in p.split("/") if seg != ""]
    for seg in parts:
        if seg in (".", "..") or seg.startswith(" ") or len(seg) > 120:
            raise WorkspaceError(400, f"허용되지 않는 경로 세그먼트: {seg!r}")
    return "/".join(parts)


async def list_files(db: AsyncSession, attempt_id: uuid.UUID, scenario_id: uuid.UUID) -> list[WorkspaceFile]:
    return list(
        (
            await db.execute(
                select(WorkspaceFile)
                .where(WorkspaceFile.attempt_id == attempt_id, WorkspaceFile.scenario_id == scenario_id)
                .order_by(WorkspaceFile.path)
                .execution_options(populate_existing=True)
            )
        ).scalars().all()
    )


async def get_file(
    db: AsyncSession, attempt_id: uuid.UUID, scenario_id: uuid.UUID, path: str
) -> WorkspaceFile | None:
    return (
        await db.execute(
            select(WorkspaceFile).where(
                WorkspaceFile.attempt_id == attempt_id,
                WorkspaceFile.scenario_id == scenario_id,
                WorkspaceFile.path == path,
            ).execution_options(populate_existing=True)
        )
    ).scalar_one_or_none()


async def save_file(
    db: AsyncSession,
    attempt_id: uuid.UUID,
    scenario_id: uuid.UUID,
    path: str,
    content: str,
    *,
    actor: str = "ide",
    record_event: bool = True,
) -> tuple[WorkspaceFile, bool]:
    """생성 또는 갱신. (row, created) 반환. 검증 위반 시 WorkspaceError."""
    path = normalize_path(path)
    if len(content.encode("utf-8", errors="ignore")) > settings.max_file_bytes:
        raise WorkspaceError(413, f"파일이 너무 큽니다 (최대 {settings.max_file_bytes // 1024}KB)")
    row = await get_file(db, attempt_id, scenario_id, path)
    created = row is None
    if created:
        count = (
            await db.execute(
                select(func.count(WorkspaceFile.id)).where(
                    WorkspaceFile.attempt_id == attempt_id, WorkspaceFile.scenario_id == scenario_id
                )
            )
        ).scalar() or 0
        if count >= settings.max_files_per_scenario:
            raise WorkspaceError(409, f"파일 수 한도({settings.max_files_per_scenario})에 도달했습니다")
        row = WorkspaceFile(attempt_id=attempt_id, scenario_id=scenario_id, path=path, content=content)
        db.add(row)
    else:
        row.content = content
    if record_event:
        db.add(
            Event(
                attempt_id=attempt_id,
                scenario_id=scenario_id,
                type="file_create" if created else "file_save",
                payload={"path": path, "bytes": len(content.encode("utf-8", errors="ignore")), "actor": actor},
            )
        )
    return row, created


async def delete_file(
    db: AsyncSession, attempt_id: uuid.UUID, scenario_id: uuid.UUID, path: str, *, actor: str = "ide"
) -> bool:
    path = normalize_path(path)
    result = await db.execute(
        delete(WorkspaceFile).where(
            WorkspaceFile.attempt_id == attempt_id,
            WorkspaceFile.scenario_id == scenario_id,
            WorkspaceFile.path == path,
        )
    )
    if result.rowcount:
        db.add(
            Event(
                attempt_id=attempt_id,
                scenario_id=scenario_id,
                type="file_delete",
                payload={"path": path, "actor": actor},
            )
        )
    return bool(result.rowcount)


async def copy_path(
    db: AsyncSession,
    attempt_id: uuid.UUID,
    scenario_id: uuid.UUID,
    from_path: str,
    to_path: str,
    *,
    actor: str = "ide",
) -> int:
    """파일 또는 폴더(프리픽스) 복사. 복사된 파일 수 반환.

    from_path가 파일이면 단순 복사. 폴더면 그 아래 전체를 to_path 프리픽스로 옮겨 복사한다.
    대상이 이미 있으면 409.
    """
    src = normalize_path(from_path)
    dst = normalize_path(to_path)
    if dst == src or dst.startswith(src + "/"):
        raise WorkspaceError(400, "대상 경로가 원본 안에 있을 수 없습니다")

    exact = await get_file(db, attempt_id, scenario_id, src)
    if exact is not None:
        if await get_file(db, attempt_id, scenario_id, dst):
            raise WorkspaceError(409, f"대상이 이미 존재합니다: {dst}")
        await save_file(db, attempt_id, scenario_id, dst, exact.content, actor=actor, record_event=False)
        db.add(Event(attempt_id=attempt_id, scenario_id=scenario_id, type="file_copy",
                     payload={"from": src, "to": dst, "actor": actor}))
        return 1

    # 폴더 복사
    rows = await list_files(db, attempt_id, scenario_id)
    prefix = src + "/"
    members = [r for r in rows if r.path.startswith(prefix)]
    if not members:
        raise WorkspaceError(404, f"경로가 없습니다: {src}")
    count = 0
    for r in members:
        new_path = dst + "/" + r.path[len(prefix):]
        if await get_file(db, attempt_id, scenario_id, new_path):
            continue
        await save_file(db, attempt_id, scenario_id, new_path, r.content, actor=actor, record_event=False)
        count += 1
    db.add(Event(attempt_id=attempt_id, scenario_id=scenario_id, type="file_copy",
                 payload={"from": src, "to": dst, "count": count, "actor": actor}))
    return count


async def move_path(
    db: AsyncSession,
    attempt_id: uuid.UUID,
    scenario_id: uuid.UUID,
    from_path: str,
    to_path: str,
    *,
    actor: str = "ide",
) -> int:
    """파일 또는 폴더 이름 변경/이동. 옮긴 파일 수 반환."""
    src = normalize_path(from_path)
    dst = normalize_path(to_path)
    if dst == src:
        return 0
    if dst.startswith(src + "/"):
        raise WorkspaceError(400, "대상 경로가 원본 안에 있을 수 없습니다")

    exact = await get_file(db, attempt_id, scenario_id, src)
    if exact is not None:
        if await get_file(db, attempt_id, scenario_id, dst):
            raise WorkspaceError(409, f"대상이 이미 존재합니다: {dst}")
        content = exact.content
        await delete_file(db, attempt_id, scenario_id, src, actor=actor)
        await save_file(db, attempt_id, scenario_id, dst, content, actor=actor, record_event=False)
        db.add(Event(attempt_id=attempt_id, scenario_id=scenario_id, type="file_rename",
                     payload={"from": src, "to": dst, "actor": actor}))
        return 1

    rows = await list_files(db, attempt_id, scenario_id)
    prefix = src + "/"
    members = [r for r in rows if r.path.startswith(prefix)]
    if not members:
        raise WorkspaceError(404, f"경로가 없습니다: {src}")
    for r in members:
        new_path = dst + "/" + r.path[len(prefix):]
        if await get_file(db, attempt_id, scenario_id, new_path):
            raise WorkspaceError(409, f"대상이 이미 존재합니다: {new_path}")
    for r in members:
        content = r.content
        new_path = dst + "/" + r.path[len(prefix):]
        await delete_file(db, attempt_id, scenario_id, r.path, actor=actor)
        await save_file(db, attempt_id, scenario_id, new_path, content, actor=actor, record_event=False)
    db.add(Event(attempt_id=attempt_id, scenario_id=scenario_id, type="file_rename",
                 payload={"from": src, "to": dst, "count": len(members), "actor": actor}))
    return len(members)


async def delete_path(
    db: AsyncSession, attempt_id: uuid.UUID, scenario_id: uuid.UUID, path: str, *, actor: str = "ide"
) -> int:
    """파일 또는 폴더(프리픽스) 삭제. 삭제된 파일 수 반환."""
    src = normalize_path(path)
    if await delete_file(db, attempt_id, scenario_id, src, actor=actor):
        return 1
    rows = await list_files(db, attempt_id, scenario_id)
    prefix = src + "/"
    members = [r for r in rows if r.path.startswith(prefix)]
    for r in members:
        await delete_file(db, attempt_id, scenario_id, r.path, actor=actor)
    return len(members)


def files_payload(rows: list[WorkspaceFile]) -> list[dict]:
    """러너 잡에 싣는 파일 목록."""
    return [{"path": r.path, "content": r.content} for r in rows]

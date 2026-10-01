"""워크스페이스 파일 유틸 — IDE·에이전트·러너가 공유하는 단일 진실(DB) 위의 공통 연산.

경로 규칙: 슬래시 구분 상대 경로("src/main.py"). 선행 슬래시·"."·".." 세그먼트 금지.
"""

import hashlib
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


class WorkspaceConflict(WorkspaceError):
    """편집기가 읽은 뒤로 서버의 파일이 바뀌었다 — 자동 저장이 그 변경을 덮으면 안 된다.

    ``current_sha256`` 은 지금 서버에 있는 내용의 해시(파일이 사라졌으면 None)다.
    """

    def __init__(self, current_sha256: str | None):
        if current_sha256 is None:
            super().__init__(409, "다른 곳에서 이 파일이 삭제되었습니다")
        else:
            super().__init__(409, "다른 곳에서 이 파일이 바뀌었습니다")
        self.current_sha256 = current_sha256


def content_sha256(content: str) -> str:
    """파일 내용의 버전 — 편집기가 "내가 읽은 그 내용인가" 를 묻는 데 쓴다.

    시각(updated_at)이 아니라 내용으로 정하는 이유: 다른 앱이 **같은 내용**을 다시 저장해도
    충돌로 보지 않아야 하고, 같은 내용이면 누가 먼저 썼는지가 중요하지 않기 때문이다.
    """
    return hashlib.sha256((content or "").encode("utf-8", errors="surrogatepass")).hexdigest()


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
    base_sha256: str | None = None,
) -> tuple[WorkspaceFile, bool]:
    """생성 또는 갱신. (row, created) 반환. 검증 위반 시 WorkspaceError.

    ``base_sha256`` 을 주면 **조건부 저장**이다: 서버의 내용이 그 버전이 아니면 WorkspaceConflict.
    편집기의 자동 저장이 에이전트·터미널이 방금 바꾼 파일을 조용히 덮지 않게 하는 장치다.
    비교와 갱신 사이에 다른 쓰기가 끼지 않도록 행을 잠그고 읽는다. 이미 같은 내용이면(재시도로
    먼저 도착한 저장 등) 충돌이 아니다.
    """
    path = normalize_path(path)
    if len(content.encode("utf-8", errors="ignore")) > settings.max_file_bytes:
        raise WorkspaceError(413, f"파일이 너무 큽니다 (최대 {settings.max_file_bytes // 1024}KB)")
    if base_sha256 is not None:
        row = (
            await db.execute(
                select(WorkspaceFile)
                .where(
                    WorkspaceFile.attempt_id == attempt_id,
                    WorkspaceFile.scenario_id == scenario_id,
                    WorkspaceFile.path == path,
                )
                .with_for_update()
                .execution_options(populate_existing=True)
            )
        ).scalar_one_or_none()
        if row is None:
            raise WorkspaceConflict(None)
        if row.content != content and content_sha256(row.content) != base_sha256:
            raise WorkspaceConflict(content_sha256(row.content))
    else:
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


# ── 초기 상태로 되돌리기 ─────────────────────────────────────
#
# 시나리오가 처음 제공한 파일(initial_files)은 응시 정의에 동결되어 있어 언제든 원본이 된다.
# 응시자가 여러 가지를 시도하다 아니다 싶으면 파일 하나 또는 전체를 그 원본으로 돌린다.
# 되돌리기는 이벤트(file_reset)로 남는다 — 평가자는 "몇 번이나 처음부터 다시 했는가"를 본다.


def initial_file_map(initial_files: list[dict]) -> dict[str, str]:
    """동결 정의의 initial_files → {정규화 경로: 내용}. 경로가 비었거나 잘못된 항목은 버린다."""
    out: dict[str, str] = {}
    for f in initial_files or []:
        raw = str((f or {}).get("path") or "")
        if not raw:
            continue
        try:
            path = normalize_path(raw)
        except WorkspaceError:
            continue
        out[path] = str((f or {}).get("content") or "")
    return out


def plan_reset(initial: dict[str, str], current_paths: list[str], path: str | None) -> tuple[list[str], list[str]]:
    """무엇을 복원하고 무엇을 지울지 — 순수 계산이라 서버 없이 검사한다.

    반환: (복원할 경로들, 삭제할 경로들)
      · path 가 있으면 그 파일 하나만 복원, 삭제 없음. 초기 파일이 아니면 WorkspaceError(404).
      · path 가 없으면 초기 파일 전부 복원 + 초기에 없던 파일 전부 삭제.
    """
    if path is not None:
        p = normalize_path(path)
        if p not in initial:
            raise WorkspaceError(404, "시나리오가 처음 제공한 파일이 아니라 되돌릴 원본이 없습니다")
        return [p], []
    restore = sorted(initial.keys())
    remove = sorted(p for p in current_paths if p not in initial)
    return restore, remove


async def reset_files(
    db: AsyncSession,
    attempt_id: uuid.UUID,
    scenario_id: uuid.UUID,
    initial_files: list[dict],
    path: str | None,
    *,
    actor: str = "ide",
) -> dict:
    """파일 하나 또는 워크스페이스 전체를 초기 상태로. 커밋은 호출자가 한다."""
    initial = initial_file_map(initial_files)
    rows = await list_files(db, attempt_id, scenario_id)
    restore, remove = plan_reset(initial, [r.path for r in rows], path)

    removed = 0
    for r in rows:
        if r.path in remove:
            await db.delete(r)
            removed += 1
    if removed:
        await db.flush()

    restored = 0
    for p in restore:
        await save_file(db, attempt_id, scenario_id, p, initial[p], actor=actor, record_event=False)
        restored += 1

    scope = "file" if path is not None else "all"
    db.add(
        Event(
            attempt_id=attempt_id,
            scenario_id=scenario_id,
            type="file_reset",
            payload={
                "scope": scope,
                "path": restore[0] if scope == "file" else None,
                "restored": restored,
                "removed": removed,
                "actor": actor,
            },
        )
    )
    return {
        "scope": scope,
        "restored": restored,
        "removed": removed,
        "paths": restore,
        "content": initial[restore[0]] if scope == "file" else None,
    }

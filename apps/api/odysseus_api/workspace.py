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


def files_payload(rows: list[WorkspaceFile]) -> list[dict]:
    """러너 잡에 싣는 파일 목록."""
    return [{"path": r.path, "content": r.content} for r in rows]

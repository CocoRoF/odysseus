"""워크스페이스 파일 API — IDE·폴더 앱의 저장/조회 표면."""

import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from .. import workspace as ws
from ..db import get_db
from ..deps import get_current_user
from ..models import User
from ..schemas import FileContentOut, FileEntryOut, FileRenameIn, FileSaveIn
from .attempts import get_attempt_for, require_own_active, scenario_in_attempt

router = APIRouter(tags=["workspace"])



@router.get(
    "/attempts/{attempt_id}/scenarios/{scenario_id}/files",
    response_model=list[FileEntryOut],
)
async def list_files(
    attempt_id: uuid.UUID,
    scenario_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    attempt = await get_attempt_for(attempt_id, user, db)
    await scenario_in_attempt(attempt, scenario_id, db)
    rows = await ws.list_files(db, attempt_id, scenario_id)
    return [
        FileEntryOut(
            path=r.path,
            size=len(r.content.encode("utf-8", errors="ignore")),
            updated_at=r.updated_at,
        )
        for r in rows
    ]


@router.get(
    "/attempts/{attempt_id}/scenarios/{scenario_id}/files/content",
    response_model=FileContentOut,
)
async def get_content(
    attempt_id: uuid.UUID,
    scenario_id: uuid.UUID,
    path: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    attempt = await get_attempt_for(attempt_id, user, db)
    await scenario_in_attempt(attempt, scenario_id, db)
    try:
        norm = ws.normalize_path(path)
    except ws.WorkspaceError as e:
        raise HTTPException(e.code, e.message)
    row = await ws.get_file(db, attempt_id, scenario_id, norm)
    if not row:
        raise HTTPException(404, f"파일이 없습니다: {norm}")
    return FileContentOut(path=row.path, content=row.content, updated_at=row.updated_at)


@router.put(
    "/attempts/{attempt_id}/scenarios/{scenario_id}/files/content",
    response_model=FileContentOut,
)
async def save_content(
    attempt_id: uuid.UUID,
    scenario_id: uuid.UUID,
    body: FileSaveIn,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    attempt = await require_own_active(attempt_id, user, db)
    await scenario_in_attempt(attempt, scenario_id, db)
    try:
        row, _created = await ws.save_file(
            db, attempt_id, scenario_id, body.path, body.content, actor="ide"
        )
    except ws.WorkspaceError as e:
        raise HTTPException(e.code, e.message)
    await db.commit()
    await db.refresh(row)
    return FileContentOut(path=row.path, content=row.content, updated_at=row.updated_at)


@router.post("/attempts/{attempt_id}/scenarios/{scenario_id}/files/rename")
async def rename_file(
    attempt_id: uuid.UUID,
    scenario_id: uuid.UUID,
    body: FileRenameIn,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    attempt = await require_own_active(attempt_id, user, db)
    await scenario_in_attempt(attempt, scenario_id, db)
    try:
        from_path = ws.normalize_path(body.from_path)
        to_path = ws.normalize_path(body.to_path)
        row = await ws.get_file(db, attempt_id, scenario_id, from_path)
        if not row:
            raise HTTPException(404, f"파일이 없습니다: {from_path}")
        if await ws.get_file(db, attempt_id, scenario_id, to_path):
            raise HTTPException(409, f"대상 경로가 이미 존재합니다: {to_path}")
        content = row.content
        await ws.delete_file(db, attempt_id, scenario_id, from_path, actor="ide")
        await ws.save_file(db, attempt_id, scenario_id, to_path, content, actor="ide")
    except ws.WorkspaceError as e:
        raise HTTPException(e.code, e.message)
    await db.commit()
    return {"ok": True, "from": from_path, "to": to_path}


@router.delete("/attempts/{attempt_id}/scenarios/{scenario_id}/files")
async def remove_file(
    attempt_id: uuid.UUID,
    scenario_id: uuid.UUID,
    path: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    attempt = await require_own_active(attempt_id, user, db)
    await scenario_in_attempt(attempt, scenario_id, db)
    try:
        ok = await ws.delete_file(db, attempt_id, scenario_id, path, actor="ide")
    except ws.WorkspaceError as e:
        raise HTTPException(e.code, e.message)
    await db.commit()
    if not ok:
        raise HTTPException(404, "파일이 없습니다")
    return {"ok": True}

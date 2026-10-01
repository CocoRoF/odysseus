"""워크스페이스 파일 API — IDE·폴더 앱의 저장/조회 표면."""

import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from .. import workspace as ws
from ..db import get_db
from ..deps import get_current_user
from ..models import Attempt, Event, User
from ..schemas import (
    FileContentOut,
    FileEntryOut,
    FileRenameIn,
    FileResetIn,
    FileResetOut,
    FileSaveIn,
    InitialFileOut,
)
from ..desktop import normalize_actor
from .attempts import get_attempt_for, require_own_active, scenario_in_attempt

router = APIRouter(tags=["workspace"])


@router.get(
    "/attempts/{attempt_id}/scenarios/{scenario_id}/files/initial",
    response_model=list[InitialFileOut],
)
async def list_initial_files(
    attempt_id: uuid.UUID,
    scenario_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """시나리오가 처음 제공한 파일 목록 — 이 파일들만 초기 내용으로 되돌릴 수 있다.

    내용은 주지 않는다. 응시 시작 때 동결된 정의에서 읽으므로 시나리오를 나중에 고쳐도 변하지 않는다.
    """
    attempt = await get_attempt_for(attempt_id, user, db)
    scenario = await scenario_in_attempt(attempt, scenario_id, db, user)
    initial = ws.initial_file_map(scenario.initial_files or [])
    return [
        InitialFileOut(path=p, size=len(c.encode("utf-8", errors="ignore")))
        for p, c in sorted(initial.items())
    ]


@router.post(
    "/attempts/{attempt_id}/scenarios/{scenario_id}/files/reset",
    response_model=FileResetOut,
)
async def reset_files(
    attempt_id: uuid.UUID,
    scenario_id: uuid.UUID,
    body: FileResetIn,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """파일 하나(path) 또는 워크스페이스 전체(path 없음)를 초기 상태로 되돌린다.

    전체 초기화는 응시자가 만든 파일을 지운다 — 화면이 확인을 받고 부른다. 되돌리기는
    file_reset 이벤트로 남아 평가 타임라인에 보인다.
    """
    attempt = await require_own_active(attempt_id, user, db)
    scenario = await scenario_in_attempt(attempt, scenario_id, db, user, mutate=True)
    try:
        result = await ws.reset_files(
            db, attempt_id, scenario_id, scenario.initial_files or [], body.path, actor="ide"
        )
    except ws.WorkspaceError as e:
        raise HTTPException(e.code, e.message)
    await db.commit()
    return FileResetOut(**result)



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
    await scenario_in_attempt(attempt, scenario_id, db, user)
    rows = await ws.list_files(db, attempt_id, scenario_id)
    return [
        FileEntryOut(
            path=r.path,
            size=len(r.content.encode("utf-8", errors="ignore")),
            updated_at=r.updated_at,
            sha256=ws.content_sha256(r.content),
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
    app: str = "",
    quiet: bool = False,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    attempt = await get_attempt_for(attempt_id, user, db)
    await scenario_in_attempt(attempt, scenario_id, db, user)
    try:
        norm = ws.normalize_path(path)
    except ws.WorkspaceError as e:
        raise HTTPException(e.code, e.message)
    row = await ws.get_file(db, attempt_id, scenario_id, norm)
    if not row:
        raise HTTPException(404, f"파일이 없습니다: {norm}")
    # quiet — 메일 목록의 미리보기처럼 화면이 미리 읽어 두는 것. 사람이 연 것이 아니므로 열람이
    # 아니다. 응시자에게 불리해질 뿐인 표시라(기록이 줄어든다) 위조 유인은 없다.
    if not quiet:
        await _record_open(db, attempt, scenario_id, norm, app, user)
    return FileContentOut(
        path=row.path, content=row.content, updated_at=row.updated_at, sha256=ws.content_sha256(row.content)
    )


#: 같은 파일을 같은 앱으로 다시 읽어도 이 시간 안이면 한 번으로 본다
OPEN_DEDUPE_S = 120


async def _record_open(
    db: AsyncSession, attempt: Attempt, scenario_id: uuid.UUID, path: str, app: str, user: User
) -> None:
    """파일을 열어 봤다 — 서버가 직접 남긴다.

    무엇을 만들었는지는 파일에 남지만 **무엇을 읽고 판단했는지**는 아무 데도 남지 않았다. 규정을
    펴 보지도 않고 판정한 사람과, 세 번 되짚어 본 사람이 채점자에게 똑같아 보였다는 뜻이다.

    브라우저가 보고하게 하지 않는다. 파일을 달라고 한 것은 서버가 직접 받은 요청이므로, 그 사실은
    서버가 본 사실이다(ODY-017). 대신 같은 파일을 스크롤하며 여러 번 읽는 일이 흔해 잠깐 사이의
    같은 열람은 한 번으로 묶는다 — 기록이 시끄러우면 아무도 읽지 않는다.

    채점자가 볼 응시자의 행동만 남긴다. 스태프의 열람은 응시 기록이 아니다.
    """
    if attempt.user_id != user.id or attempt.status != "in_progress":
        return
    key = f"odysseus:open:{attempt.id}:{scenario_id}:{normalize_actor(app)}:{path}"
    try:
        from ..runqueue import get_redis

        if not await get_redis().set(key, "1", ex=OPEN_DEDUPE_S, nx=True):
            return
    except Exception:  # noqa: BLE001 — Redis 가 없으면 묶지 못할 뿐, 사실은 남긴다
        pass
    db.add(
        Event(
            attempt_id=attempt.id,
            scenario_id=scenario_id,
            type="file_open",
            source="server",
            payload={"path": path, "actor": normalize_actor(app)},
        )
    )
    await db.commit()


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
    await scenario_in_attempt(attempt, scenario_id, db, user, mutate=True)
    try:
        row, _created = await ws.save_file(
            db,
            attempt_id,
            scenario_id,
            body.path,
            body.content,
            actor=normalize_actor(body.app),
            base_sha256=body.base_sha256,
        )
    except ws.WorkspaceConflict as e:
        await db.rollback()
        # 편집기는 이 코드로 충돌을 알아보고 자동 저장을 멈춘 뒤 응시자에게 고르게 한다.
        raise HTTPException(
            409,
            {
                "code": "FILE_DELETED" if e.current_sha256 is None else "FILE_CHANGED",
                "message": e.message,
                "sha256": e.current_sha256,
            },
        )
    except ws.WorkspaceError as e:
        raise HTTPException(e.code, e.message)
    await db.commit()
    await db.refresh(row)
    return FileContentOut(
        path=row.path, content=row.content, updated_at=row.updated_at, sha256=ws.content_sha256(row.content)
    )


@router.post("/attempts/{attempt_id}/scenarios/{scenario_id}/files/rename")
async def rename_file(
    attempt_id: uuid.UUID,
    scenario_id: uuid.UUID,
    body: FileRenameIn,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """파일 또는 폴더 이름 변경/이동 (폴더는 하위 전체가 함께 이동)."""
    attempt = await require_own_active(attempt_id, user, db)
    await scenario_in_attempt(attempt, scenario_id, db, user, mutate=True)
    try:
        moved = await ws.move_path(db, attempt_id, scenario_id, body.from_path, body.to_path, actor=normalize_actor(body.app))
    except ws.WorkspaceError as e:
        raise HTTPException(e.code, e.message)
    await db.commit()
    return {"ok": True, "from": body.from_path, "to": body.to_path, "moved": moved}


@router.post("/attempts/{attempt_id}/scenarios/{scenario_id}/files/copy")
async def copy_file(
    attempt_id: uuid.UUID,
    scenario_id: uuid.UUID,
    body: FileRenameIn,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """파일 또는 폴더 복사 (폴더는 하위 전체 복사)."""
    attempt = await require_own_active(attempt_id, user, db)
    await scenario_in_attempt(attempt, scenario_id, db, user, mutate=True)
    try:
        copied = await ws.copy_path(db, attempt_id, scenario_id, body.from_path, body.to_path, actor=normalize_actor(body.app))
    except ws.WorkspaceError as e:
        raise HTTPException(e.code, e.message)
    await db.commit()
    return {"ok": True, "from": body.from_path, "to": body.to_path, "copied": copied}


@router.delete("/attempts/{attempt_id}/scenarios/{scenario_id}/files")
async def remove_file(
    attempt_id: uuid.UUID,
    scenario_id: uuid.UUID,
    path: str,
    app: str = "",
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    attempt = await require_own_active(attempt_id, user, db)
    await scenario_in_attempt(attempt, scenario_id, db, user, mutate=True)
    try:
        removed = await ws.delete_path(db, attempt_id, scenario_id, path, actor=normalize_actor(app))
    except ws.WorkspaceError as e:
        raise HTTPException(e.code, e.message)
    await db.commit()
    if not removed:
        raise HTTPException(404, "파일이 없습니다")
    return {"ok": True, "removed": removed}

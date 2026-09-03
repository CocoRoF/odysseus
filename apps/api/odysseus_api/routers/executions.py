"""실행 — IDE 터미널의 명령 실행 요청/조회."""

import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import workspace as ws
from ..config import settings
from ..db import get_db
from ..deps import get_current_user
from ..models import Event, Execution, User
from ..runqueue import enqueue_run
from ..schemas import ExecutionOut, RunIn
from .attempts import get_attempt_for, require_own_active, scenario_in_attempt

router = APIRouter(tags=["executions"])


@router.post(
    "/attempts/{attempt_id}/scenarios/{scenario_id}/run", response_model=ExecutionOut
)
async def run_command(
    attempt_id: uuid.UUID,
    scenario_id: uuid.UUID,
    body: RunIn,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    attempt = await require_own_active(attempt_id, user, db)
    await scenario_in_attempt(attempt, scenario_id, db, user, mutate=True)
    command = body.command.strip()
    if len(command) > settings.run_command_max_len:
        raise HTTPException(400, "명령이 너무 깁니다")

    execution = Execution(
        attempt_id=attempt_id,
        scenario_id=scenario_id,
        user_id=user.id,
        source="ide",
        command=command,
    )
    db.add(execution)
    db.add(
        Event(
            attempt_id=attempt_id,
            scenario_id=scenario_id,
            type="run_request",
            payload={"command": command[:200], "actor": "ide"},
        )
    )
    await db.commit()
    await db.refresh(execution)

    rows = await ws.list_files(db, attempt_id, scenario_id)
    await enqueue_run(
        str(execution.id),
        command,
        ws.files_payload(rows),
        settings.run_timeout_s,
        attempt_id=str(execution.attempt_id),
        scenario_id=str(execution.scenario_id),
        source=execution.source,
    )
    return execution


@router.get("/executions/{execution_id}", response_model=ExecutionOut)
async def get_execution(
    execution_id: uuid.UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    execution = await db.get(Execution, execution_id, populate_existing=True)
    if not execution:
        raise HTTPException(404, "실행을 찾을 수 없습니다")
    await get_attempt_for(execution.attempt_id, user, db)  # 소유/스태프 검증
    return execution


@router.get(
    "/attempts/{attempt_id}/scenarios/{scenario_id}/executions",
    response_model=list[ExecutionOut],
)
async def list_executions(
    attempt_id: uuid.UUID,
    scenario_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    attempt = await get_attempt_for(attempt_id, user, db)
    await scenario_in_attempt(attempt, scenario_id, db, user)
    return (
        await db.execute(
            select(Execution)
            .where(Execution.attempt_id == attempt_id, Execution.scenario_id == scenario_id)
            .order_by(Execution.created_at)
        )
    ).scalars().all()

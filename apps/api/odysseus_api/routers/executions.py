"""실행 — IDE 터미널의 명령 실행 요청/조회."""

import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import defer
from sqlalchemy.ext.asyncio import AsyncSession

from .. import workspace as ws
from ..commands import validate_command
from ..config import settings
from ..db import get_db
from ..definitions import run_timeout_for
from ..deps import get_current_user
from ..models import Attempt, Event, Execution, User
from ..ratelimit import enforce
from ..runqueue import enqueue_run, new_callback_token
from ..schemas import ExecutionOut, RunIn
from .attempts import get_attempt_for, require_app, require_own_active, scenario_in_attempt

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
    scenario = await scenario_in_attempt(attempt, scenario_id, db, user, mutate=True)
    # 터미널도 IDE 도 주지 않은 시나리오라면 명령을 돌릴 수단이 없었어야 한다. 화면에서 아이콘만
    # 감추면 콘솔로 이 API 를 부를 수 있고, 그러면 "문서와 표만으로 일했다" 는 채점의 전제가 깨진다.
    require_app(scenario, "terminal", "ide")
    # 제한 시간은 응시 시작 시점에 동결된 시나리오 값을 따른다 — 출제자가 나중에 고쳐도
    # 진행 중인 응시의 실행 조건은 바뀌지 않는다.
    timeout_s = run_timeout_for(scenario)
    command = validate_command(body.command, settings.run_command_max_len)
    enforce(f"run:{attempt_id}", per_min=30, burst=10, what="실행 요청")

    await db.execute(select(Attempt).where(Attempt.id == attempt_id).with_for_update())
    open_count = (
        await db.execute(
            select(func.count(Execution.id)).where(
                Execution.attempt_id == attempt_id, Execution.status.in_(("queued", "running"))
            )
        )
    ).scalar() or 0
    if open_count >= settings.run_max_concurrent_per_attempt:
        await db.rollback()
        raise HTTPException(
            429,
            f"실행 중인 명령이 이미 {open_count}개 있습니다. 끝나기를 기다리거나 Ctrl+C 로 중단하세요",
            headers={"Retry-After": "2"},
        )

    # Persist exactly what this command is supposed to see before committing the durable Execution.
    # A Redis outage/restart can then replay this identical input instead of a later workspace state.
    rows = await ws.list_files(db, attempt_id, scenario_id)
    input_files = ws.files_payload(rows)
    execution = Execution(
        attempt_id=attempt_id,
        scenario_id=scenario_id,
        user_id=user.id,
        source="ide",
        command=command,
        input_files=input_files,
        callback_token=new_callback_token(),
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

    try:
        delivered = await enqueue_run(
            str(execution.id),
            command,
            execution.input_files or [],
            timeout_s,
            attempt_id=str(execution.attempt_id),
            scenario_id=str(execution.scenario_id),
            source=execution.source,
            callback_token=execution.callback_token or "",
        )
        if not delivered:
            db.add(
                Event(
                    attempt_id=attempt_id,
                    scenario_id=scenario_id,
                    type="run_enqueue_delayed",
                    payload={"execution_id": str(execution.id), "reason": "redis_unavailable_or_already_pending"},
                )
            )
            await db.commit()
    except Exception as exc:
        # Programming/serialization errors still surface in telemetry while leaving the durable row for
        # the reconciler. Transient Redis errors are normally converted to delivered=False in runqueue.
        db.add(
            Event(
                attempt_id=attempt_id,
                scenario_id=scenario_id,
                type="run_enqueue_delayed",
                payload={"execution_id": str(execution.id), "error_type": type(exc).__name__},
            )
        )
        await db.commit()
    return execution


@router.get("/executions/{execution_id}", response_model=ExecutionOut)
async def get_execution(
    execution_id: uuid.UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    execution = (
        await db.execute(
            select(Execution).options(defer(Execution.input_files)).where(Execution.id == execution_id)
        )
    ).scalar_one_or_none()
    if not execution:
        raise HTTPException(404, "실행을 찾을 수 없습니다")
    await get_attempt_for(execution.attempt_id, user, db)
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
            .options(defer(Execution.input_files))
            .where(Execution.attempt_id == attempt_id, Execution.scenario_id == scenario_id)
            .order_by(Execution.created_at)
        )
    ).scalars().all()

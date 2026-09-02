"""응시 생명주기 — 시작(워크스페이스 물질화 + 오프닝 메시지), 상태, 행동 이벤트, 종료, 재응시."""

import uuid
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from ..config import settings
from ..db import get_db
from ..deps import get_current_user
from ..models import (
    Assessment,
    AssessmentScenario,
    Assignment,
    Attempt,
    Event,
    MessengerMessage,
    Scenario,
    User,
    WorkspaceFile,
    utcnow,
)
from ..schemas import AttemptOut, AttemptScenarioOut, EventBatchIn, MyAssignmentOut

router = APIRouter(tags=["attempts"])

# 마감 후에도 이벤트 플러시가 도착할 수 있는 유예 시간
DEADLINE_GRACE = timedelta(seconds=45)

# 응시 클라이언트가 기록할 수 있는 행동 이벤트 화이트리스트
ALLOWED_EVENT_TYPES = {
    "focus_lost",
    "focus_gained",
    "tab_hidden",
    "tab_visible",
    "window_blur",
    "window_focus",
    "paste",
    "copy",
    "cut",
    "app_open",
    "app_close",
    "file_open",
    "page_enter",
    "page_exit",
    "net_offline",
    "net_online",
}


async def check_expired(attempt: Attempt, db: AsyncSession) -> Attempt:
    if attempt.status == "in_progress" and utcnow() > attempt.deadline_at + DEADLINE_GRACE:
        attempt.status = "expired"
        attempt.submitted_at = attempt.deadline_at
        db.add(Event(attempt_id=attempt.id, type="attempt_expired", payload={}))
        await db.commit()
    return attempt


async def get_attempt_for(attempt_id: uuid.UUID, user: User, db: AsyncSession) -> Attempt:
    attempt = await db.get(Attempt, attempt_id)
    if not attempt:
        raise HTTPException(404, "응시 정보를 찾을 수 없습니다")
    if user.role == "candidate" and attempt.user_id != user.id:
        raise HTTPException(403, "본인의 응시만 볼 수 있습니다")
    return await check_expired(attempt, db)


async def require_own_active(attempt_id: uuid.UUID, user: User, db: AsyncSession) -> Attempt:
    """본인 소유 + 진행중 응시 — 데스크톱 조작 계열 엔드포인트 공통 가드."""
    attempt = await get_attempt_for(attempt_id, user, db)
    if attempt.user_id != user.id:
        raise HTTPException(403, "본인의 응시에서만 사용할 수 있습니다")
    if attempt.status != "in_progress":
        raise HTTPException(400, "이미 종료된 시험입니다")
    return attempt


async def scenario_in_attempt(
    attempt: Attempt, scenario_id: uuid.UUID, db: AsyncSession
) -> Scenario:
    link = (
        await db.execute(
            select(AssessmentScenario).where(
                AssessmentScenario.assessment_id == attempt.assessment_id,
                AssessmentScenario.scenario_id == scenario_id,
            )
        )
    ).scalar_one_or_none()
    if not link:
        raise HTTPException(404, "이 시험에 포함되지 않은 시나리오입니다")
    scenario = await db.get(Scenario, scenario_id)
    if not scenario:
        raise HTTPException(404, "시나리오를 찾을 수 없습니다")
    return scenario


async def _attempt_out(attempt: Attempt, db: AsyncSession) -> AttemptOut:
    assessment = await db.get(Assessment, attempt.assessment_id)
    links = (
        await db.execute(
            select(AssessmentScenario)
            .where(AssessmentScenario.assessment_id == attempt.assessment_id)
            .options(selectinload(AssessmentScenario.scenario))
            .order_by(AssessmentScenario.ordinal)
        )
    ).scalars().all()
    scenarios = [
        AttemptScenarioOut(
            scenario_id=link.scenario_id,
            title=link.scenario.title,
            briefing_md=link.scenario.briefing_md,
            ordinal=link.ordinal,
            points=link.points,
            agent_enabled=link.scenario.agent_enabled,
            characters=[
                {
                    "key": c.get("key"),
                    "name": c.get("name"),
                    "role": c.get("role", ""),
                    "color": c.get("color", "#6366f1"),
                }
                for c in (link.scenario.characters or [])
            ],
        )
        for link in links
    ]
    return AttemptOut(
        id=attempt.id,
        assessment_id=attempt.assessment_id,
        assessment_title=assessment.title,
        status=attempt.status,
        started_at=attempt.started_at,
        deadline_at=attempt.deadline_at,
        submitted_at=attempt.submitted_at,
        agent_max_turns=assessment.agent_max_turns,
        scenarios=scenarios,
    )


@router.get("/my/assignments", response_model=list[MyAssignmentOut])
async def my_assignments(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    is_staff = user.role in ("admin", "evaluator")
    assigned_ids: set[uuid.UUID] = {
        r
        for r in (
            await db.execute(select(Assignment.assessment_id).where(Assignment.user_id == user.id))
        ).scalars()
    }
    if is_staff:
        assessments = (
            await db.execute(
                select(Assessment)
                .options(selectinload(Assessment.scenarios))
                .order_by(Assessment.created_at.desc())
            )
        ).scalars().all()
    else:
        assessments = [
            asg.assessment
            for asg in (
                await db.execute(
                    select(Assignment)
                    .where(Assignment.user_id == user.id)
                    .options(selectinload(Assignment.assessment).selectinload(Assessment.scenarios))
                    .order_by(Assignment.created_at.desc())
                )
            ).scalars()
        ]

    attempts = (
        await db.execute(select(Attempt).where(Attempt.user_id == user.id).order_by(Attempt.started_at))
    ).scalars().all()
    for at in attempts:
        await check_expired(at, db)
    attempt_by_assessment = {at.assessment_id: at for at in attempts if not at.superseded}
    return [
        MyAssignmentOut(
            assessment_id=a.id,
            title=a.title,
            description=a.description,
            duration_min=a.duration_min,
            scenario_count=len(a.scenarios),
            starts_at=a.starts_at,
            ends_at=a.ends_at,
            attempt_id=(attempt_by_assessment.get(a.id).id if attempt_by_assessment.get(a.id) else None),
            attempt_status=(
                attempt_by_assessment.get(a.id).status if attempt_by_assessment.get(a.id) else None
            ),
            assigned=a.id in assigned_ids,
        )
        for a in assessments
    ]


async def _materialize(attempt: Attempt, db: AsyncSession) -> None:
    """시작 시점: 시나리오별 초기 파일 + 오프닝 메신저 메시지 생성."""
    links = (
        await db.execute(
            select(AssessmentScenario)
            .where(AssessmentScenario.assessment_id == attempt.assessment_id)
            .options(selectinload(AssessmentScenario.scenario))
            .order_by(AssessmentScenario.ordinal)
        )
    ).scalars().all()
    for link in links:
        scenario = link.scenario
        for f in scenario.initial_files or []:
            db.add(
                WorkspaceFile(
                    attempt_id=attempt.id,
                    scenario_id=scenario.id,
                    path=str(f.get("path", "")),
                    content=str(f.get("content", "")),
                )
            )
        for om in scenario.opening_messages or []:
            db.add(
                MessengerMessage(
                    attempt_id=attempt.id,
                    scenario_id=scenario.id,
                    character_key=str(om.get("character_key", "")),
                    sender="npc",
                    content=str(om.get("content", "")),
                    meta={"opening": True},
                )
            )


@router.post("/assessments/{assessment_id}/attempts", response_model=AttemptOut)
async def start_attempt(
    assessment_id: uuid.UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    assignment = (
        await db.execute(
            select(Assignment).where(
                Assignment.assessment_id == assessment_id, Assignment.user_id == user.id
            )
        )
    ).scalar_one_or_none()
    if not assignment and user.role not in ("admin", "evaluator"):
        raise HTTPException(403, "이 시험에 배정되지 않았습니다")

    assessment = await db.get(Assessment, assessment_id)
    if not assessment:
        raise HTTPException(404, "시험을 찾을 수 없습니다")
    now = utcnow()
    if assessment.starts_at and now < assessment.starts_at:
        raise HTTPException(400, "아직 시험 시작 시간이 아닙니다")
    if assessment.ends_at and now > assessment.ends_at:
        raise HTTPException(400, "시험 응시 기간이 종료되었습니다")

    existing = (
        await db.execute(
            select(Attempt)
            .where(
                Attempt.assessment_id == assessment_id,
                Attempt.user_id == user.id,
                Attempt.superseded.is_(False),
            )
            .order_by(Attempt.started_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    if existing:
        await check_expired(existing, db)
        if existing.status != "in_progress":
            raise HTTPException(400, "이미 종료된 시험입니다")
        return await _attempt_out(existing, db)

    deadline = now + timedelta(minutes=assessment.duration_min)
    if assessment.ends_at and deadline > assessment.ends_at:
        deadline = assessment.ends_at
    attempt = Attempt(assessment_id=assessment_id, user_id=user.id, started_at=now, deadline_at=deadline)
    db.add(attempt)
    await db.flush()
    await _materialize(attempt, db)
    db.add(
        Event(
            attempt_id=attempt.id,
            type="attempt_started",
            payload={"assessment_id": str(assessment_id), "deadline_at": deadline.isoformat()},
        )
    )
    await db.commit()
    return await _attempt_out(attempt, db)


@router.get("/attempts/{attempt_id}", response_model=AttemptOut)
async def get_attempt(
    attempt_id: uuid.UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    attempt = await get_attempt_for(attempt_id, user, db)
    return await _attempt_out(attempt, db)


@router.post("/attempts/{attempt_id}/events")
async def post_events(
    attempt_id: uuid.UUID,
    body: EventBatchIn,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    attempt = await get_attempt_for(attempt_id, user, db)
    if attempt.user_id != user.id:
        raise HTTPException(403, "본인의 응시에만 기록할 수 있습니다")
    if attempt.status != "in_progress":
        return {"ok": True, "recorded": 0}
    events = [e for e in body.events[: settings.max_event_batch] if e.type in ALLOWED_EVENT_TYPES]
    for ev in events:
        db.add(
            Event(attempt_id=attempt.id, scenario_id=ev.scenario_id, type=ev.type, payload=ev.payload)
        )
    await db.commit()
    return {"ok": True, "recorded": len(events)}


@router.post("/attempts/{attempt_id}/finish", response_model=AttemptOut)
async def finish_attempt(
    attempt_id: uuid.UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    attempt = await get_attempt_for(attempt_id, user, db)
    if attempt.user_id != user.id:
        raise HTTPException(403, "본인의 응시만 종료할 수 있습니다")
    if attempt.status == "in_progress":
        attempt.status = "submitted"
        attempt.submitted_at = utcnow()
        db.add(Event(attempt_id=attempt.id, type="attempt_submitted", payload={}))
        await db.commit()
    return await _attempt_out(attempt, db)


@router.post("/attempts/{attempt_id}/retake", response_model=AttemptOut)
async def retake_attempt(
    attempt_id: uuid.UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    """재응시 — 이전 기록을 superseded로 보존한 채 새 시도를 시작 (스태프는 본인/타인, 응시자는 불가)."""
    attempt = await db.get(Attempt, attempt_id)
    if not attempt:
        raise HTTPException(404, "응시 정보를 찾을 수 없습니다")
    if user.role == "candidate":
        raise HTTPException(403, "재응시는 관리자가 허용해야 합니다")
    if user.role == "evaluator" and attempt.user_id != user.id:
        raise HTTPException(403, "평가자는 본인 체험 응시만 재응시할 수 있습니다")

    attempt.superseded = True
    db.add(Event(attempt_id=attempt.id, type="attempt_superseded", payload={"by": str(user.id)}))
    await db.commit()

    assessment = await db.get(Assessment, attempt.assessment_id)
    now = utcnow()
    deadline = now + timedelta(minutes=assessment.duration_min)
    new_attempt = Attempt(
        assessment_id=attempt.assessment_id, user_id=attempt.user_id, started_at=now, deadline_at=deadline
    )
    db.add(new_attempt)
    await db.flush()
    await _materialize(new_attempt, db)
    db.add(
        Event(attempt_id=new_attempt.id, type="attempt_started", payload={"retake_of": str(attempt.id)})
    )
    await db.commit()
    return await _attempt_out(new_attempt, db)


@router.delete("/attempts/{attempt_id}")
async def delete_attempt(
    attempt_id: uuid.UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    """응시 기록 완전 삭제 — admin 전용 (데모/정리용)."""
    if user.role != "admin":
        raise HTTPException(403, "관리자만 삭제할 수 있습니다")
    attempt = await db.get(Attempt, attempt_id)
    if not attempt:
        raise HTTPException(404, "응시 정보를 찾을 수 없습니다")
    await db.delete(attempt)
    await db.commit()
    return {"ok": True}

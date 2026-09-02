"""시험(assessment) CRUD — 시나리오 N개 + 응시자 배정."""

import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from ..db import get_db
from ..deps import require_admin, require_staff
from ..models import (
    AiProvider,
    Assessment,
    AssessmentScenario,
    Assignment,
    Attempt,
    Scenario,
    User,
)
from ..schemas import (
    AssessmentIn,
    AssessmentOut,
    AssessmentScenarioOut,
    AssessmentSummary,
    AssignmentOut,
)

router = APIRouter(prefix="/assessments", tags=["assessments"])


async def _load(assessment_id: uuid.UUID, db: AsyncSession) -> Assessment:
    row = (
        await db.execute(
            select(Assessment)
            .where(Assessment.id == assessment_id)
            .options(
                selectinload(Assessment.scenarios).selectinload(AssessmentScenario.scenario),
                selectinload(Assessment.assignments).selectinload(Assignment.user),
            )
        )
    ).scalar_one_or_none()
    if not row:
        raise HTTPException(404, "시험을 찾을 수 없습니다")
    return row


def _to_out(a: Assessment) -> AssessmentOut:
    return AssessmentOut(
        id=a.id,
        title=a.title,
        description=a.description,
        duration_min=a.duration_min,
        agent_max_turns=a.agent_max_turns,
        npc_provider_id=a.npc_provider_id,
        agent_provider_id=a.agent_provider_id,
        starts_at=a.starts_at,
        ends_at=a.ends_at,
        created_at=a.created_at,
        scenarios=[
            AssessmentScenarioOut(
                scenario_id=link.scenario_id,
                title=link.scenario.title,
                difficulty=link.scenario.difficulty,
                ordinal=link.ordinal,
                points=link.points,
            )
            for link in a.scenarios
        ],
        assignments=[
            AssignmentOut(user_id=asg.user_id, name=asg.user.name, email=asg.user.email)
            for asg in a.assignments
        ],
    )


async def _validate_providers(body: AssessmentIn, db: AsyncSession) -> None:
    for pid in (body.npc_provider_id, body.agent_provider_id):
        if pid and not await db.get(AiProvider, pid):
            raise HTTPException(400, "존재하지 않는 LLM 공급자입니다")


async def _apply_relations(row: Assessment, body: AssessmentIn, db: AsyncSession) -> None:
    for link in body.scenarios:
        if not await db.get(Scenario, link.scenario_id):
            raise HTTPException(400, f"존재하지 않는 시나리오: {link.scenario_id}")
    row.scenarios.clear()
    row.assignments.clear()
    await db.flush()  # clear 후 재추가 시 유니크 위반 방지
    for i, link in enumerate(body.scenarios):
        row.scenarios.append(
            AssessmentScenario(scenario_id=link.scenario_id, ordinal=i, points=link.points)
        )
    seen: set[uuid.UUID] = set()
    for user_id in body.assignee_ids:
        if user_id in seen:
            continue
        seen.add(user_id)
        if not await db.get(User, user_id):
            raise HTTPException(400, f"존재하지 않는 사용자: {user_id}")
        row.assignments.append(Assignment(user_id=user_id))


@router.get("", response_model=list[AssessmentSummary])
async def list_assessments(db: AsyncSession = Depends(get_db), _=Depends(require_staff)):
    rows = (
        await db.execute(
            select(Assessment)
            .options(selectinload(Assessment.scenarios), selectinload(Assessment.assignments))
            .order_by(Assessment.created_at.desc())
        )
    ).scalars().all()
    counts = dict(
        (
            await db.execute(
                select(Attempt.assessment_id, func.count(Attempt.id)).group_by(Attempt.assessment_id)
            )
        ).all()
    )
    return [
        AssessmentSummary(
            id=a.id,
            title=a.title,
            duration_min=a.duration_min,
            scenario_count=len(a.scenarios),
            assignee_count=len(a.assignments),
            attempt_count=int(counts.get(a.id, 0)),
            created_at=a.created_at,
        )
        for a in rows
    ]


@router.post("", response_model=AssessmentOut)
async def create_assessment(
    body: AssessmentIn, db: AsyncSession = Depends(get_db), user: User = Depends(require_admin)
):
    await _validate_providers(body, db)
    row = Assessment(
        title=body.title,
        description=body.description,
        duration_min=body.duration_min,
        agent_max_turns=body.agent_max_turns,
        npc_provider_id=body.npc_provider_id,
        agent_provider_id=body.agent_provider_id,
        starts_at=body.starts_at,
        ends_at=body.ends_at,
        created_by=user.id,
        scenarios=[],
        assignments=[],
    )
    db.add(row)
    await db.flush()
    await _apply_relations(row, body, db)
    await db.commit()
    return _to_out(await _load(row.id, db))


@router.get("/{assessment_id}", response_model=AssessmentOut)
async def get_assessment(assessment_id: uuid.UUID, db: AsyncSession = Depends(get_db), _=Depends(require_staff)):
    return _to_out(await _load(assessment_id, db))


@router.put("/{assessment_id}", response_model=AssessmentOut)
async def update_assessment(
    assessment_id: uuid.UUID, body: AssessmentIn, db: AsyncSession = Depends(get_db), _=Depends(require_admin)
):
    row = await _load(assessment_id, db)
    await _validate_providers(body, db)
    row.title = body.title
    row.description = body.description
    row.duration_min = body.duration_min
    row.agent_max_turns = body.agent_max_turns
    row.npc_provider_id = body.npc_provider_id
    row.agent_provider_id = body.agent_provider_id
    row.starts_at = body.starts_at
    row.ends_at = body.ends_at
    await _apply_relations(row, body, db)
    await db.commit()
    return _to_out(await _load(assessment_id, db))


@router.delete("/{assessment_id}")
async def delete_assessment(assessment_id: uuid.UUID, db: AsyncSession = Depends(get_db), _=Depends(require_admin)):
    row = await db.get(Assessment, assessment_id)
    if not row:
        raise HTTPException(404, "시험을 찾을 수 없습니다")
    await db.delete(row)
    await db.commit()
    return {"ok": True}

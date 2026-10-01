"""시험(assessment) CRUD — 시나리오 N개 + 응시자 배정.

Assessment/Scenario 행은 최신 authoring state다. 실제 응시는 시작 시 definition snapshot을
고정하므로, 이미 사용된 시험도 다음 응시를 위해 수정할 수 있다. 단, Attempt의 FK와 감사
기록을 보존하기 위해 응시가 존재하는 Assessment 자체의 삭제는 금지한다.
"""

import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from ..db import get_db
from ..demo import mask_email_for
from ..deps import require_admin, require_staff
from ..models import (
    AiProvider,
    Assessment,
    AssessmentScenario,
    Assignment,
    Attempt,
    OfficePreset,
    Scenario,
    User,
)
from ..office import MAX_SCENARIOS_PER_ASSESSMENT, parse_ref
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


async def _attempt_count(assessment_id: uuid.UUID, db: AsyncSession) -> int:
    return int(
        (
            await db.execute(
                select(func.count(Attempt.id)).where(Attempt.assessment_id == assessment_id)
            )
        ).scalar()
        or 0
    )


def _to_out(a: Assessment, viewer=None) -> AssessmentOut:
    return AssessmentOut(
        id=a.id,
        title=a.title,
        description=a.description,
        category=a.category,
        label=a.label,
        office_preset=a.office_preset or "",
        duration_min=a.duration_min,
        agent_max_turns=a.agent_max_turns,
        messenger_max_per_attempt=a.messenger_max_per_attempt,
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
            AssignmentOut(user_id=asg.user_id, name=asg.user.name, email=mask_email_for(viewer, asg.user.email))
            for asg in a.assignments
        ],
    )


async def _validate_providers(body: AssessmentIn, db: AsyncSession) -> None:
    for pid in (body.npc_provider_id, body.agent_provider_id):
        if pid and not await db.get(AiProvider, pid):
            raise HTTPException(400, "존재하지 않는 LLM 공급자입니다")
    # 사무실 장면 — 프리셋을 가리키면 그 프리셋이 있어야 한다(모양은 스키마가 이미 봤다)
    kind, value = parse_ref(body.office_preset)
    if kind == "custom" and not await db.get(OfficePreset, uuid.UUID(value)):
        raise HTTPException(400, "존재하지 않는 사무실 프리셋입니다")


async def _apply_relations(row: Assessment, body: AssessmentIn, db: AsyncSession) -> None:
    # 보관된 시나리오는 새로 연결할 수 없지만, 이미 이 시험에 들어 있는 것은 유지한다 —
    # 그렇지 않으면 시나리오 하나가 보관되는 순간 배정 변경 같은 편집이 전부 400 이 된다.
    already = {link.scenario_id for link in row.scenarios}
    # 시나리오 수 상한 — 한 방에 사람이 너무 많이 서지 않게. 예전에 만들어 둔 시험이 상한을 넘겨 있으면 그대로 저장할 수는
    # 있지만(편집이 통째로 막히면 운영이 멈춘다) **더 넣지는 못한다** — 보관된 시나리오를 다루는 규칙과 같은 결이다.
    if len(body.scenarios) > MAX_SCENARIOS_PER_ASSESSMENT:
        adding = [link.scenario_id for link in body.scenarios if link.scenario_id not in already]
        if adding or len(body.scenarios) > len(already):
            raise HTTPException(
                400,
                f"시험 하나에는 시나리오를 {MAX_SCENARIOS_PER_ASSESSMENT}개까지 넣을 수 있습니다"
                f" (지금 {len(body.scenarios)}개). 사무실 방에 서는 사람이 너무 많아집니다.",
            )
    for link in body.scenarios:
        scenario = await db.get(Scenario, link.scenario_id)
        if not scenario or (scenario.is_archived and link.scenario_id not in already):
            raise HTTPException(400, f"존재하지 않거나 보관된 시나리오: {link.scenario_id}")
    row.scenarios.clear()
    row.assignments.clear()
    await db.flush()
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
            category=a.category,
            label=a.label,
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
        category=body.category,
        label=body.label.strip(),
        office_preset=body.office_preset,
        duration_min=body.duration_min,
        agent_max_turns=body.agent_max_turns,
        messenger_max_per_attempt=body.messenger_max_per_attempt,
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
async def get_assessment(assessment_id: uuid.UUID, db: AsyncSession = Depends(get_db), viewer=Depends(require_staff)):
    return _to_out(await _load(assessment_id, db), viewer)


@router.put("/{assessment_id}", response_model=AssessmentOut)
async def update_assessment(
    assessment_id: uuid.UUID, body: AssessmentIn, db: AsyncSession = Depends(get_db), _=Depends(require_admin)
):
    row = await _load(assessment_id, db)
    await _validate_providers(body, db)
    row.title = body.title
    row.description = body.description
    row.category = body.category
    row.label = body.label.strip()
    row.office_preset = body.office_preset
    row.duration_min = body.duration_min
    row.agent_max_turns = body.agent_max_turns
    row.messenger_max_per_attempt = body.messenger_max_per_attempt
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
    attempts = await _attempt_count(assessment_id, db)
    if attempts:
        raise HTTPException(
            409,
            f"응시 기록 {attempts}건이 있어 시험을 삭제할 수 없습니다. 기록 보존을 위해 시험은 유지하세요",
        )
    await db.delete(row)
    await db.commit()
    return {"ok": True}

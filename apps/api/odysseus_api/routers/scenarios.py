"""시나리오 CRUD — 관리자 스튜디오의 저장 대상."""

import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..ai.autoeval import default_rubric
from ..db import get_db
from ..deps import require_admin, require_staff
from ..models import AssessmentScenario, Scenario, User
from ..schemas import ScenarioIn, ScenarioOut, ScenarioSummary

router = APIRouter(prefix="/scenarios", tags=["scenarios"])


def _validate(body: ScenarioIn) -> None:
    keys = [c.key for c in body.characters]
    if len(keys) != len(set(keys)):
        raise HTTPException(400, "등장인물 key가 중복됩니다")
    key_set = set(keys)
    for om in body.opening_messages:
        if om.character_key not in key_set:
            raise HTTPException(400, f"오프닝 메시지의 등장인물이 없습니다: {om.character_key}")
    paths = [f.path for f in body.initial_files]
    if len(paths) != len(set(paths)):
        raise HTTPException(400, "초기 파일 경로가 중복됩니다")
    for c in body.checks:
        if c.type in ("file_exists", "file_contains") and not (c.path or "").strip():
            raise HTTPException(400, f"체크 '{c.label}': path가 필요합니다")
        if c.type == "file_contains" and not (c.pattern or "").strip():
            raise HTTPException(400, f"체크 '{c.label}': pattern이 필요합니다")
        if c.type == "command" and not (c.command or "").strip():
            raise HTTPException(400, f"체크 '{c.label}': command가 필요합니다")


def _apply(row: Scenario, body: ScenarioIn) -> None:
    row.title = body.title
    row.summary = body.summary
    row.difficulty = body.difficulty
    row.briefing_md = body.briefing_md
    row.characters = [c.model_dump() for c in body.characters]
    row.opening_messages = [m.model_dump() for m in body.opening_messages]
    row.initial_files = [f.model_dump() for f in body.initial_files]
    row.objectives_md = body.objectives_md
    row.checks = [c.model_dump() for c in body.checks]
    row.rubric = body.rubric or default_rubric()
    row.agent_enabled = body.agent_enabled


@router.get("", response_model=list[ScenarioSummary])
async def list_scenarios(db: AsyncSession = Depends(get_db), _=Depends(require_staff)):
    rows = (
        await db.execute(select(Scenario).order_by(Scenario.updated_at.desc()))
    ).scalars().all()
    return [
        ScenarioSummary(
            id=r.id,
            title=r.title,
            summary=r.summary,
            difficulty=r.difficulty,
            character_count=len(r.characters or []),
            check_count=len(r.checks or []),
            agent_enabled=r.agent_enabled,
            is_archived=r.is_archived,
            updated_at=r.updated_at,
        )
        for r in rows
    ]


@router.get("/rubric-default")
async def rubric_default(_=Depends(require_staff)):
    return default_rubric()


@router.post("", response_model=ScenarioOut)
async def create_scenario(
    body: ScenarioIn, db: AsyncSession = Depends(get_db), user: User = Depends(require_admin)
):
    _validate(body)
    row = Scenario(created_by=user.id)
    _apply(row, body)
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row


@router.get("/{scenario_id}", response_model=ScenarioOut)
async def get_scenario(scenario_id: uuid.UUID, db: AsyncSession = Depends(get_db), _=Depends(require_staff)):
    row = await db.get(Scenario, scenario_id)
    if not row:
        raise HTTPException(404, "시나리오를 찾을 수 없습니다")
    return row


@router.put("/{scenario_id}", response_model=ScenarioOut)
async def update_scenario(
    scenario_id: uuid.UUID, body: ScenarioIn, db: AsyncSession = Depends(get_db), _=Depends(require_admin)
):
    row = await db.get(Scenario, scenario_id)
    if not row:
        raise HTTPException(404, "시나리오를 찾을 수 없습니다")
    _validate(body)
    _apply(row, body)
    await db.commit()
    await db.refresh(row)
    return row


@router.delete("/{scenario_id}")
async def delete_scenario(
    scenario_id: uuid.UUID, db: AsyncSession = Depends(get_db), _=Depends(require_admin)
):
    row = await db.get(Scenario, scenario_id)
    if not row:
        raise HTTPException(404, "시나리오를 찾을 수 없습니다")
    used = (
        await db.execute(
            select(func.count(AssessmentScenario.id)).where(AssessmentScenario.scenario_id == scenario_id)
        )
    ).scalar() or 0
    if used:
        # 시험에 연결된 시나리오는 기록 보존을 위해 삭제 대신 보관 처리
        row.is_archived = True
        await db.commit()
        return {"ok": True, "archived": True}
    await db.delete(row)
    await db.commit()
    return {"ok": True, "archived": False}

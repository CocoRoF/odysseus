"""리뷰 — 스태프의 응시 열람/평가. 대화·파일·실행 상세는 응시 조회 엔드포인트를 재사용한다."""

import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from ..ai import provider as ai_provider
from ..ai.autoeval import run_auto_eval, run_checks
from ..ai.errors import redact
from ..db import get_db
from ..deps import is_staff, require_staff
from ..models import (
    AiProvider,
    Assessment,
    AssessmentScenario,
    Attempt,
    Evaluation,
    Event,
    User,
)
from ..schemas import AutoEvalIn, HumanEvalIn

router = APIRouter(prefix="/review", tags=["review"], dependencies=[Depends(require_staff)])


@router.get("/attempts")
async def list_attempts(db: AsyncSession = Depends(get_db)):
    rows = (
        await db.execute(
            select(Attempt)
            .options(selectinload(Attempt.user), selectinload(Attempt.assessment))
            .order_by(Attempt.started_at.desc())
        )
    ).scalars().all()
    evals = (
        await db.execute(select(Evaluation.attempt_id, Evaluation.kind))
    ).all()
    eval_kinds: dict[uuid.UUID, set[str]] = {}
    for attempt_id, kind in evals:
        eval_kinds.setdefault(attempt_id, set()).add(kind)
    return [
        {
            "id": str(a.id),
            "user": {"id": str(a.user.id), "name": a.user.name, "email": a.user.email, "role": a.user.role},
            "assessment_id": str(a.assessment_id),
            "assessment_title": a.assessment.title,
            "status": a.status,
            "superseded": a.superseded,
            "is_staff": is_staff(a.user),
            "started_at": a.started_at.isoformat(),
            "submitted_at": a.submitted_at.isoformat() if a.submitted_at else None,
            "has_auto_eval": "auto" in eval_kinds.get(a.id, set()),
            "has_human_eval": "human" in eval_kinds.get(a.id, set()),
        }
        for a in rows
    ]


async def _load_attempt(attempt_id: uuid.UUID, db: AsyncSession) -> Attempt:
    attempt = (
        await db.execute(
            select(Attempt)
            .where(Attempt.id == attempt_id)
            .options(selectinload(Attempt.user), selectinload(Attempt.assessment))
        )
    ).scalar_one_or_none()
    if not attempt:
        raise HTTPException(404, "응시 정보를 찾을 수 없습니다")
    return attempt


@router.get("/attempts/{attempt_id}")
async def attempt_detail(attempt_id: uuid.UUID, db: AsyncSession = Depends(get_db)):
    attempt = await _load_attempt(attempt_id, db)
    links = (
        await db.execute(
            select(AssessmentScenario)
            .where(AssessmentScenario.assessment_id == attempt.assessment_id)
            .options(selectinload(AssessmentScenario.scenario))
            .order_by(AssessmentScenario.ordinal)
        )
    ).scalars().all()
    evaluations = (
        await db.execute(
            select(Evaluation)
            .where(Evaluation.attempt_id == attempt_id)
            .options(selectinload(Evaluation.evaluator))
            .order_by(Evaluation.created_at.desc())
        )
    ).scalars().all()
    return {
        "id": str(attempt.id),
        "status": attempt.status,
        "superseded": attempt.superseded,
        "started_at": attempt.started_at.isoformat(),
        "deadline_at": attempt.deadline_at.isoformat(),
        "submitted_at": attempt.submitted_at.isoformat() if attempt.submitted_at else None,
        "user": {
            "id": str(attempt.user.id),
            "name": attempt.user.name,
            "email": attempt.user.email,
            "role": attempt.user.role,
        },
        "assessment": {
            "id": str(attempt.assessment.id),
            "title": attempt.assessment.title,
            "duration_min": attempt.assessment.duration_min,
            "agent_max_turns": attempt.assessment.agent_max_turns,
        },
        "scenarios": [
            {
                "scenario_id": str(link.scenario_id),
                "title": link.scenario.title,
                "difficulty": link.scenario.difficulty,
                "points": link.points,
                "briefing_md": link.scenario.briefing_md,
                "objectives_md": link.scenario.objectives_md,
                "checks": link.scenario.checks,
                "rubric": link.scenario.rubric,
                "characters": link.scenario.characters,
                "initial_files": [f.get("path") for f in (link.scenario.initial_files or [])],
            }
            for link in links
        ],
        "evaluations": [
            {
                "id": str(e.id),
                "kind": e.kind,
                "evaluator": e.evaluator.name if e.evaluator else None,
                "scores": e.scores,
                "summary": e.summary,
                "created_at": e.created_at.isoformat(),
            }
            for e in evaluations
        ],
    }


@router.get("/attempts/{attempt_id}/events")
async def attempt_events(attempt_id: uuid.UUID, db: AsyncSession = Depends(get_db)):
    await _load_attempt(attempt_id, db)
    events = (
        await db.execute(
            select(Event).where(Event.attempt_id == attempt_id).order_by(Event.created_at)
        )
    ).scalars().all()
    return [
        {
            "id": e.id,
            "scenario_id": str(e.scenario_id) if e.scenario_id else None,
            "type": e.type,
            "source": e.source,
            "payload": e.payload,
            "created_at": e.created_at.isoformat(),
        }
        for e in events
    ]


@router.get("/ai-providers")
async def eval_providers(db: AsyncSession = Depends(get_db)):
    rows = (
        await db.execute(
            select(AiProvider).where(AiProvider.enabled.is_(True)).order_by(AiProvider.created_at)
        )
    ).scalars().all()
    return [
        {
            "id": str(r.id),
            "name": r.name,
            "provider": r.provider,
            "model": r.model,
            "is_eval_default": r.is_eval_default,
        }
        for r in rows
    ]


@router.post("/attempts/{attempt_id}/checks")
async def run_scenario_checks(attempt_id: uuid.UUID, db: AsyncSession = Depends(get_db)):
    """자동 체크만 실행 (LLM 없이) — 시나리오 설계 검증과 빠른 결과 확인용."""
    attempt = await _load_attempt(attempt_id, db)
    links = (
        await db.execute(
            select(AssessmentScenario)
            .where(AssessmentScenario.assessment_id == attempt.assessment_id)
            .options(selectinload(AssessmentScenario.scenario))
            .order_by(AssessmentScenario.ordinal)
        )
    ).scalars().all()
    out = []
    for link in links:
        checks = await run_checks(db, attempt, link.scenario)
        out.append(
            {
                "scenario_id": str(link.scenario_id),
                "title": link.scenario.title,
                "checks": checks,
                "earned": sum(c["earned"] for c in checks),
                "total": sum(c["points"] for c in checks),
            }
        )
    return {"scenarios": out}


@router.post("/attempts/{attempt_id}/autoeval")
async def autoeval(
    attempt_id: uuid.UUID, body: AutoEvalIn | None = None, db: AsyncSession = Depends(get_db)
):
    attempt = await _load_attempt(attempt_id, db)
    try:
        evaluation = await run_auto_eval(
            attempt, db, override_provider_id=body.provider_id if body else None
        )
    except RuntimeError as e:
        raise HTTPException(503, redact(str(e))[:600])
    return {
        "id": str(evaluation.id),
        "kind": evaluation.kind,
        "scores": evaluation.scores,
        "summary": evaluation.summary,
        "created_at": evaluation.created_at.isoformat(),
    }


@router.post("/attempts/{attempt_id}/evaluate")
async def human_evaluate(
    attempt_id: uuid.UUID,
    body: HumanEvalIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_staff),
):
    await _load_attempt(attempt_id, db)
    evaluation = Evaluation(
        attempt_id=attempt_id,
        kind="human",
        evaluator_id=user.id,
        scores=body.scores,
        summary=body.summary,
    )
    db.add(evaluation)
    await db.commit()
    return {"id": str(evaluation.id), "ok": True}

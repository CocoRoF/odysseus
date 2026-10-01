"""리뷰 — 스태프의 응시 열람/평가.

과거 응시의 문제·배점·숨은 목표·체크는 현재 authoring row가 아니라 응시 시작 시 저장한
immutable definition snapshot을 사용한다. 자동/수동 평가 모두 종료된 응시에만 허용한다.
"""

import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from ..ai import provider as ai_provider
from ..ai.autoeval import run_checks
from ..ai.errors import redact
from ..ai_incidents import incidents
from ..app_usage import app_activity
from ..db import get_db
from ..definitions import (
    DEFINITION_HASH_KEY,
    agent_turn_limit,
    definition_for_attempt,
    messenger_turn_limit,
    definition_summary,
    scenario_from_definition,
)
from ..demo import mask_email_for
from ..grading import AlreadyGrading, grade
from ..deps import get_current_user, is_staff, require_staff
from ..desktop import allowed_desktop_apps
from ..models import AiProvider, Attempt, Evaluation, Event, User
from ..schemas import AutoEvalIn, HumanEvalIn

router = APIRouter(prefix="/review", tags=["review"], dependencies=[Depends(require_staff)])


@router.get("/attempts")
async def list_attempts(db: AsyncSession = Depends(get_db), viewer=Depends(get_current_user)):
    rows = (
        await db.execute(
            select(Attempt)
            .options(selectinload(Attempt.user), selectinload(Attempt.assessment))
            .order_by(Attempt.started_at.desc())
        )
    ).scalars().all()
    evals = (await db.execute(select(Evaluation.attempt_id, Evaluation.kind, Evaluation.scores))).all()
    eval_kinds: dict[uuid.UUID, set[str]] = {}
    # 목록에서 점수를 보여 준다 — "평가함/안 함" 만으로는 무엇을 먼저 볼지 정할 수 없다.
    # 사람이 준 점수가 있으면 그것이 최종이고, 없으면 자동평가 점수를 쓴다.
    eval_scores: dict[uuid.UUID, float] = {}
    for attempt_id, kind, scores in evals:
        eval_kinds.setdefault(attempt_id, set()).add(kind)
        value = (scores or {}).get("overall_score", (scores or {}).get("score"))
        try:
            number = float(value)
        except (TypeError, ValueError):
            continue
        if kind == "human" or attempt_id not in eval_scores:
            eval_scores[attempt_id] = round(number, 1)
    out = []
    for a in rows:
        frozen_title, definition_hash = definition_summary(a.snapshot)
        out.append(
            {
                "id": str(a.id),
                "user": {"id": str(a.user.id), "name": a.user.name,
                         "email": mask_email_for(viewer, a.user.email), "role": a.user.role},
                "assessment_id": str(a.assessment_id),
                "assessment_title": frozen_title or a.assessment.title,
                "definition_hash": definition_hash,
                "status": a.status,
                "superseded": a.superseded,
                "is_staff": is_staff(a.user),
                "started_at": a.started_at.isoformat(),
                "submitted_at": a.submitted_at.isoformat() if a.submitted_at else None,
                "has_auto_eval": "auto" in eval_kinds.get(a.id, set()),
                "has_human_eval": "human" in eval_kinds.get(a.id, set()),
                "score": eval_scores.get(a.id),
            }
        )
    return out


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


def _require_final(attempt: Attempt) -> None:
    if attempt.status == "in_progress":
        raise HTTPException(409, "진행 중인 시험은 평가할 수 없습니다. 먼저 제출 또는 종료하세요")


@router.get("/attempts/{attempt_id}")
async def attempt_detail(attempt_id: uuid.UUID, db: AsyncSession = Depends(get_db), viewer=Depends(get_current_user)):
    attempt = await _load_attempt(attempt_id, db)
    definition = await definition_for_attempt(db, attempt)
    evaluations = (
        await db.execute(
            select(Evaluation)
            .where(Evaluation.attempt_id == attempt_id)
            .options(selectinload(Evaluation.evaluator))
            .order_by(Evaluation.created_at.desc())
        )
    ).scalars().all()
    scenarios = []
    for spec in sorted(definition.get("scenarios") or [], key=lambda x: int(x.get("ordinal", 0) or 0)):
        scenario = scenario_from_definition(definition, spec.get("scenario_id"))
        if not scenario:
            continue
        scenarios.append(
            {
                "scenario_id": str(scenario.id),
                "title": scenario.title,
                "difficulty": scenario.difficulty,
                "ordinal": scenario.ordinal,
                "points": scenario.points,
                "briefing_md": scenario.briefing_md,
                "objectives_md": scenario.objectives_md,
                "checks": scenario.checks,
                "rubric": scenario.rubric,
                "requirement_graph": scenario.requirement_graph,
                "characters": scenario.characters,
                "initial_files": [f.get("path") for f in (scenario.initial_files or [])],
                # 이 시나리오가 실제로 띄워 준 앱 — 채점 화면의 탭이 이것을 따른다.
                # 응시자가 쓸 수 없었던 도구를 채점자가 찾아 헤매지 않도록, 비어 있으면 전부로
                # 풀어 응시 화면과 같은 목록을 낸다(desktop.allowed_desktop_apps).
                "desktop_apps": allowed_desktop_apps(scenario.desktop_apps or []),
                "agent_enabled": bool(scenario.agent_enabled),
                # 실제로 무엇을 썼는가 — 채점 탭은 제공 목록이 아니라 이 결과를 따른다.
                # 쓰지 않은 앱을 채점자가 매번 열어 보고 비어 있음을 확인할 이유가 없다.
                "app_activity": await app_activity(db, attempt_id, scenario),
            }
        )
    return {
        "id": str(attempt.id),
        "status": attempt.status,
        "superseded": attempt.superseded,
        "started_at": attempt.started_at.isoformat(),
        "deadline_at": attempt.deadline_at.isoformat(),
        "submitted_at": attempt.submitted_at.isoformat() if attempt.submitted_at else None,
        "definition_hash": (attempt.snapshot or {}).get(DEFINITION_HASH_KEY) or definition.get("definition_hash"),
        "user": {
            "id": str(attempt.user.id),
            "name": attempt.user.name,
            "email": mask_email_for(viewer, attempt.user.email),
            "role": attempt.user.role,
        },
        "assessment": {
            "id": str(attempt.assessment_id),
            "title": definition.get("title") or attempt.assessment.title,
            "description": definition.get("description") or "",
            "duration_min": int(definition.get("duration_min", 0) or 0),
            "agent_max_turns": int(definition.get("agent_max_turns", 0) or 0),
        },
        # 시험이 정한 한도에 보정을 더한 실제 한도 — 사용량을 읽을 때 이 값과 비교한다
        "agent_turn_limit": agent_turn_limit(definition, attempt),
        "messenger_turn_limit": messenger_turn_limit(definition, attempt),
        # 채점 전에 한눈에 봐야 하는 수치 — 몇 번 물었고, 무엇을 남겼는가
        "usage": await _usage(db, attempt_id),
        "scenarios": scenarios,
        # 이 응시 중 AI 가 답을 만들지 못한 건수. 채점자가 불완전한 기록을 정상으로 믿고
        # 사람을 떨어뜨리는 일을 막는다 — 대화 원문은 넣지 않고 코드별 건수만 센다.
        "ai_incidents": await incidents(db, attempt_id),
        # 관리자가 이 응시에 얹어 준 보정 — 원래 조건과 구제를 구분해 채점하도록 사유와 함께 낸다.
        "grants": await _grant_records(db, attempt_id),
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


async def _usage(db: AsyncSession, attempt_id: uuid.UUID) -> dict:
    """이 응시가 실제로 쓴 것 — 질문 수는 돌려준 것을 빼고 센다(ai_incidents 와 같은 기준)."""
    from ..ai_incidents import refunded_agent, refunded_messenger
    from ..models import AgentMessage, Execution, MessengerMessage, WorkspaceFile

    async def count(model, *where) -> int:
        return int((await db.execute(select(func.count()).select_from(model).where(*where))).scalar_one() or 0)

    agent_sent = await count(AgentMessage, AgentMessage.attempt_id == attempt_id, AgentMessage.role == "user")
    messenger_sent = await count(
        MessengerMessage, MessengerMessage.attempt_id == attempt_id, MessengerMessage.sender == "candidate"
    )
    return {
        "agent_turns": max(0, agent_sent - await refunded_agent(db, attempt_id)),
        "messenger_turns": max(0, messenger_sent - await refunded_messenger(db, attempt_id)),
        "files": await count(WorkspaceFile, WorkspaceFile.attempt_id == attempt_id),
        "executions": await count(Execution, Execution.attempt_id == attempt_id),
    }


async def _grant_records(db: AsyncSession, attempt_id: uuid.UUID) -> list[dict]:
    rows = (
        await db.execute(
            select(Event)
            .where(Event.attempt_id == attempt_id, Event.type == "attempt_grant")
            .order_by(Event.created_at)
        )
    ).scalars().all()
    return [
        {
            "at": e.created_at.isoformat(),
            "agent_turns": int((e.payload or {}).get("agent_turns") or 0),
            "messenger_turns": int((e.payload or {}).get("messenger_turns") or 0),
            "extra_minutes": int((e.payload or {}).get("extra_minutes") or 0),
            "reason": str((e.payload or {}).get("reason") or ""),
            "by": str((e.payload or {}).get("by_name") or ""),
        }
        for e in rows
    ]


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
    """종료된 응시에 대해 frozen checks만 실행한다 — 현재 스튜디오의 수정값은 읽지 않는다."""
    # 결정적 checks 는 LLM 이 없고 워크스페이스를 바꾸지 않는다 — 진행 중 미리보기(참조 해답 검증 등)를 막지 않는다.
    # 최종 점수에 남는 autoeval/evaluate 만 제출·종료 뒤로 제한한다 (_require_final).
    attempt = await _load_attempt(attempt_id, db)
    definition = await definition_for_attempt(db, attempt)
    out = []
    for spec in sorted(definition.get("scenarios") or [], key=lambda x: int(x.get("ordinal", 0) or 0)):
        scenario = scenario_from_definition(definition, spec.get("scenario_id"))
        if not scenario:
            continue
        checks = await run_checks(db, attempt, scenario)
        out.append(
            {
                "scenario_id": str(scenario.id),
                "title": scenario.title,
                "checks": checks,
                "earned": sum(c["earned"] for c in checks),
                "total": sum(c["points"] for c in checks),
            }
        )
    return {
        "definition_hash": (attempt.snapshot or {}).get(DEFINITION_HASH_KEY) or definition.get("definition_hash"),
        "scenarios": out,
    }


@router.post("/attempts/{attempt_id}/autoeval")
async def autoeval(
    attempt_id: uuid.UUID, body: AutoEvalIn | None = None, db: AsyncSession = Depends(get_db)
):
    attempt = await _load_attempt(attempt_id, db)
    _require_final(attempt)
    try:
        # 관리자의 [다시 평가] — 이미 결과가 있어도 새로 매긴다(force). 그 밖의 규칙(동결 정의·잠금)은
        # 시험이 끝날 때 도는 채점과 같다. 입구는 grading.grade 하나다.
        evaluation = await grade(
            attempt_id, force=True, provider_id=body.provider_id if body else None
        )
    except AlreadyGrading:
        raise HTTPException(409, "이 응시는 지금 채점 중입니다. 잠시 뒤 다시 확인하세요")
    except RuntimeError as e:
        raise HTTPException(503, redact(str(e))[:600])
    if evaluation is None:
        raise HTTPException(404, "응시를 찾을 수 없습니다")
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
    attempt = await _load_attempt(attempt_id, db)
    _require_final(attempt)
    definition = await definition_for_attempt(db, attempt)
    scores = dict(body.scores or {})
    scores["audit"] = {
        **(scores.get("audit") if isinstance(scores.get("audit"), dict) else {}),
        "definition_hash": (attempt.snapshot or {}).get(DEFINITION_HASH_KEY) or definition.get("definition_hash"),
        "evaluator_id": str(user.id),
        "kind": "human",
    }
    evaluation = Evaluation(
        attempt_id=attempt_id,
        kind="human",
        evaluator_id=user.id,
        scores=scores,
        summary=body.summary,
    )
    db.add(evaluation)
    await db.commit()
    return {"id": str(evaluation.id), "ok": True}

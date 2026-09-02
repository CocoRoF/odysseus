"""AI 에이전트 라우터 — SSE 스트리밍 도구 루프 + 이력/사용량."""

import asyncio
import json
import uuid

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..ai import agent as agent_ai
from ..ai import provider as ai_provider
from ..config import settings
from ..db import SessionLocal, get_db
from ..deps import get_current_user
from ..models import AgentMessage, Assessment, Event, User
from ..schemas import AgentMessageOut, AgentSendIn, AgentUsageOut
from .attempts import get_attempt_for, require_own_active, scenario_in_attempt

router = APIRouter(tags=["agent"])


async def _used_turns(db: AsyncSession, attempt_id: uuid.UUID) -> int:
    return (
        await db.execute(
            select(func.count(AgentMessage.id)).where(
                AgentMessage.attempt_id == attempt_id, AgentMessage.role == "user"
            )
        )
    ).scalar() or 0


@router.get("/attempts/{attempt_id}/agent/usage", response_model=AgentUsageOut)
async def agent_usage(
    attempt_id: uuid.UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    attempt = await get_attempt_for(attempt_id, user, db)
    assessment = await db.get(Assessment, attempt.assessment_id)
    used = await _used_turns(db, attempt_id)
    res = await ai_provider.resolve_ai(db, "chat", override_provider_id=assessment.agent_provider_id)
    return AgentUsageOut(
        enabled=assessment.agent_max_turns > 0,
        used=used,
        max=assessment.agent_max_turns,
        remaining=max(0, assessment.agent_max_turns - used),
        configured=bool(res and res.configured),
        model=res.model if res else None,
        tools_available=bool(res and ai_provider.agent_tools_available(res)),
        provider_name=res.name if res else None,
    )


@router.get(
    "/attempts/{attempt_id}/scenarios/{scenario_id}/agent/messages",
    response_model=list[AgentMessageOut],
)
async def list_agent_messages(
    attempt_id: uuid.UUID,
    scenario_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    attempt = await get_attempt_for(attempt_id, user, db)
    await scenario_in_attempt(attempt, scenario_id, db)
    return (
        await db.execute(
            select(AgentMessage)
            .where(AgentMessage.attempt_id == attempt_id, AgentMessage.scenario_id == scenario_id)
            .order_by(AgentMessage.created_at)
        )
    ).scalars().all()


@router.post("/attempts/{attempt_id}/scenarios/{scenario_id}/agent/messages")
async def send_agent_message(
    attempt_id: uuid.UUID,
    scenario_id: uuid.UUID,
    body: AgentSendIn,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    attempt = await require_own_active(attempt_id, user, db)
    scenario = await scenario_in_attempt(attempt, scenario_id, db)
    if not scenario.agent_enabled:
        raise HTTPException(403, "이 시나리오에서는 AI 에이전트를 사용할 수 없습니다")

    assessment = await db.get(Assessment, attempt.assessment_id)
    if assessment.agent_max_turns <= 0:
        raise HTTPException(403, "이 시험에서는 AI 에이전트를 사용할 수 없습니다")
    used = await _used_turns(db, attempt_id)
    if used >= assessment.agent_max_turns:
        raise HTTPException(429, f"에이전트 사용 한도({assessment.agent_max_turns}회)를 모두 사용했습니다")

    res = await ai_provider.resolve_ai(db, "chat", override_provider_id=assessment.agent_provider_id)
    if res is None or not res.configured:
        raise HTTPException(503, "AI가 설정되지 않았습니다. 관리자에게 문의하세요 (관리자 콘솔 > 설정)")

    # 대화 이력 (텍스트만 — 도구 상세는 재주입하지 않는다)
    history = (
        await db.execute(
            select(AgentMessage)
            .where(AgentMessage.attempt_id == attempt_id, AgentMessage.scenario_id == scenario_id)
            .order_by(AgentMessage.created_at.desc())
            .limit(settings.agent_history_limit)
        )
    ).scalars().all()
    messages = [{"role": m.role, "content": m.content} for m in reversed(list(history)) if m.content]
    messages.append({"role": "user", "content": body.content})

    user_msg = AgentMessage(
        attempt_id=attempt_id, scenario_id=scenario_id, role="user", content=body.content
    )
    db.add(user_msg)
    db.add(
        Event(
            attempt_id=attempt_id,
            scenario_id=scenario_id,
            type="agent_turn",
            payload={"chars": len(body.content)},
        )
    )
    await db.commit()

    user_id = user.id

    async def persist(parts: list[str], steps: list[dict], error: str | None) -> str | None:
        async with SessionLocal() as s:
            meta: dict = {"steps": steps}
            if error:
                meta["error"] = error
            msg = AgentMessage(
                attempt_id=attempt_id,
                scenario_id=scenario_id,
                role="assistant",
                content="".join(parts),
                model=res.model,
                meta=meta,
            )
            s.add(msg)
            await s.commit()
            return str(msg.id)

    async def event_stream():
        parts: list[str] = []
        steps: list[dict] = []
        error: str | None = None
        persisted = False
        try:
            try:
                async for ev in agent_ai.run_agent_turn(
                    db, res, attempt_id, scenario_id, user_id, messages
                ):
                    if "delta" in ev:
                        parts.append(ev["delta"])
                        yield f"data: {json.dumps({'delta': ev['delta']}, ensure_ascii=False)}\n\n"
                    elif "tool" in ev:
                        yield f"data: {json.dumps({'tool': ev['tool']}, ensure_ascii=False)}\n\n"
                    elif "steps" in ev:
                        steps = ev["steps"]
            except Exception as e:  # noqa: BLE001 — 오류도 응답으로 전달
                error = str(e)[:600]
                yield f"data: {json.dumps({'error': error}, ensure_ascii=False)}\n\n"
            msg_id = await persist(parts, steps, error)
            persisted = True
            yield f"data: {json.dumps({'done': True, 'message_id': msg_id})}\n\n"
        finally:
            if not persisted:
                asyncio.get_running_loop().create_task(persist(parts, steps, error or "disconnected"))

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )

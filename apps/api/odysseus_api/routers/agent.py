"""AI 에이전트 라우터 — SSE 스트리밍 도구 루프 + 이력/사용량."""

import asyncio
import json
import time
import uuid

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from ..ai import agent as agent_ai
from ..ai import provider as ai_provider
from ..ai.errors import describe_error, public_meta
from ..ai_incidents import candidate_ended_code, failure_meta, refunded_agent
from ..config import settings
from ..db import SessionLocal, get_db
from ..definitions import agent_turn_limit, definition_for_attempt, resolve_attempt_ai
from ..deps import get_current_user
from ..guests import guest_chat_budget, guest_chat_gate
from ..locks import acquire_lease
from ..models import AgentMessage, Attempt, Event, User
from ..ratelimit import enforce
from ..runqueue import get_redis
from ..schemas import AgentMessageOut, AgentSendIn, AgentUsageOut
from .attempts import get_attempt_for, require_own_active, scenario_in_attempt

router = APIRouter(tags=["agent"])

#: 클라이언트가 끊긴 뒤에도 끝까지 가야 하는 작업들 — 응답 기록과 lease 해제.
#:
#: asyncio 는 **태스크에 강한 참조가 없으면 실행 도중에 수거할 수 있다.** 반환값을 버리는
#: ``create_task(...)`` 는 대개 돌지만 가끔 조용히 사라져, 끊긴 턴의 응답 행이 남지 않는다.
_BACKGROUND: set[asyncio.Task] = set()


def _spawn(coro) -> None:
    task = asyncio.get_running_loop().create_task(coro)
    _BACKGROUND.add(task)
    task.add_done_callback(_BACKGROUND.discard)


async def _used_turns(db: AsyncSession, attempt_id: uuid.UUID) -> int:
    """소모한 질문 수 — 돌려준 턴(meta.refunded)은 빼고 센다 (ai_incidents).

    사용자 메시지는 LLM 호출 **전에** 커밋된다 (그래야 중단돼도 무엇을 물었는지 남는다).
    그래서 보낸 것을 그대로 세면 공급자 장애가 응시자의 질문 한도를 먹는다.
    """
    sent = (
        await db.execute(
            select(func.count(AgentMessage.id)).where(
                AgentMessage.attempt_id == attempt_id, AgentMessage.role == "user"
            )
        )
    ).scalar() or 0
    return max(0, int(sent) - await refunded_agent(db, attempt_id))


#: 응시자가 [중단] 을 눌렀다는 표시. 스트림이 닫히는 것만으로는 "직접 멈췄는지" 를 알 수 없어,
#: 클라이언트가 fetch 를 끊기 직전에 이 표시를 남긴다. 턴 하나보다 길게 살아 있을 이유가 없다.
#: 표시는 기록의 **이름**만 정한다(AI_CANCELLED/AI_DISCONNECTED) — 소모 여부는 무엇이 나왔는가로만 정한다.
CANCEL_KEY = "odysseus:agent:cancel:{aid}"
CANCEL_TTL_S = 120


#: Redis 가 없을 때의 프로세스 로컬 표시 — lease 의 로컬 폴백과 같은 보장(단일 인스턴스)이다.
_local_cancels: dict[str, float] = {}


async def mark_cancelled(attempt_id: uuid.UUID) -> None:
    key = CANCEL_KEY.format(aid=attempt_id)
    try:
        await get_redis().set(key, "1", ex=CANCEL_TTL_S)
    except Exception:  # noqa: BLE001 — 표시를 못 남겨도 중단 자체는 되어야 한다
        _local_cancels[key] = time.monotonic() + CANCEL_TTL_S


async def cancel_requested(attempt_id: uuid.UUID) -> bool:
    """표시를 읽고 **지운다** — 다음 턴이 이전 중단을 물려받지 않게."""
    key = CANCEL_KEY.format(aid=attempt_id)
    local = _local_cancels.pop(key, 0.0) > time.monotonic()
    try:
        return bool(await get_redis().delete(key)) or local
    except Exception:  # noqa: BLE001
        return local


@router.post("/attempts/{attempt_id}/agent/cancel")
async def cancel_agent_turn(
    attempt_id: uuid.UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    """진행 중인 에이전트 요청을 멈춘다.

    터미널에는 Ctrl+C 가 있는데 에이전트에는 없었다. 한 턴은 도구 반복 × 공급자 타임아웃까지
    갈 수 있어서, 잘못 지시한 걸 깨달아도 몇 분을 기다려야 했다.

    실제 중단은 클라이언트가 스트림을 끊어서 일어난다. 여기서는 그것이 **의도된 중단**이라는
    표시만 남긴다 — 평가 기록이 "응시자가 멈췄다" 와 "연결이 끊겼다" 를 구분하게 한다.
    """
    attempt = await require_own_active(attempt_id, user, db)
    await mark_cancelled(attempt.id)
    return {"ok": True}


@router.get("/attempts/{attempt_id}/agent/usage", response_model=AgentUsageOut)
async def agent_usage(
    attempt_id: uuid.UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    attempt = await get_attempt_for(attempt_id, user, db)
    definition = await definition_for_attempt(db, attempt)
    max_turns = agent_turn_limit(definition, attempt)
    used = await _used_turns(db, attempt_id)
    refunded = await refunded_agent(db, attempt_id)
    res = await resolve_attempt_ai(db, definition, "agent")
    # 게스트에게는 **실제로 부딪히는** 한도를 보여 준다 — 메신저와 합쳐 세는 총량이다.
    shared = False
    budget = await guest_chat_budget(db, user, attempt)
    if budget is not None:
        used, max_turns = budget
        shared = True
    return AgentUsageOut(
        enabled=max_turns > 0,
        used=used,
        max=max_turns,
        remaining=max(0, max_turns - used),
        refunded=refunded,
        shared=shared,
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
    await scenario_in_attempt(attempt, scenario_id, db, user)
    rows = (
        await db.execute(
            select(AgentMessage)
            .where(AgentMessage.attempt_id == attempt_id, AgentMessage.scenario_id == scenario_id)
            .order_by(AgentMessage.created_at)
        )
    ).scalars().all()
    return [
        AgentMessageOut(id=r.id, role=r.role, content=r.content, model=r.model, meta=public_meta(r.meta), created_at=r.created_at)
        for r in rows
    ]


@router.post("/attempts/{attempt_id}/scenarios/{scenario_id}/agent/messages")
async def send_agent_message(
    attempt_id: uuid.UUID,
    scenario_id: uuid.UUID,
    body: AgentSendIn,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    attempt = await require_own_active(attempt_id, user, db)
    scenario = await scenario_in_attempt(attempt, scenario_id, db, user, mutate=True)
    if not scenario.agent_enabled:
        raise HTTPException(403, "이 시나리오에서는 AI 에이전트를 사용할 수 없습니다")
    enforce(f"agent:{attempt_id}", per_min=12, burst=6, what="에이전트 요청")
    await guest_chat_gate(db, user, attempt_id, what="에이전트 요청")

    definition = await definition_for_attempt(db, attempt)
    max_turns = agent_turn_limit(definition, attempt)
    if max_turns <= 0:
        raise HTTPException(403, "이 시험에서는 AI 에이전트를 사용할 수 없습니다")

    res = await resolve_attempt_ai(db, definition, "agent")
    if res is None or not res.configured:
        raise HTTPException(503, "AI가 설정되지 않았습니다. 관리자에게 문의하세요 (관리자 콘솔 > 설정)")

    # 한 턴은 도구 반복 × 공급자 타임아웃(300s)까지 갈 수 있다 — lease 는 도는 동안 갱신되고,
    # 프로세스가 사라지면 1분 안에 풀린다. 30분은 해제가 끝내 불리지 않을 때의 상한일 뿐이다.
    turn_lease = await acquire_lease(f"agent-turn:{attempt_id}", max_hold_s=30 * 60)
    if turn_lease is None:
        raise HTTPException(409, "이미 진행 중인 에이전트 요청이 있습니다. 끝난 뒤 다시 보내세요")

    # 앞 턴에서 [중단] 을 눌렀지만 그 턴이 결국 정상 종료했다면 표시가 그대로 남는다. 새 턴을 시작하기
    # 전에 지운다. lease 를 얻은 **뒤에** 지워야 한다 — 앞 턴의 끊김 기록은 lease 를 놓기 전에 표시를
    # 읽으므로, 먼저 지우면 방금 멈춘 턴이 "연결 끊김" 으로 남는다.
    await cancel_requested(attempt_id)

    reserved = False
    try:
        await db.execute(select(Attempt).where(Attempt.id == attempt_id).with_for_update())
        used = await _used_turns(db, attempt_id)
        if used >= max_turns:
            await db.rollback()
            raise HTTPException(429, f"에이전트 사용 한도({max_turns}회)를 모두 사용했습니다")

        history = (
            await db.execute(
                select(AgentMessage)
                .where(AgentMessage.attempt_id == attempt_id, AgentMessage.scenario_id == scenario_id)
                .order_by(AgentMessage.created_at.desc())
                .limit(settings.agent_history_limit)
            )
        ).scalars().all()
        messages = agent_ai.conversation_context(list(reversed(list(history))))
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
                payload={"chars": len(body.content), "turn": used + 1, "max": max_turns},
            )
        )
        await db.commit()
        reserved = True
    finally:
        if not reserved:
            await turn_lease.release()

    user_id = user.id
    # 응답 행의 id 를 미리 정한다. 끊김 처리(finally)가 정상 기록과 겹쳐도 같은 턴이 두 행이 되지
    # 않는다 — 두 행이면 환불 플래그도 두 번 세어진다.
    reply_id = uuid.uuid4()

    async def persist(parts: list[str], steps: list[dict], failure: dict | None) -> str:
        meta: dict = {"steps": steps}
        if failure:
            meta.update(failure)
        try:
            async with SessionLocal() as s:
                s.add(
                    AgentMessage(
                        id=reply_id,
                        attempt_id=attempt_id,
                        scenario_id=scenario_id,
                        role="assistant",
                        content="".join(parts),
                        model=res.model,
                        meta=meta,
                    )
                )
                await s.commit()
        except IntegrityError:
            pass  # 이미 기록된 턴 — 먼저 적힌 행이 정본이다
        return str(reply_id)

    async def record_ended(
        parts: list[str], steps: list[dict], failure: dict | None, *, produced_output: bool, tools_started: bool
    ) -> None:
        """스트림이 끝까지 가지 못한 턴을 기록하고 **그다음에** lease 를 놓는다.

        공급자가 먼저 실패했으면 그 기록이 정본이다. 아니면 응시자 쪽에서 끝난 것이다 — [중단] 을
        눌렀거나 새로고침·창 닫기·네트워크로 끊겼다. 장애가 아니므로 공급자 코드를 붙이지 않고,
        소모는 무엇이 나왔는가로만 정한다(ai_incidents.refund_decision).

        기록보다 lease 를 먼저 놓으면, 곧바로 보낸 다음 질문이 이 턴의 기록 없이 맥락을 만든다.
        """
        try:
            if failure is None:
                stopped = await cancel_requested(attempt_id)
                code = candidate_ended_code(
                    stopped=stopped, produced_output=produced_output, tools_started=tools_started
                )
                failure = failure_meta(code, produced_output=produced_output, tools_started=tools_started)
            await persist(parts, steps, failure)
        finally:
            await turn_lease.release()

    async def event_stream():
        parts: list[str] = []
        steps: list[dict] = []
        # 도구가 **돌기 시작했는가** — 끝나기 전에 실패해도 워크스페이스는 이미 바뀌었을 수 있다.
        tools_started = False
        failure: dict | None = None
        persisted = False

        def produced() -> bool:
            return any(p.strip() for p in parts)

        try:
            try:
                async for ev in agent_ai.run_agent_turn(
                    db, res, attempt_id, scenario_id, user_id, messages
                ):
                    if "delta" in ev:
                        parts.append(ev["delta"])
                        yield f"data: {json.dumps({'delta': ev['delta']}, ensure_ascii=False)}\n\n"
                    elif "tool_started" in ev:
                        tools_started = True
                    elif "tool" in ev:
                        # 실패로 끝나도 평가자가 무엇이 돌았는지 볼 수 있게 도착하는 대로 모은다.
                        # 턴이 끝까지 가면 마지막의 steps 가 같은 목록으로 덮는다.
                        tools_started = True
                        steps.append({"tool": ev["tool"].get("name", ""), "detail": ev["tool"].get("detail", "")})
                        yield f"data: {json.dumps({'tool': ev['tool']}, ensure_ascii=False)}\n\n"
                    elif "steps" in ev:
                        steps = ev["steps"]
            except Exception as e:  # noqa: BLE001
                # 공급자 호출에서 난 예외만 공급자 코드를 받는다 — 코드가 환불을 정하기 때문이다.
                info = describe_error(e, where="agent", provider_only=True)
                failure = failure_meta(
                    info["code"],
                    info["correlation_id"],
                    produced_output=produced(),
                    tools_started=tools_started or bool(steps),
                )
                payload = {
                    "error": info["message"],
                    "code": info["code"],
                    "correlation_id": info["correlation_id"],
                    "refunded": bool(failure.get("refunded")),
                }
                yield f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"
            msg_id = await persist(parts, steps, failure)
            persisted = True
            yield f"data: {json.dumps({'done': True, 'message_id': msg_id})}\n\n"
        finally:
            # 여기서는 await 하지 않는다. 클라이언트가 끊으면 이 제너레이터는 취소 스코프 안에서 닫히고,
            # finally 안의 await 는 CancelledError 로 뒤의 줄을 건너뛴다 — 기록도 lease 해제도 사라진다.
            if persisted:
                _spawn(turn_lease.release())
            else:
                _spawn(
                    record_ended(
                        list(parts),
                        list(steps),
                        failure,
                        produced_output=produced(),
                        tools_started=tools_started or bool(steps),
                    )
                )

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )

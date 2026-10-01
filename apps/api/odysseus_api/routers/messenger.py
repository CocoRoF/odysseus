"""메신저 — 등장인물별 스레드 조회 + 메시지 전송(NPC 응답 생성).

동일한 응시/인물 스레드는 Redis lease로 직렬화한다. 따라서 API replica가 여러 개여도
두 NPC 답변이 같은 history를 보고 동시에 생성되어 순서가 뒤집히지 않는다.
"""

import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..ai import npc
from ..ai.errors import describe_error, public_meta
from ..ai_incidents import failure_meta, refunded_messenger
from ..config import settings
from ..db import get_db
from ..definitions import definition_for_attempt, messenger_turn_limit, resolve_attempt_ai
from ..deps import get_current_user
from ..guests import guest_chat_budget, guest_chat_gate
from ..locks import acquire_lease
from ..models import Attempt, Event, MessengerMessage, User
from ..ratelimit import enforce
from ..schemas import MessengerMessageOut, MessengerSendIn, MessengerUsageOut
from .attempts import get_attempt_for, require_own_active, scenario_in_attempt

router = APIRouter(tags=["messenger"])


def _find_character(scenario, character_key: str) -> dict:
    for c in scenario.characters or []:
        if c.get("key") == character_key:
            return c
    raise HTTPException(404, "등장인물을 찾을 수 없습니다")


def _out(row: MessengerMessage) -> MessengerMessageOut:
    """응시자에게 내보내는 한 줄 — meta 는 공개 가능한 것만 (ODY-022).

    오류 코드를 함께 내보내는 이유는, 그것이 없으면 실패한 응답이 NPC 의 평범한 대사와
    구별되지 않기 때문이다. 응시자는 자기 질문이 날아갔다는 사실조차 알 수 없었다.
    """
    return MessengerMessageOut(
        social=row.social,
        id=row.id,
        character_key=row.character_key,
        sender=row.sender,
        content=row.content,
        meta=public_meta(row.meta),
        created_at=row.created_at,
    )


@router.get(
    "/attempts/{attempt_id}/scenarios/{scenario_id}/messenger",
    response_model=list[MessengerMessageOut],
)
async def list_messages(
    attempt_id: uuid.UUID,
    scenario_id: uuid.UUID,
    character_key: str | None = None,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    attempt = await get_attempt_for(attempt_id, user, db)
    await scenario_in_attempt(attempt, scenario_id, db, user)
    q = (
        select(MessengerMessage)
        .where(MessengerMessage.attempt_id == attempt_id, MessengerMessage.scenario_id == scenario_id)
        .order_by(MessengerMessage.created_at)
    )
    if character_key:
        q = q.where(MessengerMessage.character_key == character_key)
    return [_out(r) for r in (await db.execute(q)).scalars().all()]


@router.get("/attempts/{attempt_id}/messenger/usage", response_model=MessengerUsageOut)
async def messenger_usage(
    attempt_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """남은 질문 수 — 에이전트와 같은 모양으로 낸다.

    대화가 곧 평가 대상인 시험에서 "몇 번 더 물어볼 수 있는가" 는 응시 전략 그 자체다.
    에이전트는 진작부터 남은 수를 보여 줬는데 메신저만 아무 말이 없었다.
    """
    attempt = await get_attempt_for(attempt_id, user, db)
    definition = await definition_for_attempt(db, attempt)
    cap = messenger_turn_limit(definition, attempt)
    sent = (
        await db.execute(
            select(func.count(MessengerMessage.id)).where(
                MessengerMessage.attempt_id == attempt_id, MessengerMessage.sender == "candidate"
            )
        )
    ).scalar() or 0
    refunded = await refunded_messenger(db, attempt_id)
    used = max(0, int(sent) - refunded)
    # 게스트에게는 **실제로 부딪히는** 한도를 보여 준다. 시험 정의의 한도를 그대로 내보내면
    # 300건이 남았다고 읽고 계획하다가 합산 60에서 끊긴다 (guests.guest_chat_budget).
    budget = await guest_chat_budget(db, user, attempt)
    if budget is not None:
        used, cap = budget
        return MessengerUsageOut(
            used=used, max=cap, remaining=max(0, cap - used), refunded=refunded, shared=True
        )
    return MessengerUsageOut(used=used, max=cap, remaining=max(0, cap - used), refunded=refunded)


@router.post(
    "/attempts/{attempt_id}/scenarios/{scenario_id}/messenger/{character_key}",
    response_model=list[MessengerMessageOut],
)
async def send_message(
    attempt_id: uuid.UUID,
    scenario_id: uuid.UUID,
    character_key: str,
    body: MessengerSendIn,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    attempt = await require_own_active(attempt_id, user, db)
    scenario = await scenario_in_attempt(attempt, scenario_id, db, user, mutate=True)
    character = _find_character(scenario, character_key)
    enforce(f"messenger:{attempt_id}", per_min=12, burst=6, what="메시지 전송")
    await guest_chat_gate(db, user, attempt_id, what="메시지 전송")

    # NPC 한 응답은 공급자 타임아웃(300s)까지 걸릴 수 있다 — lease 는 도는 동안 갱신되므로 같은 방에
    # 두 번째 전송이 끼어들지 않고, 프로세스가 사라지면 1분 안에 풀린다. 7분은 해제가 끝내 불리지 않을 때의 상한이다.
    lease = await acquire_lease(
        f"messenger-turn:{attempt_id}:{scenario_id}:{character_key}", max_hold_s=7 * 60
    )
    if lease is None:
        raise HTTPException(409, "이 대화방의 이전 메시지를 처리 중입니다. 답변이 온 뒤 다시 보내세요")

    try:
        await db.execute(select(Attempt).where(Attempt.id == attempt_id).with_for_update())
        # 돌려준 질문은 한도에서 뺀다 — 기록할 때 정한 플래그만 센다 (ai_incidents).
        sent = (
            await db.execute(
                select(func.count(MessengerMessage.id)).where(
                    MessengerMessage.attempt_id == attempt_id, MessengerMessage.sender == "candidate"
                )
            )
        ).scalar() or 0
        sent = max(0, int(sent) - await refunded_messenger(db, attempt_id))
        definition = await definition_for_attempt(db, attempt, persist_legacy=False)
        cap = messenger_turn_limit(definition, attempt)
        if sent >= cap:
            await db.rollback()
            raise HTTPException(429, f"이 시험에서 보낼 수 있는 메시지 한도({cap}건)에 도달했습니다")

        res = await resolve_attempt_ai(db, definition, "npc")
        if res is None or not res.configured:
            await db.rollback()
            raise HTTPException(503, "AI가 설정되지 않았습니다. 관리자에게 문의하세요 (관리자 콘솔 > 설정)")

        user_msg = MessengerMessage(
            attempt_id=attempt_id,
            scenario_id=scenario_id,
            character_key=character_key,
            sender="candidate",
            content=body.content,
        )
        db.add(user_msg)
        db.add(
            Event(
                attempt_id=attempt_id,
                scenario_id=scenario_id,
                type="msg_sent",
                payload={"character": character_key, "chars": len(body.content)},
            )
        )
        await db.commit()

        history = (
            await db.execute(
                select(MessengerMessage)
                .where(
                    MessengerMessage.attempt_id == attempt_id,
                    MessengerMessage.scenario_id == scenario_id,
                    MessengerMessage.character_key == character_key,
                )
                .order_by(MessengerMessage.created_at)
            )
        ).scalars().all()

        try:
            reply, meta = await npc.generate_reply(res, scenario, character, list(history))
        except Exception as e:  # noqa: BLE001
            # 인물이 연기하는 대사로 적지 않는다. "자리를 비웠다" 는 NPC 의 평범한 반응과
            # 구별되지 않아, 응시자가 장애를 상황으로 오해하고 다른 사람에게 물으러 갔다.
            # 이 행은 다음 턴의 NPC 맥락에서 빠진다 (npc.without_failed_exchanges).
            # 공급자 호출에서 난 예외만 공급자 코드를 받는다 — 코드가 환불을 정하기 때문이다.
            info = describe_error(e, where="npc", provider_only=True)
            # 메신저의 실패는 답장이 한 글자도 나가지 않은 경우뿐이다.
            meta = failure_meta(
                info["code"], info["correlation_id"], produced_output=False, tools_started=False
            )
            # 환불 문구는 실제로 돌려준 턴에만 붙인다 — 아니면 안내가 거짓이 된다.
            reply = f"(시스템) {info['message']}" + (
                " — 이 질문은 남은 횟수에 포함되지 않습니다." if meta.get("refunded") else ""
            )

        from ..npc.social import recognition
        social = recognition(attempt, scenario, character, history) if not meta.get("error") else ""
        if social:
            meta["office_social"] = social
        npc_msg = MessengerMessage(
            attempt_id=attempt_id,
            scenario_id=scenario_id,
            character_key=character_key,
            sender="npc",
            content=reply,
            model=res.model,
            meta=meta,
        )
        db.add(npc_msg)
        db.add(
            Event(
                attempt_id=attempt_id,
                scenario_id=scenario_id,
                type="msg_received",
                payload={
                    "character": character_key,
                    "chars": len(reply),
                    "error": meta.get("error"),
                    "refunded": bool(meta.get("refunded")),
                    "guard": meta.get("guard"),
                },
            )
        )
        await db.commit()
        await db.refresh(user_msg)
        await db.refresh(npc_msg)
        return [_out(user_msg), _out(npc_msg)]
    finally:
        await lease.release()

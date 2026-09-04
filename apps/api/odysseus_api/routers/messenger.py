"""메신저 — 등장인물별 스레드 조회 + 메시지 전송(NPC 응답 생성).

전송은 동기 처리: 응답이 완성되면 [사용자 메시지, NPC 응답] 두 건을 돌려준다.
클라이언트는 대기 중 '입력 중…' 표시로 메신저의 결을 살린다.
"""

import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from ..ai import npc
from ..ai import provider as ai_provider
from ..db import get_db
from ..deps import get_current_user
from ..guests import guest_chat_gate
from ..ratelimit import enforce
from ..ai.errors import describe_error
from ..config import settings
from ..models import Assessment, Event, MessengerMessage, User
from ..schemas import MessengerMessageOut, MessengerSendIn
from .attempts import get_attempt_for, require_own_active, scenario_in_attempt

router = APIRouter(tags=["messenger"])


def _find_character(scenario, character_key: str) -> dict:
    for c in scenario.characters or []:
        if c.get("key") == character_key:
            return c
    raise HTTPException(404, "등장인물을 찾을 수 없습니다")


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
    return (await db.execute(q)).scalars().all()


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
    # ODY-010: 응시별 속도(분당 12, 순간 6)와 총량(LLM 비용 예산)
    enforce(f"messenger:{attempt_id}", per_min=12, burst=6, what="메시지 전송")
    await guest_chat_gate(db, user, attempt_id, what="메시지 전송")
    sent = (
        await db.execute(
            select(func.count(MessengerMessage.id)).where(
                MessengerMessage.attempt_id == attempt_id, MessengerMessage.sender == "candidate"
            )
        )
    ).scalar() or 0
    if sent >= settings.messenger_max_per_attempt:
        raise HTTPException(429, f"이 시험에서 보낼 수 있는 메시지 한도({settings.messenger_max_per_attempt}건)에 도달했습니다")

    assessment = await db.get(Assessment, attempt.assessment_id)
    res = await ai_provider.resolve_ai(db, "chat", override_provider_id=assessment.npc_provider_id)
    if res is None or not res.configured:
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
        reply = await npc.generate_reply(res, scenario, character, list(history))
        meta: dict = {}
    except Exception as e:  # noqa: BLE001 — 오류는 코드·상관 ID 로만 남긴다 (ODY-022)
        reply = "(지금 자리를 비운 것 같습니다 — 잠시 후 다시 말을 걸어 보세요)"
        info = describe_error(e, where="npc")
        meta = {"error": info["code"], "correlation_id": info["correlation_id"]}

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
            payload={"character": character_key, "chars": len(reply), "error": meta.get("error")},
        )
    )
    await db.commit()
    await db.refresh(user_msg)
    await db.refresh(npc_msg)
    return [user_msg, npc_msg]

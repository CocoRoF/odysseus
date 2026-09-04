"""메신저 등장인물(NPC) 응답 생성.

시나리오의 '숨은 진실'(objectives_md)은 **NPC 에게 주어지지 않는다** (ODY-008). 각 인물은
자기 카드의 knowledge 만 알고, 그 범위 안에서 답한다 — 문제를 통째로 브리핑해 주는
순간 이 시험의 존재 이유가 사라지기 때문이다. 정답은 평가기(autoeval)만 본다.

보조 방어로, 응답에 objectives 의 문장이 그대로 들어 있으면 내보내기 전에 막는다
(leak_guard). 모델에 비밀이 없으니 평소엔 걸릴 일이 없고, 걸리면 회귀 신호다.

행동 규칙 자체는 :mod:`npc_prompt` 에 있다 (회사 맥락·태도 대응·역할 경계).
"""

import logging
import re

from ..config import settings
from ..models import MessengerMessage, Scenario
from . import provider
from .npc_prompt import build_system_prompt


def npc_system_prompt(scenario: Scenario, character: dict) -> str:
    colleagues = [
        c for c in (scenario.characters or []) if c.get("key") != character.get("key")
    ]
    return build_system_prompt(
        name=str(character.get("name") or "동료"),
        role=str(character.get("role") or ""),
        persona=str(character.get("persona") or ""),
        knowledge=str(character.get("knowledge") or ""),
        colleagues=colleagues,
    )


log = logging.getLogger("odysseus.npc")

# 조각으로 삼을 최소 길이 — 이보다 짧은 어구는 knowledge 와 겹치기 쉬워 오탐이 난다
_FRAGMENT_MIN = 18
_SPLIT = re.compile(r"[\n.。!?;:]+|\s[-•*]\s")


def _norm(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip().lower()


def secret_fragments(objectives: str) -> list[str]:
    """objectives 를 문장·항목 단위로 쪼개 정규화한 조각 — 응답에 그대로 나타나면 안 되는 것들."""
    out: list[str] = []
    for raw in _SPLIT.split(objectives or ""):
        frag = _norm(raw.lstrip("-•*# ").strip())
        if len(frag) >= _FRAGMENT_MIN and frag not in out:
            out.append(frag)
    return out


DEFLECTION = "그건 제가 말씀드릴 수 있는 부분이 아니에요. 필요한 건 담당자에게 직접 확인해 주세요."


def leak_guard(reply: str, objectives: str) -> tuple[str, bool]:
    """응답에 숨은 목표의 문장이 그대로 들어 있으면 (얼버무리는 문장, True) 를 돌려준다."""
    if not reply or not objectives:
        return reply, False
    hay = _norm(reply)
    for frag in secret_fragments(objectives):
        if frag in hay:
            return DEFLECTION, True
    return reply, False


def thread_to_messages(history: list[MessengerMessage]) -> list[dict]:
    """스레드 → LLM 메시지. candidate=user, npc=assistant.

    오프닝처럼 스레드가 NPC 메시지로 시작하면, '대화는 user로 시작'을 요구하는
    벤더 정규화(_clean_messages)가 앞부분을 잘라내므로 합성 user 턴을 앞에 깐다 —
    NPC가 자기 오프닝 메시지를 기억한 채 대화하게 하기 위함이다.
    """
    out: list[dict] = []
    for m in history[-settings.messenger_history_limit :]:
        role = "user" if m.sender == "candidate" else "assistant"
        out.append({"role": role, "content": m.content})
    if out and out[0]["role"] == "assistant":
        out.insert(0, {"role": "user", "content": "(상대가 대화방에 들어왔다)"})
    return out


async def generate_reply(
    res: provider.ResolvedAi,
    scenario: Scenario,
    character: dict,
    history: list[MessengerMessage],
) -> str:
    system = npc_system_prompt(scenario, character)
    messages = thread_to_messages(history)
    reply = await provider.complete_text(res, messages, system=system, max_tokens=1024)
    reply = (reply or "").strip()
    reply, leaked = leak_guard(reply, str(scenario.objectives_md or ""))
    if leaked:
        log.warning("npc leak guard tripped scenario=%s character=%s", getattr(scenario, "id", "?"), character.get("key"))
    return reply or "(응답이 비어 있습니다 — 잠시 후 다시 시도해 주세요)"

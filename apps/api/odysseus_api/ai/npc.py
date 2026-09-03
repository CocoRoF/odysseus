"""메신저 등장인물(NPC) 응답 생성.

시나리오의 '숨은 진실'(objectives)은 NPC 컨텍스트로만 흐르고, 각 인물은
자신의 knowledge 범위 안에서만 답하도록 강하게 지시된다 — 문제를 통째로
브리핑해 주는 순간 이 시험의 존재 이유가 사라지기 때문이다.

행동 규칙 자체는 :mod:`npc_prompt` 에 있다 (회사 맥락·태도 대응·역할 경계).
"""

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
        objectives=str(scenario.objectives_md or ""),
        colleagues=colleagues,
    )


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
    return (reply or "").strip() or "(응답이 비어 있습니다 — 잠시 후 다시 시도해 주세요)"

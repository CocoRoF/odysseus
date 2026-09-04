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
        base_rules=str(getattr(scenario, "npc_base_prompt", "") or ""),
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


def build_turn_message(character: dict, history: list[MessengerMessage]) -> str:
    """스레드 전체를 **하나의 user 메시지**로 만든다 — 이름 붙은 대화 기록 + 방금 온 메시지.

    왜 role 턴이 아니라 이 봉투인가: 공급자에 따라(Claude Code CLI 등) 이력이 어차피 한 메시지로
    평탄화되고, 그 형식("### Assistant")은 모델이 자기 발화를 자기 것으로 인식하지 못하게 한다.
    우리가 봉투를 직접 만들면 어떤 공급자든 같은 계약을 본다: 누가 무엇을 말했고, 지금 답해야 할
    메시지가 무엇인지가 분명하다. 시스템 프롬프트의 "방금 온 메시지에만 답한다" 가 이 봉투를 전제한다.
    """
    me = str(character.get("name") or "동료")
    recent = history[-settings.messenger_history_limit :]
    if not recent:
        return "[메신저 대화 — 지금까지]\n(아직 없음)\n\n[방금 상대가 보낸 메시지]\n(대화방에 들어왔다)"
    *earlier, last = recent
    lines = []
    for m in earlier:
        who = "상대" if m.sender == "candidate" else me
        lines.append(f"{who}: {m.content}")
    thread = "\n".join(lines) if lines else "(아직 없음)"
    if last.sender == "candidate":
        return f"[메신저 대화 — 지금까지]\n{thread}\n\n[방금 상대가 보낸 메시지]\n{last.content}"
    # 마지막이 내 말이면(오프닝 직후 등) 상대는 아직 아무 말도 하지 않은 것
    thread = thread + ("\n" if lines else "") + f"{me}: {last.content}"
    return f"[메신저 대화 — 지금까지]\n{thread}\n\n[방금 상대가 보낸 메시지]\n(대화방에 들어왔다)"


def thread_to_messages(history: list[MessengerMessage]) -> list[dict]:
    """(하위 호환) 스레드 → LLM 메시지 한 개. 봉투 형식은 build_turn_message 참조."""
    return [{"role": "user", "content": build_turn_message({"name": "동료"}, history)}]


async def generate_reply(
    res: provider.ResolvedAi,
    scenario: Scenario,
    character: dict,
    history: list[MessengerMessage],
) -> str:
    system = npc_system_prompt(scenario, character)
    messages = [{"role": "user", "content": build_turn_message(character, history)}]
    reply = await provider.complete_text(res, messages, system=system, max_tokens=1024)
    reply = (reply or "").strip()
    reply, leaked = leak_guard(reply, str(scenario.objectives_md or ""))
    if leaked:
        log.warning("npc leak guard tripped scenario=%s character=%s", getattr(scenario, "id", "?"), character.get("key"))
    return reply or "(응답이 비어 있습니다 — 잠시 후 다시 시도해 주세요)"

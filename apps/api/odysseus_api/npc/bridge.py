"""사무실 → 시험장 다리: 출근 전에 그 동료와 **직접 나눈 대화**를 시험 안의 같은 인물이 기억하게 한다.

시험을 시작하는 순간(:func:`npc.store.snapshot_relations`) 응시자가 사무실에서 실제로 말을 건 인물과의 1:1 대화를
응시에 얼려 둔다. 얼려 두는 이유는 둘이다. 시험 도중 사무실 기록이 바뀌어도 시험 속 인물의 기억은 그대로이고,
평가자가 나중에 "그 인물이 무엇을 기억하고 답했는가" 를 같은 자료로 볼 수 있다.

좁게 담는다:
  · 그 인물과의 **1:1 대화**만 담는다. 잡담 장면(ambient)·다른 인물과의 대화·요약 기억은 담지 않는다.
  · 응시자가 **한마디라도 건넨** 인물만 담는다. 말 걸기 창을 열기만 했다면 만난 것이 아니다.
  · 길이에 상한을 둔다. 최근 줄부터 담고, 줄마다·전체 글자 수를 자른다.

사무실 인물은 업무 정보를 말하지 않도록 따로 검토를 거친다(npc.generation). 그래서 이 대화에는 시험의 답이 없다.
응시자가 거기서 한 말은 확인되지 않은 주장으로 다룬다(ai.npc 의 OFFICE_RULE).

키가 `_` 로 시작하는 이유: 응시가 끝날 때 lifecycle 이 snapshot 을 다시 지으며 `_` 키(응시 메타데이터)만 옮긴다.
"""
from __future__ import annotations

from .contracts import npc_id

OFFICE_KEY = "_office"
VERSION = 2
#: 담는 최대 줄 수(응시자 말·인물 말 합쳐서, 최근 것부터)
TRANSCRIPT_LINES = 16
#: 줄 하나의 최대 글자 수
LINE_CHARS = 300
#: 전체 최대 글자 수. 넘으면 오래된 줄부터 뺀다.
TOTAL_CHARS = 2400


def freeze_transcript(events) -> list[dict]:
    """사무실 1:1 대화 이벤트(시간순) → [{"who": "candidate"|"npc", "text": …}] (상한 적용)."""
    lines = []
    for e in events:
        text = " ".join(str(getattr(e, "content", "") or "").split())[:LINE_CHARS]
        if not text:
            continue
        lines.append({"who": "candidate" if getattr(e, "kind", "") == "user_message" else "npc", "text": text})
    lines = lines[-TRANSCRIPT_LINES:]
    while lines and sum(len(line["text"]) for line in lines) > TOTAL_CHARS:
        lines.pop(0)
    return lines


def office_transcript(attempt, scenario_id, character: dict) -> list[dict]:
    """시험 속 이 인물이 기억하는 사무실 대화. 사무실에서 말을 나누지 않았으면 빈 목록."""
    bridge = (getattr(attempt, "snapshot", None) or {}).get(OFFICE_KEY) or {}
    if bridge.get("version") != VERSION:
        return []
    actor = (bridge.get("actors") or {}).get(npc_id(scenario_id, character)) or {}
    out = []
    for line in actor.get("transcript") or []:
        if not isinstance(line, dict) or line.get("who") not in ("candidate", "npc"):
            continue
        text = str(line.get("text") or "").strip()[:LINE_CHARS]
        if text:
            out.append({"who": line["who"], "text": text})
    return out[-TRANSCRIPT_LINES:]

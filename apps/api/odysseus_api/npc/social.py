"""Assessment recognition is presentation metadata, never task/grade prompt input."""
from .contracts import npc_id


def recognition(attempt, scenario, character, history):
    bridge = (attempt.snapshot or {}).get("office_relationships") or {}
    relation = (bridge.get("actors") or {}).get(npc_id(scenario.id, character)) or {}
    if bridge.get("version") != 1 or not relation.get("has_met"):
        return ""
    if any((m.meta or {}).get("office_social") for m in history):
        return ""
    # General social templates depend only on verified relationship booleans, not NPC names or roles.
    if relation.get("has_exchanged_greeting"):
        return "사무실에서 인사 나눴죠. 다시 뵈니 반갑네요."
    return "사무실에서 뵀던 분이네요. 다시 만나 반갑습니다."

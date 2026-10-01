"""사무실 장면(프리셋) — 시험의 방이 어떤 모양인가.

방 하나의 설계도(장면)는 웹의 `components/office/scenes.ts` 와 **같은 모양의 JSON** 이다. 기본 아홉은
웹 코드에 있고, 관리자가 만든 것은 `office_presets.spec` 에 산다. API 는 장면의 기하(겹침·도달)까지
검사하지 않는다 — 그것은 편집기와 사무실이 쓰는 TS 검증기(scene-check.ts)의 몫이고, 여기서는 **구조**
(크기·범위·개수)만 지킨다. 그래서 잘못된 장면이 들어와도 사무실은 기본 장면으로 돌아갈 뿐 죽지 않는다.

장면 참조(assessments.office_preset, 분야 기본값)는 세 가지다:
  ""             자동 — 분야에서 고른다(층 안에서 겹치지 않게)
  "builtin:<id>" 웹 코드의 기본 장면
  "<uuid>"       관리자 프리셋
"""

from __future__ import annotations

import uuid

#: 웹의 기본 장면 id — scenes.ts 의 SCENES 키와 같아야 한다 (tests/unit/test_office_presets.py 가 맞대 본다)
BUILTIN_SCENES: tuple[str, ...] = (
    "breakroom",
    "whiteboard",
    "coffee",
    "lounge",
    "printer",
    "board",
    "meeting",
    "standing",
    "server",
)

#: 방 하나(=시험 하나)가 감당할 크기 — 웹의 apps/web/lib/assessment-limits.ts 와 같아야 한다
#: (tests/unit/test_assessment_limits.py 가 맞대 본다).
#:
#: 시나리오를 여럿 묶으면 그 인물이 전부 한 방에 서서 방이 사람으로 꽉 찬다. 그래서 두 군데서 막는다:
#: 시험에 넣는 시나리오 수와, 방에 세우는 동료 수.
MAX_SCENARIOS_PER_ASSESSMENT = 1
MAX_COLLEAGUES = 6


def pick_colleagues(character_lists, limit: int = MAX_COLLEAGUES) -> list[dict]:
    """방에 세울 인물 — 시나리오 순서대로 모으고 key 로 한 번만 세며, limit 명에서 멈춘다.

    여러 시나리오에 같은 인물이 나오면 방에 두 번 서지 않는다. 넘치는 인물은 방에 세우지 않을 뿐 응시(메신저)에는
    그대로 나온다. 반환은 원본 인물 dict 이다 — 무엇을 화면에 실을지는 부르는 쪽(OfficeColleague)이 정한다.
    """
    picked: dict[str, dict] = {}
    for characters in character_lists:
        for c in characters or []:
            key = str((c or {}).get("key") or "").strip()
            if not key or key in picked:
                continue
            if len(picked) >= limit:
                return list(picked.values())
            picked[key] = c
    return list(picked.values())

#: 장면 크기 허용 범위 — scenes.ts 의 SCENE_LIMITS 와 같다
SCENE_LIMITS = {"min_cols": 6, "max_cols": 20, "min_rows": 5, "max_rows": 14}

OFFICE_SETTING_KEY = "office"
OFFICE_DEFAULTS: dict = {"defaults": {}}

BUILTIN_PREFIX = "builtin:"


def parse_ref(ref: str | None) -> tuple[str, str]:
    """장면 참조 → (종류, 값). 종류는 "" | "builtin" | "custom". 모르는 모양이면 ("", "")."""
    ref = (ref or "").strip()
    if not ref:
        return "", ""
    if ref.startswith(BUILTIN_PREFIX):
        name = ref[len(BUILTIN_PREFIX) :]
        return ("builtin", name) if name in BUILTIN_SCENES else ("", "")
    try:
        return "custom", str(uuid.UUID(ref))
    except ValueError:
        return "", ""


def stamp_scene(spec: dict | None, scene_id: str, label: str) -> dict:
    """저장된 spec 에 장면의 id·이름을 새긴다 — 웹은 spec.id 로 장면을 구별하고(같은 장면이 한 층에 두 번이면 거울),
    spec.label 을 문패에 쓴다. 관리자 프리셋은 uuid, 고친 템플릿은 템플릿 id 를 쓴다."""
    out = dict(spec or {})
    out["id"] = scene_id
    out["label"] = label
    return out


def is_valid_ref(ref: str | None) -> bool:
    return not (ref or "").strip() or parse_ref(ref)[0] != ""


def resolve_ref(assessment_ref: str | None, category: str | None, defaults: dict | None) -> str:
    """시험에 정한 것이 먼저, 없으면 분야 기본값, 그것도 없으면 자동("")."""
    kind, value = parse_ref(assessment_ref)
    if kind == "builtin":
        return BUILTIN_PREFIX + value
    if kind == "custom":
        return value
    kind, value = parse_ref((defaults or {}).get(category or "", ""))
    if kind == "builtin":
        return BUILTIN_PREFIX + value
    if kind == "custom":
        return value
    return ""

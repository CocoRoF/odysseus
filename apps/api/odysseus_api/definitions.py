"""Immutable assessment definitions bound to an attempt.

Editable Scenario/Assessment/AiProvider rows are authoring state. An attempt reads a canonical JSON
snapshot captured at start, so later edits cannot change the problem, grading rules, model choice, or
sampling limits of a historical/in-progress candidate.
"""

from __future__ import annotations

import copy
import hashlib
import json
import uuid
from dataclasses import dataclass, replace
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from .config import MAX_RUN_TIMEOUT_S, MIN_RUN_TIMEOUT_S
from .desktop import allowed_desktop_apps
from .models import AiProvider, Assessment, AssessmentScenario, Attempt, Scenario
from .requirements_graph import build_requirement_graph

DEFINITION_KEY = "_definition"
DEFINITION_HASH_KEY = "_definition_hash"
#: v5 는 시나리오별 실행 제한 시간(run_timeout_s)을 더했다. v1~v4 스냅샷은 그 키가 없고,
#: 없으면 전역 기본을 쓰므로 과거 응시의 실행 조건은 그대로다.
DEFINITION_VERSION = 5


def _json_copy(value: Any) -> Any:
    return json.loads(json.dumps(value, ensure_ascii=False, default=str))


def canonical_hash(value: dict) -> str:
    payload = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def scenario_to_spec(scenario: Scenario, *, ordinal: int, points: int) -> dict:
    from .npc.contracts import npc_id
    from .avatar_alloc import allocate
    characters = _json_copy(scenario.characters or [])
    avatars = allocate(characters)
    for character in characters:
        character["npc_id"] = npc_id(scenario.id, character)
        if not character.get("avatar_preset"):
            character["avatar_preset"] = avatars.get(character.get("key"), "")
    checks = _json_copy(scenario.checks or [])
    rubric = _json_copy(scenario.rubric or {})
    return {
        "scenario_id": str(scenario.id),
        "ordinal": int(ordinal),
        "points": int(points),
        "title": scenario.title,
        "summary": scenario.summary,
        "difficulty": scenario.difficulty,
        "briefing_md": scenario.briefing_md,
        "characters": characters,
        "opening_messages": _json_copy(scenario.opening_messages or []),
        "initial_files": _json_copy(scenario.initial_files or []),
        "objectives_md": scenario.objectives_md,
        "npc_base_prompt": scenario.npc_base_prompt,
        "npc_policy_version": 1,
        "checks": checks,
        "rubric": rubric,
        "desktop_apps": allowed_desktop_apps(scenario.desktop_apps or []),
        "run_timeout_s": int(scenario.run_timeout_s or 0),
        "requirement_graph": build_requirement_graph(
            objectives_md=scenario.objectives_md,
            characters=characters,
            checks=checks,
            rubric=rubric,
        ),
        "agent_enabled": bool(scenario.agent_enabled),
    }


async def _provider_profile(db: AsyncSession, provider_id_value: uuid.UUID | None) -> dict | None:
    """Freeze non-secret behavior. Credentials stay in encrypted AiProvider storage and are read live."""
    if not provider_id_value:
        return None
    row = await db.get(AiProvider, provider_id_value)
    if not row:
        return None
    return {
        "id": str(row.id),
        "name": row.name,
        "provider": row.provider,
        "model": row.model,
        "base_url": row.base_url,
        "temperature": float(row.temperature),
        "max_tokens": int(row.max_tokens),
    }


async def build_assessment_definition(db: AsyncSession, assessment: Assessment) -> dict:
    links = (
        await db.execute(
            select(AssessmentScenario)
            .where(AssessmentScenario.assessment_id == assessment.id)
            .options(selectinload(AssessmentScenario.scenario))
            .order_by(AssessmentScenario.ordinal)
        )
    ).scalars().all()
    spec = {
        "version": DEFINITION_VERSION,
        "assessment_id": str(assessment.id),
        "title": assessment.title,
        "description": assessment.description,
        "duration_min": int(assessment.duration_min),
        "agent_max_turns": int(assessment.agent_max_turns),
        "messenger_max_per_attempt": int(assessment.messenger_max_per_attempt or 0),
        "npc_provider_id": str(assessment.npc_provider_id) if assessment.npc_provider_id else None,
        "agent_provider_id": str(assessment.agent_provider_id) if assessment.agent_provider_id else None,
        "provider_profiles": {
            "npc": await _provider_profile(db, assessment.npc_provider_id),
            "agent": await _provider_profile(db, assessment.agent_provider_id),
        },
        "starts_at": assessment.starts_at.isoformat() if assessment.starts_at else None,
        "ends_at": assessment.ends_at.isoformat() if assessment.ends_at else None,
        "scenarios": [
            scenario_to_spec(link.scenario, ordinal=link.ordinal, points=link.points)
            for link in links
            if link.scenario is not None
        ],
    }
    # One explicitly linked person keeps the first office appearance across scenario roles.
    appearances = {}
    for scenario in spec["scenarios"]:
        for character in scenario["characters"]:
            identity = character["npc_id"]
            appearances.setdefault(identity, character["avatar_preset"])
            character["avatar_preset"] = appearances[identity]
    spec["definition_hash"] = canonical_hash(spec)
    return spec


def bind_definition(attempt: Attempt, definition: dict) -> None:
    snap = dict(attempt.snapshot or {})
    snap[DEFINITION_KEY] = _json_copy(definition)
    snap[DEFINITION_HASH_KEY] = str(definition.get("definition_hash") or canonical_hash(definition))
    attempt.snapshot = snap


async def definition_for_attempt(
    db: AsyncSession, attempt: Attempt, *, persist_legacy: bool = True
) -> dict:
    snap = attempt.snapshot or {}
    frozen = snap.get(DEFINITION_KEY)
    if isinstance(frozen, dict) and frozen.get("scenarios") is not None:
        return _json_copy(frozen)
    assessment = await db.get(Assessment, attempt.assessment_id)
    if not assessment:
        raise LookupError("assessment not found for attempt")
    definition = await build_assessment_definition(db, assessment)
    bind_definition(attempt, definition)
    if persist_legacy:
        await db.commit()
    return definition


@dataclass(slots=True)
class FrozenScenario:
    id: uuid.UUID
    title: str
    summary: str
    difficulty: str
    briefing_md: str
    characters: list
    opening_messages: list
    initial_files: list
    objectives_md: str
    npc_base_prompt: str
    checks: list
    rubric: dict
    requirement_graph: dict
    agent_enabled: bool
    desktop_apps: list
    ordinal: int
    points: int
    npc_policy_version: int = 0
    #: 명령 하나의 제한 시간(초). 0 이면 전역 기본 — v1~v3 스냅샷에는 이 키가 없다.
    run_timeout_s: int = 0


def scenario_from_definition(definition: dict, scenario_id: uuid.UUID | str) -> FrozenScenario | None:
    sid = str(scenario_id)
    for spec in definition.get("scenarios") or []:
        if str(spec.get("scenario_id")) != sid:
            continue
        characters = copy.deepcopy(spec.get("characters") or [])
        checks = copy.deepcopy(spec.get("checks") or [])
        rubric = copy.deepcopy(spec.get("rubric") or {})
        requirement_graph = copy.deepcopy(spec.get("requirement_graph") or {})
        # v1/v2 snapshots remain evaluable. Derive the graph deterministically from their frozen data,
        # never from the current editable Scenario row.
        if not requirement_graph:
            requirement_graph = build_requirement_graph(
                objectives_md=str(spec.get("objectives_md") or ""),
                characters=characters,
                checks=checks,
                rubric=rubric,
            )
        return FrozenScenario(
            id=uuid.UUID(sid),
            title=str(spec.get("title") or ""),
            summary=str(spec.get("summary") or ""),
            difficulty=str(spec.get("difficulty") or "medium"),
            briefing_md=str(spec.get("briefing_md") or ""),
            characters=characters,
            opening_messages=copy.deepcopy(spec.get("opening_messages") or []),
            initial_files=copy.deepcopy(spec.get("initial_files") or []),
            objectives_md=str(spec.get("objectives_md") or ""),
            npc_base_prompt=str(spec.get("npc_base_prompt") or ""),
            checks=checks,
            rubric=rubric,
            requirement_graph=requirement_graph,
            agent_enabled=bool(spec.get("agent_enabled", True)),
            # v1/v2 스냅샷에는 이 키가 없다 — 그때의 화면과 같도록 전부 제공한다.
            desktop_apps=allowed_desktop_apps(spec.get("desktop_apps") or []),
            ordinal=int(spec.get("ordinal", 0) or 0),
            points=int(spec.get("points", 0) or 0),
            npc_policy_version=int(spec.get("npc_policy_version", 0)),
            run_timeout_s=int(spec.get("run_timeout_s", 0) or 0),
        )
    return None


def run_timeout_for(scenario: "FrozenScenario | None") -> int:
    """이 시나리오에서 명령 하나가 돌 수 있는 초 — 응시 시작 시점의 값으로 고정된다.

    시나리오가 정하지 않았으면(0) 전역 기본을 쓴다. 러너도 자기 상한(MAX_TIMEOUT_S)으로 한 번 더
    자르므로 여기서 넘겨도 위험하지 않지만, 응시자에게 안내하는 값과 실제가 달라지지 않도록
    같은 상한을 여기서도 적용한다.
    """
    from .config import settings

    value = int(getattr(scenario, "run_timeout_s", 0) or 0) or int(settings.run_timeout_s)
    return max(MIN_RUN_TIMEOUT_S, min(value, MAX_RUN_TIMEOUT_S))


#: 응시 메타데이터 키 — `_` 로 시작해야 lifecycle._snapshot 이 종료 때 보존한다.
GRANTS_KEY = "_grants"


def grants_of(attempt: Attempt) -> dict:
    """관리자가 이 응시에 얹어 준 보정. 없으면 빈 값.

    보정은 동결된 정의(`_definition`)를 고치지 않고 **따로** 쌓는다. 정의를 직접 손대면
    "이 응시가 어떤 문제였나" 의 정본이 흔들리고, 무엇이 원래 조건이고 무엇이 구제였는지
    나중에 구분할 수 없다.
    """
    value = (attempt.snapshot or {}).get(GRANTS_KEY)
    return value if isinstance(value, dict) else {}


def _granted(attempt: Attempt, key: str) -> int:
    try:
        return max(0, int(grants_of(attempt).get(key) or 0))
    except (TypeError, ValueError):
        return 0


def granted_agent_turns(attempt: Attempt) -> int:
    return _granted(attempt, "agent_turns")


def granted_messenger_turns(attempt: Attempt) -> int:
    return _granted(attempt, "messenger_turns")


def granted_minutes(attempt: Attempt) -> int:
    """마감에 이미 더해진 연장(분) — 기록용이다. 실제 마감은 ``Attempt.deadline_at`` 하나가 정본이다."""
    return _granted(attempt, "extra_minutes")


def agent_turn_limit(definition: dict, attempt: Attempt) -> int:
    """이 응시의 에이전트 질문 한도 — 동결된 정의 + 관리자가 얹어 준 보정.

    에이전트가 애초에 꺼진 시험(0)에는 보정이 열어 주지 않는다 — 시험의 성격을 바꾸는 것은
    보정이 아니다. 보정 요청 자체도 그 경우 거부된다(routers/resources.grant_attempt).
    """
    base = int(definition.get("agent_max_turns", 0) or 0)
    return base + granted_agent_turns(attempt) if base > 0 else 0


def messenger_cap(definition: dict) -> int:
    """이 시험이 정한 NPC 메시지 총량 — 응시 시작 시점의 값으로 고정된다.

    시험이 정하지 않았으면(0, 그리고 이 키가 없던 옛 스냅샷) 전역 기본을 쓴다.
    """
    from .config import settings

    return int(definition.get("messenger_max_per_attempt") or 0) or int(settings.messenger_max_per_attempt)


def messenger_turn_limit(definition: dict, attempt: Attempt) -> int:
    """이 응시의 메신저 한도 — 동결된 시험 값 + 관리자가 얹어 준 보정."""
    return messenger_cap(definition) + granted_messenger_turns(attempt)


async def scenario_run_timeout(
    db: AsyncSession, attempt_id: uuid.UUID, scenario_id: uuid.UUID
) -> int:
    """응시·시나리오로 제한 시간을 찾는다 — 시나리오를 손에 들고 있지 않은 호출부용.

    응시나 정의를 못 찾으면 전역 기본으로 떨어진다. 제한 시간을 못 읽었다고 실행을 막으면
    복구 경로(queue_recovery)가 통째로 멈추므로, 여기서는 조용히 기본값을 쓴다.
    """
    attempt = await db.get(Attempt, attempt_id)
    if attempt is None:
        return run_timeout_for(None)
    definition = await definition_for_attempt(db, attempt, persist_legacy=False)
    return run_timeout_for(scenario_from_definition(definition, scenario_id))


def provider_id(definition: dict, key: str) -> uuid.UUID | None:
    value = definition.get(key)
    if not value:
        return None
    try:
        return uuid.UUID(str(value))
    except ValueError:
        return None


async def resolve_attempt_ai(db: AsyncSession, definition: dict, role: str):
    """Resolve credentials live but apply the non-secret model/runtime settings frozen at attempt start."""
    from .ai import provider as ai_provider

    id_key = "npc_provider_id" if role == "npc" else "agent_provider_id"
    frozen_id = provider_id(definition, id_key)
    if frozen_id:
        row = await db.get(AiProvider, frozen_id)
        if not row or not row.enabled:
            return None
        resolved = ai_provider.resolved_from_row(row)
    else:
        resolved = await ai_provider.resolve_ai(db, "chat")
    if resolved is None:
        return None
    profile = (definition.get("provider_profiles") or {}).get(role)
    if not isinstance(profile, dict):
        return resolved
    return replace(
        resolved,
        provider=str(profile.get("provider") or resolved.provider),
        model=str(profile.get("model") or resolved.model),
        base_url=profile.get("base_url") or resolved.base_url,
        temperature=float(profile.get("temperature", resolved.temperature)),
        max_tokens=int(profile.get("max_tokens", resolved.max_tokens)),
        name=str(profile.get("name") or resolved.name),
    )


def definition_summary(snapshot: dict | None) -> tuple[str | None, str | None]:
    snap = snapshot or {}
    definition = snap.get(DEFINITION_KEY)
    if not isinstance(definition, dict):
        return None, None
    return str(definition.get("title") or "") or None, str(snap.get(DEFINITION_HASH_KEY) or "") or None

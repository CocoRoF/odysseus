"""Structured requirement graph for Odysseus scenarios.

Scenario authoring historically stored the hidden truth as free-form `objectives_md`, coworker
`knowledge`, and checks. This module turns those fields into stable, auditable requirement atoms at
attempt-start time without breaking existing scenario JSON or requiring a data migration.

Authors may provide explicit `rubric.requirements`; otherwise a conservative graph is derived from
objective lines. Derived source/check links are heuristic and marked as such. Explicit links always
win.
"""

from __future__ import annotations

import hashlib
import re
from typing import Any

_TOKEN_RE = re.compile(r"[A-Za-z0-9가-힣_]{2,}")
_SENTENCE_RE = re.compile(r"(?:\r?\n)+|(?<=[.!?。])\s+")
_BULLET_RE = re.compile(r"^\s*(?:[-*+]\s+|\d+[.)]\s+|#{1,6}\s*)")
_STOP = {
    "그리고", "또한", "대한", "위해", "있는", "한다", "해야", "것은", "경우", "결과", "파일",
    "the", "and", "for", "with", "from", "that", "this", "should", "must",
}


def _tokens(text: str) -> set[str]:
    return {t.lower() for t in _TOKEN_RE.findall(text or "") if t.lower() not in _STOP}


def _overlap(a: str, b: str) -> float:
    ta, tb = _tokens(a), _tokens(b)
    if not ta or not tb:
        return 0.0
    return len(ta & tb) / max(1, min(len(ta), len(tb)))


def _stable_id(prefix: str, text: str, ordinal: int) -> str:
    digest = hashlib.sha256(text.encode("utf-8", errors="replace")).hexdigest()[:10]
    return f"{prefix}-{ordinal + 1}-{digest}"


def _objective_lines(text: str) -> list[str]:
    lines: list[str] = []
    for raw in _SENTENCE_RE.split(text or ""):
        value = _BULLET_RE.sub("", raw).strip()
        if not value or len(value) < 4:
            continue
        if value.startswith("```"):
            continue
        lines.append(value[:1000])
    # Keep graph bounded even if an author pastes a very long spec.
    return lines[:40]


def _knowledge_facts(characters: list[dict]) -> list[dict]:
    facts: list[dict] = []
    for character in characters or []:
        key = str(character.get("key") or "")
        if not key:
            continue
        for i, raw in enumerate(_SENTENCE_RE.split(str(character.get("knowledge") or ""))):
            statement = raw.strip()
            if len(statement) < 4:
                continue
            facts.append(
                {
                    "id": _stable_id(f"fact-{key}", statement, i),
                    "type": "npc",
                    "character_key": key,
                    "statement": statement[:1000],
                }
            )
    return facts[:160]


def _explicit_requirements(rubric: dict) -> list[dict] | None:
    raw = (rubric or {}).get("requirements")
    if not isinstance(raw, list) or not raw:
        return None
    out: list[dict] = []
    for i, item in enumerate(raw[:40]):
        if isinstance(item, str):
            statement = item.strip()
            data: dict[str, Any] = {}
        elif isinstance(item, dict):
            statement = str(item.get("statement") or item.get("name") or "").strip()
            data = item
        else:
            continue
        if not statement:
            continue
        sources = data.get("discoverable_from") if isinstance(data.get("discoverable_from"), list) else []
        checks = data.get("validated_by") if isinstance(data.get("validated_by"), list) else []
        out.append(
            {
                "id": str(data.get("id") or _stable_id("req", statement, i))[:100],
                "statement": statement[:1000],
                "critical": bool(data.get("critical", False)),
                "weight": max(0.0, float(data.get("weight", 1) or 1)),
                "discoverable_from": sources[:20],
                "validated_by": [str(v)[:100] for v in checks[:20]],
                "link_mode": "explicit",
            }
        )
    return out or None


def build_requirement_graph(*, objectives_md: str, characters: list[dict], checks: list[dict], rubric: dict) -> dict:
    """Return a stable graph suitable for freezing in an Attempt definition."""
    facts = _knowledge_facts(characters)
    explicit = _explicit_requirements(rubric or {})
    if explicit is not None:
        return {"version": 1, "requirements": explicit, "knowledge_facts": facts, "mode": "explicit"}

    requirements: list[dict] = []
    for i, statement in enumerate(_objective_lines(objectives_md)):
        source_candidates = sorted(
            (
                (_overlap(statement, fact["statement"]), fact)
                for fact in facts
            ),
            key=lambda pair: pair[0],
            reverse=True,
        )
        sources = [
            {"type": "npc", "character_key": fact["character_key"], "fact_id": fact["id"]}
            for score, fact in source_candidates[:3]
            if score >= 0.20
        ]

        check_candidates = sorted(
            (
                (_overlap(statement, str(check.get("label") or "")), idx, check)
                for idx, check in enumerate(checks or [])
            ),
            key=lambda row: row[0],
            reverse=True,
        )
        linked_checks = [
            f"check-{idx + 1}"
            for score, idx, _check in check_candidates[:3]
            if score >= 0.20
        ]
        linked_points = sum(
            float((checks or [])[int(cid.split("-")[-1]) - 1].get("points", 0) or 0)
            for cid in linked_checks
        )
        requirements.append(
            {
                "id": _stable_id("req", statement, i),
                "statement": statement,
                "critical": linked_points >= 20,
                "weight": linked_points or 1.0,
                "discoverable_from": sources,
                "validated_by": linked_checks,
                "link_mode": "derived",
            }
        )

    check_nodes = [
        {
            "id": f"check-{i + 1}",
            "label": str(c.get("label") or f"check {i + 1}"),
            "type": str(c.get("type") or ""),
            "points": float(c.get("points", 0) or 0),
        }
        for i, c in enumerate(checks or [])
    ]
    return {
        "version": 1,
        "requirements": requirements,
        "knowledge_facts": facts,
        "checks": check_nodes,
        "mode": "derived",
    }


def graph_metrics(graph: dict, *, contacted_characters: set[str], passed_check_ids: set[str]) -> dict:
    requirements = graph.get("requirements") or []
    if not requirements:
        return {
            "requirement_count": 0,
            "source_contact_pct": None,
            "validation_pct": None,
            "critical_validation_pct": None,
        }

    discovery_weight = validation_weight = critical_weight = 0.0
    discovered = validated = critical_validated = 0.0
    for req in requirements:
        weight = max(0.0, float(req.get("weight", 1) or 1))
        sources = req.get("discoverable_from") or []
        source_chars = {
            str(src.get("character_key"))
            for src in sources
            if isinstance(src, dict) and src.get("type") == "npc" and src.get("character_key")
        }
        if source_chars:
            discovery_weight += weight
            if source_chars & contacted_characters:
                discovered += weight

        links = {str(v) for v in (req.get("validated_by") or [])}
        if links:
            validation_weight += weight
            if links.issubset(passed_check_ids):
                validated += weight
            if req.get("critical"):
                critical_weight += weight
                if links.issubset(passed_check_ids):
                    critical_validated += weight

    pct = lambda n, d: round(n / d * 100.0, 2) if d > 0 else None
    return {
        "requirement_count": len(requirements),
        "source_contact_pct": pct(discovered, discovery_weight),
        "validation_pct": pct(validated, validation_weight),
        "critical_validation_pct": pct(critical_validated, critical_weight),
        "contacted_characters": sorted(contacted_characters),
        "passed_check_ids": sorted(passed_check_ids),
        "graph_mode": graph.get("mode"),
    }

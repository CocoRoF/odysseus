"""Bounded generation and independent validation; nothing streams before acceptance."""
from __future__ import annotations

import asyncio
import json
import time

from ..ai import provider
from ..config import settings
from .contracts import DialogueDraft, DraftTurn, ReviewResult
from .policy import BOUNDARY_REPLY, POLICY_VERSION, REVIEW_SYSTEM, SYSTEM, parse_json, validate_draft


async def measured(res, prompt, system, output_limit):
    start = time.monotonic()
    raw, usage = await asyncio.wait_for(provider.complete_with_usage(res, [{"role": "user", "content": prompt}],
        system=system, max_tokens=output_limit), timeout=settings.office_llm_timeout_s)
    # Provider usage is not exposed by every adapter. Unknown is deliberately not zero.
    return raw, {"latency_ms": round((time.monotonic()-start)*1000), "model": res.model,
                 "provider": res.provider, "input_chars": len(prompt)+len(system),
                 "output_chars": len(raw), "output_limit": output_limit, "token_usage": usage.get("usage"),
                 "finish_reason": usage.get("finish_reason")}


async def generate(res, context, actor_ids, mode):
    prompt = json.dumps(context, ensure_ascii=False, separators=(",", ":"))
    if len(prompt) > settings.office_input_chars:
        raise ValueError("context_budget")
    metrics = []
    draft = None
    for _ in range(2):
        raw, metric = await measured(res, prompt, SYSTEM, 600 if mode == "user" else 950)
        metrics.append(metric)
        try:
            draft = validate_draft(raw, actor_ids, context["facts"], mode)
            trigger = context.get("trigger") or {}
            if mode == "ambient" and trigger.get("kind", "scenario") == "scenario" and trigger.get("fact_ids"):
                cited = {f for turn in draft.turns for f in turn.fact_ids}
                if not cited.intersection(trigger["fact_ids"]):
                    raise ValueError("scenario_grounding")
            break
        except (ValueError, TypeError):
            draft = None
            continue
    if draft is None:
        raise ValueError("invalid_output")
    gate_input = json.dumps({"context": context, "draft": draft.model_dump()}, ensure_ascii=False)
    # 검토도 초안처럼 한 번은 다시 묻는다 — 검토 답이 형식을 벗어났다고 대화 전체를 떨어뜨리지 않는다
    review = None
    for _ in range(2):
        raw_review, metric = await measured(res, gate_input, REVIEW_SYSTEM, 180)
        metrics.append(metric)
        try:
            review = ReviewResult.model_validate(parse_json(raw_review))
            break
        except (ValueError, TypeError):
            review = None
    if review is None:
        raise ValueError("invalid_output")
    if not review.safe or review.reason != "ok":
        if mode == "ambient":
            raise ValueError("public_scope")
        draft = DialogueDraft(turns=[DraftTurn(speaker_id=actor_ids[0], text=BOUNDARY_REPLY)])
    if not review.memory_safe or not review.safe:
        draft.memory = ""
        draft.greeted = False
    return draft, {"policy_version": POLICY_VERSION, "calls": metrics, "guard": review.reason}

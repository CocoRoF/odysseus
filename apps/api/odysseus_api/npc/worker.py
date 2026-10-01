"""Durable office AI worker: python -m odysseus_api.npc.worker.

PostgreSQL leases fence commits across replicas. This is separate from the code runner and API.
"""
from __future__ import annotations

import asyncio
import json
import logging
import signal
import uuid
from datetime import timedelta
from pathlib import Path

from fastapi import HTTPException
from sqlalchemy import func, or_, select, text

from ..ai import provider
from ..config import settings
from ..db import SessionLocal, engine
from ..models import (OfficeConversation, OfficeEvent, OfficeJob, OfficeMemory, OfficeWorld, User, utcnow)
from ..secrets import install_encrypted_types
from . import cache
from .contracts import OfficeProjection
from .generation import generate
from .policy import public_context
from .public import assessment_access
from .store import (active_ambient, add_event, context_memory, reserve_budget,
                    office_provider_selection, provider_blocked, ambient_counts, user_talking, world_scope, private_history)

log = logging.getLogger("odysseus.office")


async def schedule_ambient():
    if not settings.office_ambient_enabled or not settings.office_dialogue_enabled:
        return
    async with SessionLocal() as db:
        now = utcnow()
        worlds = (await db.scalars(select(OfficeWorld).where(OfficeWorld.last_seen_at > now-timedelta(seconds=18),
            OfficeWorld.next_ambient_at <= now).order_by(OfficeWorld.next_ambient_at).limit(10)
            .with_for_update(skip_locked=True))).all()
        for world in worlds:
            if await user_talking(db, world) or await active_ambient(db, world):
                # Short retry keeps dispatch fair without imposing a fresh minute of silence.
                world.next_ambient_at = now+timedelta(seconds=3)
                continue
            if await db.scalar(select(OfficeJob.id).where(OfficeJob.world_id == world.id,
                    OfficeJob.kind == "user", OfficeJob.status.in_(["queued", "running"])).limit(1)):
                world.next_ambient_at = now+timedelta(seconds=3)
                continue
            # A paused/private conversation must not keep pushing the next turn away.
            world.next_ambient_at = now+timedelta(seconds=settings.office_ambient_interval_s)
            user = await db.get(User, world.user_id)
            if not user or not user.is_active:
                continue
            try:
                await assessment_access(db, user, world.assessment_id)
            except HTTPException:
                continue
            projection = OfficeProjection.model_validate(world.projection)
            actors = {a.id: a for a in projection.actors}
            counts = await ambient_counts(db, world)
            pairs = [p for p in world.presence.get("pairs", []) if len(p) == 2 and len(set(p)) == 2 and
                     all(x in actors and counts.get(x, 0) < actors[x].max_conversations for x in p)]
            if not pairs:
                world.next_ambient_at = now+timedelta(seconds=3)
                continue
            recent = (await db.scalars(select(OfficeConversation).where(OfficeConversation.world_id.in_(world_scope(world)),
                OfficeConversation.mode == "ambient").order_by(OfficeConversation.created_at.desc()))).all()
            pairs.sort(key=lambda p: sum(set(c.participants) == set(p) for c in recent))
            spoken = (await db.execute(select(OfficeConversation.topic_id, func.count(func.distinct(OfficeEvent.conversation_id)))
                .join(OfficeEvent, OfficeEvent.conversation_id == OfficeConversation.id)
                .where(OfficeEvent.world_id.in_(world_scope(world)), OfficeEvent.kind == "ambient_line")
                .group_by(OfficeConversation.topic_id))).all()
            topic_counts = dict(spoken)
            exchanges = sum(counts.values()) // 2

            def topic_for(pair):
                context = public_context(projection, pair)
                topics = context["topics"] or [{"id": "social", "intent": "공개된 공간과 일상에 대해 짧게 안부를 주고받는다", "fact_ids": [], "kind": "daily"}]
                # Two scenario exchanges for each daily one when both are authored.
                desired = "daily" if exchanges % 3 == 2 else "scenario"
                preferred = [t for t in topics if t.get("kind", "scenario") == desired]
                topics = preferred or topics
                topics.sort(key=lambda t: (topic_counts.get(t["id"], 0), t["id"]))
                return topics[0]

            # 처음 잡담하는 짝이면 다른 세계에서 공개 설정만으로 만든 대본을 쓸 수 있다(npc/cache.py) — 공급자를 부르지
            # 않으니 공급자 차단·호출 예산 검사보다 앞에 둔다. 주제는 평소 고르기 그대로다.
            chosen = await cache.choose(db, world, projection, pairs, topic_for, exchanges)
            if chosen is not None:
                pair, topic, entry = chosen
                conv = OfficeConversation(id=uuid.uuid4(), world_id=world.id, actor_id=None,
                    mode="ambient", participants=pair, status="queued", topic_id=topic["id"], state={})
                db.add(conv)
                await db.flush()
                cache.replay(db, world, conv, entry, now)
                continue
            try:
                selection = await office_provider_selection(db)
                if await provider_blocked(db, selection):
                    continue
                await reserve_budget(db, world)
            except HTTPException:
                continue
            pair = pairs[0]
            topic = topic_for(pair)
            conv = OfficeConversation(id=uuid.uuid4(), world_id=world.id, actor_id=None,
                mode="ambient", participants=pair, status="queued", topic_id=topic["id"], state={})
            db.add(conv)
            await db.flush()
            job = OfficeJob(id=uuid.uuid4(), world_id=world.id, conversation_id=conv.id, request_id=uuid.uuid4(),
                kind="ambient", priority=10, payload={"topic": topic, "tab_id": world.presence.get("tab_id"),
                "through_sequence": world.sequence,
                **selection},
                deadline_at=now+timedelta(seconds=settings.office_job_timeout_s), budget_tokens=settings.office_token_reservation)
            db.add(job)
            add_event(db, world, conv, "ambient_start", meta={"participants": pair})
        await db.commit()


async def claim_job():
    async with SessionLocal() as db:
        # Short dispatch lock protects global/provider capacity across worker replicas.
        await db.execute(text("SELECT pg_advisory_xact_lock(74890322)"))
        now = utcnow()
        running = (await db.scalars(select(OfficeJob).where(OfficeJob.status == "running",
            OfficeJob.lease_until > now))).all()
        if len(running) >= settings.office_worker_concurrency:
            return None
        candidates = (await db.scalars(select(OfficeJob).join(OfficeConversation).where(
                or_(OfficeJob.kind == "user", OfficeConversation.status != "paused"),
                or_(OfficeJob.status == "queued",
                (OfficeJob.status == "running") & (OfficeJob.lease_until <= now)))
            .order_by(OfficeJob.priority, OfficeJob.created_at).limit(30).with_for_update(skip_locked=True))).all()
        for job in candidates:
            if job.kind == "ambient":
                conv = await db.get(OfficeConversation, job.conversation_id)
                world = await db.get(OfficeWorld, job.world_id)
                if conv.status == "paused" or await user_talking(db, world):
                    continue
            key = job.payload.get("provider_id")
            if sum(j.payload.get("provider_id") == key for j in running) >= settings.office_provider_concurrency:
                continue
            # Reserve at least one office slot for user-initiated dialogue.
            if job.kind == "ambient" and sum(j.kind == "ambient" for j in running) >= max(1, settings.office_worker_concurrency-1):
                continue
            if job.kind == "ambient" and sum(j.kind == "ambient" and j.payload.get("provider_id") == key
                    for j in running) >= max(1, settings.office_provider_concurrency-1):
                continue
            job.generation += 1
            job.status = "running"
            job.lease_until = now+timedelta(seconds=settings.office_job_timeout_s+15)
            job.updated_at = now
            await db.commit()
            return job.id, job.generation
    return None


async def finish(job_id, generation, draft=None, metrics=None, error=""):
    async with SessionLocal() as db:
        job = await db.get(OfficeJob, job_id)
        if not job:
            return
        world = await db.scalar(select(OfficeWorld).where(OfficeWorld.id == job.world_id).with_for_update())
        if world is None:
            return
        await db.refresh(job)
        if job.status != "running" or job.generation != generation:
            return
        conv = await db.get(OfficeConversation, job.conversation_id)
        user = await db.get(User, world.user_id)
        now = utcnow()
        if job.lease_until <= now or job.deadline_at < now:
            error = "timeout"
        if not user or not user.is_active:
            error = "cancelled"
        else:
            try:
                await assessment_access(db, user, world.assessment_id)
            except HTTPException:
                error = "cancelled"
        if not settings.office_dialogue_enabled or (job.kind == "ambient" and not settings.office_ambient_enabled):
            error = "cancelled"
        if error:
            if metrics:
                job.result = metrics
            if (metrics or {}).get("circuit"):
                job.budget_tokens = max(0, job.budget_tokens-settings.office_token_reservation)
            job.status = "expired" if error == "timeout" else "cancelled" if error == "cancelled" else "failed"
            job.error = error
            conv.status = "idle" if conv.mode == "user" else "cancelled"
            if conv.mode == "ambient":
                conv.state = {}
            add_event(db, world, conv, "job_failed" if conv.mode == "user" else "ambient_end",
                meta={"job_id": str(job.id), "reason": error, "status": job.status})
        elif draft is not None:
            if conv.mode == "user":
                turn = draft.turns[0]
                event = add_event(db, world, conv, "npc_message", speaker=turn.speaker_id, content=turn.text,
                    meta={"reply_to": job.payload["event_id"], "request_id": str(job.request_id)})
                relations = dict(world.relations or {})
                prior = dict(relations.get(turn.speaker_id) or {})
                greeted = draft.greeted and (metrics or {}).get("guard") == "ok"
                relations[turn.speaker_id] = {"has_met": True, "greeted": bool(prior.get("greeted") or greeted),
                    "last_greeted_at": now.isoformat() if greeted else prior.get("last_greeted_at"),
                    "source_event_id": str(event.id)}
                world.relations = relations
                if draft.memory:
                    db.add(OfficeMemory(world_id=world.id, conversation_id=conv.id, participants=conv.participants,
                        scope="private", summary=draft.memory, source_ids=[job.payload["event_id"], str(event.id)],
                        through_sequence=event.sequence))
                conv.status = "idle"
            else:
                conv.status = "speaking"
                conv.state = {"turns": [t.model_dump() for t in draft.turns], "index": 0,
                              "next_at": now.isoformat(), "expires_at": (now+timedelta(seconds=60)).isoformat()}
                # 맥락 없이(그 짝의 첫 대화로) 만든 대본만 캐시에 남긴다 — 이어 받은 대본은 그 세계에서만 맞는 말을 한다
                if (metrics or {}).get("guard") == "ok" and (metrics or {}).get("standalone"):
                    await cache.remember(db, world, conv, OfficeProjection.model_validate(world.projection),
                        conv.state["turns"], job.id)
                if await user_talking(db, world) or not world.last_seen_at or world.last_seen_at < now-timedelta(seconds=18):
                    conv.status = "paused"
                    conv.state = {**conv.state, "resume_status": "speaking", "paused_at": now.isoformat(), "remaining_s": 0}
                    add_event(db, world, conv, "ambient_paused", meta={"reason": "user_dialogue"})
                else:
                    add_event(db, world, conv, "ambient_ready", meta={"participants": conv.participants})
            job.status, job.result = "succeeded", metrics or {}
            calls = (metrics or {}).get("calls", [])
            if calls and all(call.get("token_usage") is not None for call in calls):
                used = sum(sum(int(call["token_usage"].get(key) or 0) for key in
                    ("input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens")) for call in calls)
                # Cache accounting deliberately overestimates vendors that include cache reads in input.
                job.budget_tokens = max(0, job.budget_tokens-settings.office_token_reservation) + used
        job.lease_until, job.updated_at, conv.updated_at = None, now, now
        await db.commit()


async def process_job(job_id, generation):
    try:
        async with SessionLocal() as db:
            job = await db.get(OfficeJob, job_id)
            if not job or job.status != "running" or job.generation != generation:
                return
            if job.deadline_at <= utcnow():
                raise TimeoutError()
            blocked = await provider_blocked(db, job.payload)
            if blocked:
                await db.rollback()
                await finish(job_id, generation, error=blocked, metrics={"circuit": True})
                return
            world = await db.get(OfficeWorld, job.world_id)
            conv = await db.get(OfficeConversation, job.conversation_id)
            user = await db.get(User, world.user_id)
            if not user or not user.is_active or not settings.office_dialogue_enabled:
                raise ValueError("cancelled")
            try:
                await assessment_access(db, user, world.assessment_id)
            except HTTPException:
                raise ValueError("cancelled") from None
            if conv.mode == "ambient" and not settings.office_ambient_enabled:
                raise ValueError("cancelled")
            projection = OfficeProjection.model_validate(world.projection)
            context = public_context(projection, conv.participants)
            context["mode"] = conv.mode
            context["now"] = utcnow().isoformat()
            if conv.mode == "user":
                context["relations"] = {k: v for k, v in world.relations.items() if k in conv.participants}
                history = (await db.scalars(private_history(world, conv.actor_id).where(OfficeEvent.created_at <= job.created_at)
                    .order_by(OfficeEvent.created_at.desc()).limit(12))).all()
                context["history"] = [{"id": str(e.id), "speaker": e.speaker_id, "text": e.content[:2000],
                                        "at": e.created_at.isoformat()} for e in reversed(history)]
            else:
                context["trigger"] = job.payload.get("topic")
                witnessed = or_(*(OfficeConversation.participants.contains([actor]) for actor in conv.participants))
                episodes = (await db.scalars(select(OfficeEvent).join(OfficeConversation)
                    .where(OfficeEvent.world_id.in_(world_scope(world)), OfficeEvent.kind == "ambient_line", witnessed,
                           OfficeEvent.created_at <= job.created_at)
                    .order_by(OfficeEvent.created_at.desc()).limit(80))).all()
                # Always include the selected thread, plus the most recent shared exchanges.
                relevant = [e for e in episodes if e.meta.get("topic_id") == conv.topic_id]
                chosen = {e.id: e for e in [*relevant[:16], *episodes[:16]]}
                context["history"] = [{"id": str(e.id), "speaker": e.speaker_id, "text": e.content,
                    "witnesses": e.meta.get("participants", []), "topic": e.meta.get("topic_id"),
                    "at": e.created_at.isoformat()} for e in sorted(chosen.values(), key=lambda e: e.created_at)]
                counts = await ambient_counts(db, world)
                context["continuity"] = [{"actor": a, "exchanges_spoken": counts.get(a, 0),
                    "max_exchanges": next(p.max_conversations for p in projection.actors if p.id == a)} for a in conv.participants]
            query = job.payload.get("content") or json.dumps(job.payload.get("topic") or {}, ensure_ascii=False)
            context["memories"] = await context_memory(db, world, conv, query)
            # Keep immutable policy/context and latest user message; trim oldest dialogue first.
            while len(json.dumps(context, ensure_ascii=False)) > settings.office_input_chars-1000:
                if context["memories"]:
                    context["memories"].pop()
                elif len(context["history"]) > 1:
                    context["history"].pop(0)
                else:
                    raise ValueError("context_budget")
            pid = job.payload.get("provider_id")
            res = await provider.resolve_ai(db, "chat", override_provider_id=uuid.UUID(pid) if pid else None)
            if not res or not res.configured:
                raise ValueError("provider_unavailable")
            mode, actors = conv.mode, list(conv.participants)
            # 두 인물이 이 세계에서 처음 나누는 잡담이면 입력이 공개 설정뿐이다 — 시각도 빼고 만든다. 이런 대본만 캐시에
            # 들어가 다른 세계에서 다른 시각에 다시 쓰인다(npc/cache.py)
            standalone = mode == "ambient" and not context["history"] and not context["memories"]
            if standalone:
                context.pop("now", None)
            remaining = max(0.1, (job.deadline_at-utcnow()).total_seconds())
        # DB session/connection released before the slow provider call.
        draft, metrics = await asyncio.wait_for(generate(res, context, actors, mode), timeout=remaining)
        metrics["standalone"] = standalone
        await finish(job_id, generation, draft, metrics)
    except asyncio.CancelledError:
        raise  # lease expiry recovers the durable job after worker termination
    except TimeoutError:
        await finish(job_id, generation, error="timeout")
    except Exception as exc:
        # Do not log model bodies, credentials, or user messages.
        code = str(exc) if str(exc) in ("context_budget", "invalid_output", "public_scope", "provider_unavailable", "provider_quota", "cancelled") else "generation_failed"
        log.warning("office job failed id=%s error=%s class=%s", job_id, code, type(exc).__name__)
        await finish(job_id, generation, error=code)


async def run():
    install_encrypted_types()
    stopping = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stopping.set)
    tasks = set()
    tick = 0
    try:
        while not stopping.is_set():
            try:
                if tick % 5 == 0:
                    await schedule_ambient()
                if settings.office_dialogue_enabled:
                    for _ in range(max(0, settings.office_worker_concurrency-len(tasks))):
                        claimed = await claim_job()
                        if not claimed:
                            break
                        task = asyncio.create_task(process_job(*claimed))
                        tasks.add(task)
                        task.add_done_callback(tasks.discard)
                Path("/tmp/office-worker-health").touch()
                tick += 1
            except Exception as exc:
                log.warning("office dispatch unavailable class=%s", type(exc).__name__)
            try:
                await asyncio.wait_for(stopping.wait(), timeout=1)
            except TimeoutError:
                pass
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await engine.dispose()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    asyncio.run(run())

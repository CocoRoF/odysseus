"""Private office persistence. Always lock world before conversation/job mutations."""
from __future__ import annotations

import re
import uuid
from datetime import datetime, timedelta

from fastapi import HTTPException
from sqlalchemy import func, or_, select, text
from sqlalchemy.dialects.postgresql import insert

from ..config import settings
from ..models import (AiProvider, OfficeWorld, OfficeConversation, OfficeEvent, OfficeJob, OfficeMemory, utcnow)
from .policy import memory_score
from .public import assessment_access, projection_for


async def world_for(db, user, assessment_id):
    await assessment_access(db, user, assessment_id)
    projection, revision, _ = await projection_for(db, assessment_id)
    await db.execute(insert(OfficeWorld).values(id=uuid.uuid4(), user_id=user.id,
        assessment_id=assessment_id, revision=revision, projection=projection.model_dump(),
        sequence=0, relations={}, presence={}, next_ambient_at=utcnow()+timedelta(seconds=3))
        .on_conflict_do_nothing(index_elements=["user_id", "assessment_id", "revision"]))
    world = await db.scalar(select(OfficeWorld).where(OfficeWorld.user_id == user.id,
        OfficeWorld.assessment_id == assessment_id, OfficeWorld.revision == revision).with_for_update())
    # A new public revision never erases a person's relationships. Raw histories
    # stay in their original worlds; retrieval follows this private lineage.
    if world.sequence == 0 and not world.relations:
        older = (await db.scalars(select(OfficeWorld).where(OfficeWorld.id.in_(world_scope(world)),
            OfficeWorld.id != world.id).order_by(OfficeWorld.created_at))).all()
        ids = {a.id for a in projection.actors}
        relations = {}
        for previous in older:
            relations.update({k: v for k, v in (previous.relations or {}).items() if k in ids})
        world.relations = relations
    return world


def world_scope(world):
    return select(OfficeWorld.id).where(OfficeWorld.user_id == world.user_id,
        OfficeWorld.assessment_id == world.assessment_id)


def private_history(world, actor):
    return select(OfficeEvent).join(OfficeConversation).where(
        OfficeEvent.world_id.in_(world_scope(world)), OfficeConversation.mode == "user",
        OfficeConversation.actor_id == actor, OfficeEvent.kind.in_(["user_message", "npc_message"]))


async def own_world(db, user, world_id, *, lock=False):
    q = select(OfficeWorld).where(OfficeWorld.id == world_id, OfficeWorld.user_id == user.id)
    world = await db.scalar(q.with_for_update() if lock else q)
    if not world:
        raise HTTPException(404, "사무실을 찾을 수 없습니다")
    await assessment_access(db, user, world.assessment_id)
    return world


def add_event(db, world, conversation, kind, *, speaker="", content="", meta=None):
    world.sequence += 1
    event = OfficeEvent(id=uuid.uuid4(), world_id=world.id,
        conversation_id=conversation.id if conversation else None, sequence=world.sequence,
        kind=kind, speaker_id=speaker, content=content, meta=meta or {}, created_at=utcnow())
    db.add(event)
    return event


def event_out(event):
    # No raw job prompts, proposed/unspoken lines, guard traces or private provider data.
    return {"id": str(event.id), "world_id": str(event.world_id), "sequence": event.sequence, "kind": event.kind,
            "conversation_id": str(event.conversation_id) if event.conversation_id else None,
            "speaker_id": event.speaker_id, "content": event.content, "meta": event.meta,
            "created_at": event.created_at.isoformat()}


def job_out(job):
    return {"id": str(job.id), "status": job.status, "error": job.error,
            "request_id": str(job.request_id), "conversation_id": str(job.conversation_id)}


async def active_ambient(db, world):
    return await db.scalar(select(OfficeConversation).where(OfficeConversation.world_id == world.id,
        OfficeConversation.mode == "ambient", OfficeConversation.status.in_(["queued", "generating", "speaking", "paused"]))
        .order_by(OfficeConversation.created_at.desc()).limit(1))


async def user_talking(db, world):
    """A live portrait or pending user reply pauses this user's entire office."""
    cutoff = utcnow()-timedelta(seconds=18)
    rows = (await db.execute(select(OfficeWorld.presence, OfficeWorld.last_seen_at)
        .where(OfficeWorld.user_id == world.user_id))).all()
    now = utcnow().isoformat()
    visible = any((last_seen and last_seen > cutoff and presence.get("talking_to")) or
        any(lease.get("until", "") > now for lease in presence.get("dialogues", {}).values())
        for presence, last_seen in rows)
    pending = await db.scalar(select(OfficeJob.id).join(OfficeWorld).where(
        OfficeWorld.user_id == world.user_id, OfficeJob.kind == "user",
        OfficeJob.status.in_(["queued", "running"]), OfficeJob.deadline_at > utcnow()).limit(1))
    return bool(visible or pending)


def dialogue_presence(presence, tab_id, actor=None):
    now = utcnow()
    leases = {key: value for key, value in (presence or {}).get("dialogues", {}).items()
              if value.get("until", "") > now.isoformat()}
    if actor:
        leases[str(tab_id)] = {"actor": actor, "until": (now+timedelta(seconds=18)).isoformat()}
    else:
        leases.pop(str(tab_id), None)
    return leases


async def pause_ambient(db, world, reason="user_dialogue"):
    conv = await active_ambient(db, world)
    if conv and conv.status != "paused":
        now = utcnow()
        state = dict(conv.state or {})
        state.update(resume_status=conv.status, paused_at=now.isoformat(),
            remaining_s=max(0, (datetime.fromisoformat(state["next_at"])-now).total_seconds()) if state.get("next_at") else 0)
        conv.state, conv.status, conv.updated_at = state, "paused", now
        add_event(db, world, conv, "ambient_paused", meta={"reason": reason})
    return conv


async def resume_ambient(db, world):
    conv = await active_ambient(db, world)
    if conv and conv.status == "paused":
        now, state = utcnow(), dict(conv.state)
        conv.status = state.pop("resume_status", "queued")
        state.pop("paused_at", None)
        if state.get("turns"):
            conv.status = "speaking"
            state["next_at"] = (now+timedelta(seconds=state.pop("remaining_s", 0))).isoformat()
            state["expires_at"] = (now+timedelta(seconds=90)).isoformat()
        for job in (await db.scalars(select(OfficeJob).where(OfficeJob.conversation_id == conv.id,
                OfficeJob.status == "queued"))).all():
            job.deadline_at = now+timedelta(seconds=settings.office_job_timeout_s)
        conv.state, conv.updated_at = state, now
        add_event(db, world, conv, "ambient_resumed", meta={"index": state.get("index", 0)})
    return conv


async def ambient_counts(db, world):
    """Count distinct exchanges actually spoken by each NPC; retries/pauses cost zero."""
    rows = await db.execute(select(OfficeEvent.speaker_id, func.count(func.distinct(OfficeEvent.conversation_id)))
        .where(OfficeEvent.world_id.in_(world_scope(world)), OfficeEvent.kind == "ambient_line").group_by(OfficeEvent.speaker_id))
    return dict(rows.all())


async def cancel_ambient(db, world, reason="interrupted"):
    conv = await active_ambient(db, world)
    if conv:
        conv.status = "cancelled"
        conv.state = {}  # Unspoken drafts are not events/memories.
        for job in (await db.scalars(select(OfficeJob).where(OfficeJob.conversation_id == conv.id,
                OfficeJob.status.in_(["queued", "running"])))).all():
            job.status = "cancelled"
            job.generation += 1
        add_event(db, world, conv, "ambient_end", meta={"reason": reason})
    return conv


async def reserve_budget(db, world):
    # Admission is serialized in PostgreSQL, including during Redis outages.
    await db.execute(text("SELECT pg_advisory_xact_lock(74890321)"))
    since = utcnow() - timedelta(hours=1)
    global_count = await db.scalar(select(func.count()).select_from(OfficeJob).where(OfficeJob.updated_at >= since))
    reserved = await db.scalar(select(func.coalesce(func.sum(OfficeJob.budget_tokens), 0)).where(OfficeJob.updated_at >= since))
    user_count = await db.scalar(select(func.count()).select_from(OfficeJob).join(OfficeWorld)
        .where(OfficeWorld.user_id == world.user_id, OfficeJob.updated_at >= since))
    if (global_count >= settings.office_max_jobs_global_hour or user_count >= settings.office_max_jobs_per_user_hour
            or reserved + settings.office_token_reservation > settings.office_max_tokens_global_hour):
        raise HTTPException(429, "대화 요청이 많습니다. 잠시 쉬었다가 다시 이야기해 주세요")


async def office_provider_selection(db):
    """Office uses the live default chat profile; frozen exam providers stay untouched."""
    from ..ai import provider
    resolved = await provider.resolve_ai(db, "chat")
    row_id = resolved.provider_row_id if resolved else None
    row = await db.get(AiProvider, uuid.UUID(row_id)) if row_id else None
    return {"provider_id": row_id, "provider_revision": row.updated_at.isoformat() if row else "env"}


async def provider_blocked(db, payload):
    now = utcnow()
    failures = (await db.scalars(select(OfficeJob).where(
        OfficeJob.payload["provider_id"].astext.is_(None) if payload.get("provider_id") is None else
            OfficeJob.payload["provider_id"].astext == payload["provider_id"],
        OfficeJob.payload["provider_revision"].astext == payload.get("provider_revision", "env"),
        OfficeJob.result["circuit"].as_boolean().is_not(True),
        OfficeJob.status.in_(["succeeded", "failed", "expired"]),
        OfficeJob.updated_at > now-timedelta(hours=1))
        .order_by(OfficeJob.updated_at.desc()).limit(5))).all()
    if failures and failures[0].error == "provider_quota":
        return "provider_quota"
    if len(failures) == 5 and all(j.error in ("generation_failed", "timeout", "provider_unavailable") for j in failures):
        if failures[0].updated_at > now-timedelta(seconds=45):
            return "provider_unavailable"
    return ""


async def context_memory(db, world, conv, query):
    ids = conv.participants
    # Filter access BEFORE ranking. Private history is never available to ambient jobs.
    q = select(OfficeMemory).join(OfficeConversation).where(OfficeMemory.world_id.in_(world_scope(world)))
    if conv.mode == "ambient":
        q = q.where(OfficeMemory.scope == "ambient", or_(*(OfficeMemory.participants.contains([actor]) for actor in ids)))
    else:
        q = q.where(or_((OfficeMemory.scope == "private") & (OfficeConversation.actor_id == conv.actor_id),
            (OfficeMemory.scope == "ambient") & OfficeMemory.participants.contains(ids)))
    candidates = list((await db.scalars(q.order_by(OfficeMemory.created_at.desc()).limit(40))).all())
    terms = list(dict.fromkeys(re.findall(r"[\w가-힣]{2,}", query)))[:8]
    if terms:
        clauses = [OfficeMemory.summary.ilike("%" + term.replace("%", "\\%").replace("_", "\\_") + "%", escape="\\") for term in terms]
        candidates += list((await db.scalars(q.where(or_(*clauses)).order_by(OfficeMemory.created_at.desc()).limit(40))).all())
    unique = {m.id: m for m in candidates}
    now = utcnow()
    ranked = sorted(unique.values(), key=lambda m: memory_score(m.summary, query,
        (now - m.created_at).total_seconds()/86400), reverse=True)[:settings.office_memory_limit]
    return [{"id": str(m.id), "summary": m.summary, "source_ids": m.source_ids,
             "at": m.created_at.isoformat(), "witnesses": m.participants} for m in ranked]


async def snapshot_relations(db, attempt, definition):
    if not settings.office_exam_bridge_enabled:
        return
    # Use the latest visited public revision, including when authoring changed before exam entry.
    world = await db.scalar(select(OfficeWorld).where(OfficeWorld.user_id == attempt.user_id,
        OfficeWorld.assessment_id == attempt.assessment_id).order_by(OfficeWorld.created_at.desc()).limit(1).with_for_update())
    if not world:
        return
    from .contracts import npc_id
    allowed = {npc_id(s["scenario_id"], c) for s in definition.get("scenarios", []) for c in s.get("characters", [])}
    relations = {key: {"has_met": True, "has_exchanged_greeting": bool(value.get("greeted")),
                       "last_greeted_at": value.get("last_greeted_at"),
                       "source_event_id": value.get("source_event_id")}
                 for key, value in (world.relations or {}).items() if key in allowed and value.get("has_met")}
    attempt.snapshot = {**(attempt.snapshot or {}), "office_relationships": {
        "version": 1, "revision": world.revision, "world_id": str(world.id),
        "watermark": world.sequence, "actors": relations}}
    await cancel_ambient(db, world, "assessment_started")
    world.last_seen_at = None
    world.presence = {}

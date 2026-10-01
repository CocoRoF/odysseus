"""Authenticated office chat, private worlds, resumable events and ambient turns."""
from __future__ import annotations

import asyncio
import json
import math
import uuid
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from sqlalchemy import select

from ..config import settings
from ..db import SessionLocal, get_db
from ..deps import get_current_user, require_admin
from ..models import OfficeConversation, OfficeEvent, OfficeJob, OfficeMemory, utcnow
from ..npc.contracts import (AmbientAdvanceIn, ConversationIn, MessageIn, PresenceIn)
from ..npc.store import (active_ambient, add_event, cancel_ambient, event_out, job_out, pause_ambient, resume_ambient, user_talking, private_history, dialogue_presence,
                         office_provider_selection, own_world, reserve_budget, world_for)
from ..ratelimit import enforce

router = APIRouter(prefix="/office", tags=["office-dialogue"])


def enabled():
    if not settings.office_dialogue_enabled:
        raise HTTPException(503, "사무실 대화를 잠시 정비하고 있습니다")


def ambient_out(conv):
    if not conv:
        return None
    state = conv.state or {}
    return {"id": str(conv.id), "participants": conv.participants, "status": conv.status,
            "index": int(state.get("index", 0)), "total": len(state.get("turns", [])),
            "next_at": state.get("next_at"), "expires_at": state.get("expires_at")}


@router.post("/rooms/{assessment_id}/enter")
async def enter(assessment_id: uuid.UUID, user=Depends(get_current_user), db=Depends(get_db)):
    enabled()
    enforce(f"office-enter:{user.id}", per_min=30, burst=10)
    world = await world_for(db, user, assessment_id)
    await db.commit()
    return {"id": str(world.id), "assessment_id": str(world.assessment_id), "revision": world.revision, "sequence": world.sequence,
            "actors": world.projection["actors"], "dialogue_enabled": True,
            "ambient_enabled": settings.office_ambient_enabled}


@router.post("/worlds/{world_id}/presence")
async def presence(world_id: uuid.UUID, body: PresenceIn, user=Depends(get_current_user), db=Depends(get_db)):
    enabled()
    enforce(f"office-presence:{user.id}", per_min=90, burst=15)
    world = await own_world(db, user, world_id, lock=True)
    now = utcnow()
    old = world.presence or {}
    ids = {a["id"] for a in world.projection["actors"]}
    if body.talking_to and body.talking_to not in ids:
        raise HTTPException(400, "없는 인물입니다")
    dialogues = dialogue_presence(old, body.tab_id, body.talking_to if body.active else None)
    world.presence = {**old, "dialogues": dialogues}
    controller = old.get("tab_id")
    occupied = world.last_seen_at and world.last_seen_at > now - timedelta(seconds=18)
    if controller and controller != str(body.tab_id) and occupied:
        if body.active and body.talking_to:
            await pause_ambient(db, world)
        await db.commit()
        return {"controller": False, "ambient": ambient_out(await active_ambient(db, world))}
    if not body.active:
        await pause_ambient(db, world, "inactive")
        world.last_seen_at, world.presence = None, {"dialogues": dialogues}
        await db.commit()
        return {"controller": False, "ambient": None}
    pairs = []
    for pair in body.pairs:
        if len(pair) == 2 and len(set(pair)) == 2 and set(pair) <= ids:
            pairs.append(sorted(pair))
    if not occupied:
        # Re-entering a visible room should not inherit a long silent cooldown.
        # Job admission still enforces the shared per-user/provider budgets.
        world.next_ambient_at = min(world.next_ambient_at, now + timedelta(seconds=3))
    world.presence = {"tab_id": str(body.tab_id), "talking_to": body.talking_to, "pairs": pairs, "dialogues": dialogues}
    world.last_seen_at = now
    talking = await user_talking(db, world)
    conv = await pause_ambient(db, world) if talking else await resume_ambient(db, world)
    if not talking and not conv and (old.get("talking_to") or old.get("dialogues")):
        # Closing the last private dialogue releases the next ambient exchange promptly.
        world.next_ambient_at = min(world.next_ambient_at, now + timedelta(seconds=3))
    if conv and conv.status != "paused" and not any(set(pair) == set(conv.participants) for pair in pairs):
        # Navigation observations can age while a job is queued. Release separated actors.
        await cancel_ambient(db, world, "separated")
        conv = None
    if conv and conv.status != "paused" and now > conv.updated_at + timedelta(seconds=settings.office_job_timeout_s):
        await cancel_ambient(db, world, "expired")
        conv = None
    await db.commit()
    return {"controller": True, "ambient": ambient_out(conv)}


@router.post("/worlds/{world_id}/conversations")
async def conversation(world_id: uuid.UUID, body: ConversationIn, user=Depends(get_current_user), db=Depends(get_db)):
    enabled()
    enforce(f"office-open:{user.id}", per_min=30, burst=8)
    world = await own_world(db, user, world_id, lock=True)
    actor = str(body.actor_id)
    if actor not in {a["id"] for a in world.projection["actors"]}:
        raise HTTPException(404, "이 사무실의 인물이 아닙니다")
    if body.tab_id:
        world.presence = {**(world.presence or {}), "dialogues": dialogue_presence(world.presence, body.tab_id, actor)}
    else:
        world.presence = {**(world.presence or {}), "talking_to": actor}
    world.last_seen_at = utcnow()
    await pause_ambient(db, world)
    conv = await db.scalar(select(OfficeConversation).where(OfficeConversation.world_id == world.id,
        OfficeConversation.actor_id == actor))
    if conv is None:
        conv = OfficeConversation(id=uuid.uuid4(), world_id=world.id, actor_id=actor,
            mode="user", participants=[actor], status="idle", state={})
        db.add(conv)
        await db.flush()
    last = await db.scalar(private_history(world, actor).order_by(OfficeEvent.created_at.desc(), OfficeEvent.id.desc()).limit(1))
    person = next(a for a in world.projection["actors"] if a["id"] == actor)
    opening = person.get("opening") or "반갑습니다. 편하게 이야기해 주세요."
    # Refresh an untouched introduction after author edits; real conversations keep their history.
    if last is None or (last.meta.get("source") == "scenario_encounter" and last.content != opening):
        event = add_event(db, world, conv, "npc_message", speaker=actor, content=opening,
            meta={"source": "scenario_encounter", "revision": world.revision})
        world.relations = {**(world.relations or {}), actor: {
            **(world.relations or {}).get(actor, {}), "has_met": True, "source_event_id": str(event.id)}}
    await db.commit()
    return {"id": str(conv.id), "status": conv.status, "has_met": bool((world.relations or {}).get(actor))}


async def own_conversation(db, user, conversation_id, *, lock=False):
    # Locate world first, then lock in the same order as workers/presence/start_attempt.
    conv = await db.get(OfficeConversation, conversation_id)
    if not conv:
        raise HTTPException(404, "대화를 찾을 수 없습니다")
    world = await own_world(db, user, conv.world_id, lock=lock)
    if lock:
        await db.refresh(conv)
    return world, conv


@router.get("/conversations/{conversation_id}/messages")
async def messages(conversation_id: uuid.UUID, before: int | None = Query(None, ge=1),
                   user=Depends(get_current_user), db=Depends(get_db)):
    world, conv = await own_conversation(db, user, conversation_id)
    q = private_history(world, conv.actor_id) if conv.mode == "user" else select(OfficeEvent).where(
        OfficeEvent.conversation_id == conv.id, OfficeEvent.kind == "ambient_line")
    if before is not None:
        cursor = await db.scalar(select(OfficeEvent.created_at).where(OfficeEvent.world_id == world.id,
            OfficeEvent.sequence == before))
        if cursor is not None:
            q = q.where(OfficeEvent.created_at < cursor)
        else:
            raise HTTPException(400, "현재 사무실의 메시지 번호가 아닙니다")
    rows = (await db.scalars(q.order_by(OfficeEvent.created_at.desc(), OfficeEvent.id.desc()).limit(50))).all()
    pending = await db.scalar(select(OfficeJob).where(OfficeJob.conversation_id == conv.id)
        .order_by(OfficeJob.created_at.desc()).limit(1))
    return {"messages": [event_out(e) for e in reversed(rows)], "job": job_out(pending) if pending else None,
            "more": len(rows) == 50, "status": conv.status}


@router.post("/conversations/{conversation_id}/messages", status_code=202)
async def send(conversation_id: uuid.UUID, body: MessageIn, user=Depends(get_current_user), db=Depends(get_db)):
    enabled()
    world, conv = await own_conversation(db, user, conversation_id, lock=True)
    if conv.mode != "user":
        raise HTTPException(400, "NPC 간 대화에는 메시지를 보낼 수 없습니다")
    existing = await db.scalar(select(OfficeJob).where(OfficeJob.world_id == world.id, OfficeJob.request_id == body.request_id))
    if existing:
        if existing.conversation_id != conv.id or existing.payload.get("content") != body.content or existing.payload.get("intent") != body.intent:
            raise HTTPException(409, "같은 요청 ID에 다른 메시지를 보낼 수 없습니다")
        return job_out(existing)
    enforce(f"office-send:{user.id}", per_min=12, burst=4, what="대화")
    if conv.status in ("queued", "generating"):
        raise HTTPException(409, "이전 답변을 기다리고 있습니다")
    await reserve_budget(db, world)
    await pause_ambient(db, world)
    selection = await office_provider_selection(db)
    content = body.content if body.intent == "message" else "안녕하세요."
    ev = add_event(db, world, conv, "user_message", speaker="user", content=content,
        meta={"request_id": str(body.request_id), "intent": body.intent})
    conv.status, conv.updated_at = "queued", utcnow()
    job = OfficeJob(id=uuid.uuid4(), world_id=world.id, conversation_id=conv.id,
        request_id=body.request_id, kind="user", priority=0, status="queued",
        budget_tokens=settings.office_token_reservation,
        payload={"content": body.content, "intent": body.intent, "event_id": str(ev.id),
                 "through_sequence": ev.sequence,
                 **selection},
        deadline_at=utcnow()+timedelta(seconds=settings.office_job_timeout_s))
    db.add(job)
    await db.commit()
    return job_out(job)


@router.post("/jobs/{job_id}/retry", status_code=202)
async def retry(job_id: uuid.UUID, user=Depends(get_current_user), db=Depends(get_db)):
    enabled()
    job = await db.get(OfficeJob, job_id)
    if not job:
        raise HTTPException(404, "요청을 찾을 수 없습니다")
    world = await own_world(db, user, job.world_id, lock=True)
    await db.refresh(job)
    if job.status not in ("failed", "expired") or job.kind != "user":
        return job_out(job)
    enforce(f"office-retry:{user.id}", per_min=4, burst=2)
    conv = await db.get(OfficeConversation, job.conversation_id)
    newer = await db.scalar(select(OfficeJob.id).where(OfficeJob.conversation_id == conv.id, OfficeJob.created_at > job.created_at).limit(1))
    if newer or conv.status in ("queued", "generating"):
        raise HTTPException(409, "새 대화가 시작되어 이전 답변을 재생성할 수 없습니다")
    if job.generation >= 3:
        raise HTTPException(429, "재시도 한도를 초과했습니다. 잠시 후 새 메시지를 보내 주세요")
    await reserve_budget(db, world)
    job.budget_tokens += settings.office_token_reservation
    job.payload = {**job.payload, **await office_provider_selection(db)}
    job.status, job.error, job.lease_until = "queued", "", None
    job.updated_at = utcnow()
    job.deadline_at = utcnow()+timedelta(seconds=settings.office_job_timeout_s)
    conv.status = "queued"
    await db.commit()
    return job_out(job)


@router.post("/conversations/{conversation_id}/advance")
async def advance(conversation_id: uuid.UUID, body: AmbientAdvanceIn, user=Depends(get_current_user), db=Depends(get_db)):
    enabled()
    world, conv = await own_conversation(db, user, conversation_id, lock=True)
    if conv.mode != "ambient":
        return {"ambient": None}
    if conv.status == "paused":
        return {"ambient": ambient_out(conv)}
    if conv.status != "speaking":
        return {"ambient": None}
    if (world.presence or {}).get("tab_id") != str(body.tab_id):
        raise HTTPException(409, "다른 화면에서 사무실을 둘러보고 있습니다")
    now = utcnow()
    if not world.last_seen_at or world.last_seen_at < now-timedelta(seconds=18) or await user_talking(db, world):
        await pause_ambient(db, world)
        await db.commit()
        return {"ambient": ambient_out(conv)}
    state = dict(conv.state)
    if state.get("expires_at", "") < now.isoformat():
        await cancel_ambient(db, world, "expired")
        await db.commit()
        return {"ambient": None}
    index = int(state.get("index", 0))
    if body.index != index or state.get("next_at", "") > now.isoformat():
        return {"ambient": ambient_out(conv)}
    turns = state.get("turns", [])
    if index >= len(turns):
        conv.status, conv.state = "completed", {}
        add_event(db, world, conv, "ambient_end", meta={"reason": "completed"})
        await db.commit()
        return {"ambient": None}
    turn = turns[index]
    ev = add_event(db, world, conv, "ambient_line", speaker=turn["speaker_id"], content=turn["text"],
        meta={"participants": conv.participants, "topic_id": conv.topic_id, "index": index})
    # Every spoken line is a source-backed episode; interrupted drafts cannot be recalled.
    db.add(OfficeMemory(world_id=world.id, conversation_id=conv.id, participants=conv.participants,
        scope="ambient", summary=turn["text"], source_ids=[str(ev.id)], through_sequence=ev.sequence))
    state["index"] = index+1
    # 화면의 말풍선 읽기 시간과 같은 식(speech.ts speechDuration·SPEECH_PAGE_CHARS) — 다르면 말풍선이 사라진 뒤 다음 줄까지
    # 빈틈이 생기거나 다음 줄이 앞 줄을 자른다. 64자를 넘는 줄은 여러 쪽으로 나뉘고, 쪽마다 최소 3.2초를 읽는다.
    chars = len(turn["text"])
    state["next_at"] = (now+timedelta(seconds=max(3.2 * math.ceil(chars/64), min(11, chars*0.09)))).isoformat()
    conv.state, conv.updated_at = state, now
    await db.commit()
    return {"ambient": ambient_out(conv), "event": event_out(ev)}


@router.get("/worlds/{world_id}/events")
async def events(world_id: uuid.UUID, request: Request, after: int = Query(0, ge=0),
                 user=Depends(get_current_user), db=Depends(get_db)):
    await own_world(db, user, world_id)
    try:
        cursor = max(after, int(request.headers.get("last-event-id", "0")))
    except ValueError:
        raise HTTPException(400, "잘못된 이벤트 번호입니다")
    await db.commit()

    async def stream():
        nonlocal cursor
        for _ in range(20):  # Reconnect regularly to refresh authentication and authorization.
            if await request.is_disconnected():
                return
            async with SessionLocal() as session:
                try:
                    current = await get_current_user(request, session)
                    await own_world(session, current, world_id)
                except HTTPException:
                    yield 'event: revoked\ndata: {}\n\n'
                    return
                rows = (await session.scalars(select(OfficeEvent).where(OfficeEvent.world_id == world_id,
                    OfficeEvent.sequence > cursor).order_by(OfficeEvent.sequence).limit(100))).all()
                for row in rows:
                    cursor = row.sequence
                    yield f'id: {cursor}\nevent: office\ndata: {json.dumps(event_out(row), ensure_ascii=False)}\n\n'
            yield ': keepalive\n\n'
            await asyncio.sleep(1.5)
    return StreamingResponse(stream(), media_type="text/event-stream", headers={"X-Accel-Buffering": "no"})


@router.get("/admin/metrics")
async def metrics(_=Depends(require_admin), db=Depends(get_db)):
    from sqlalchemy import func
    from ..models import OfficeWorld
    counts = {}
    for name, model in (("worlds", OfficeWorld), ("conversations", OfficeConversation),
                        ("events", OfficeEvent), ("memories", OfficeMemory), ("jobs", OfficeJob)):
        counts[name] = await db.scalar(select(func.count()).select_from(model))
    since = utcnow()-timedelta(hours=1)
    statuses = (await db.execute(select(OfficeJob.kind, OfficeJob.status, func.count())
        .where(OfficeJob.updated_at >= since).group_by(OfficeJob.kind, OfficeJob.status))).all()
    reserved = await db.scalar(select(func.coalesce(func.sum(OfficeJob.budget_tokens), 0)).where(OfficeJob.updated_at >= since))
    recent = (await db.execute(select(OfficeJob.id, OfficeJob.kind, OfficeJob.status, OfficeJob.error,
        OfficeJob.result, OfficeJob.created_at).order_by(OfficeJob.created_at.desc()).limit(30))).all()
    from ..npc import cache
    return {"counts": counts, "hour": [{"kind": kind, "status": status, "count": count} for kind, status, count in statuses],
        "accounted_tokens_hour": reserved, "token_limit_hour": settings.office_max_tokens_global_hour,
        "dialogue_cache": await cache.stats(db),
        "recent": [{"id": str(row.id), "kind": row.kind, "status": row.status, "error": row.error,
                    "metrics": row.result, "created_at": row.created_at.isoformat()} for row in recent]}


@router.get("/admin/dialogue-cache")
async def dialogue_cache(limit: int = Query(100, ge=1, le=500), _=Depends(require_admin), db=Depends(get_db)):
    """다른 세계에서 다시 쓰는 NPC 잡담 대본(npc/cache.py). 검수는 확률적이라 잘못 통과한 대본을 찾아 지우는 데 쓴다.
    많이 튼 것부터 보여 준다 — 퍼진 범위가 큰 대본을 먼저 살핀다."""
    from ..models import OfficeDialogueCache
    rows = (await db.scalars(select(OfficeDialogueCache).order_by(OfficeDialogueCache.replays.desc(),
        OfficeDialogueCache.created_at.desc()).limit(limit))).all()
    return {"entries": [{"id": str(r.id), "speaker_id": r.speaker_id, "listener_id": r.listener_id, "topic_id": r.topic_id,
                         "turns": r.turns, "replays": r.replays, "created_at": r.created_at.isoformat()} for r in rows]}


@router.delete("/admin/dialogue-cache/{entry_id}")
async def delete_dialogue_cache_entry(entry_id: uuid.UUID, _=Depends(require_admin), db=Depends(get_db)):
    from sqlalchemy import delete
    from ..models import OfficeDialogueCache
    result = await db.execute(delete(OfficeDialogueCache).where(OfficeDialogueCache.id == entry_id))
    await db.commit()
    if not result.rowcount:
        raise HTTPException(404, "대본을 찾을 수 없습니다")
    return {"deleted": result.rowcount}


@router.delete("/admin/dialogue-cache")
async def purge_dialogue_cache(_=Depends(require_admin), db=Depends(get_db)):
    """캐시 대본을 모두 지운다. 이미 사무실에서 말한 줄(사건·기억)은 그 세계의 기록이라 지우지 않는다."""
    from sqlalchemy import delete
    from ..models import OfficeDialogueCache
    result = await db.execute(delete(OfficeDialogueCache))
    await db.commit()
    return {"deleted": result.rowcount}

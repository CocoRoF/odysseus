"""사무실 NPC 잡담(ambient) 대본 캐시 — 공개 설정만으로 만든 **짝의 첫 잡담**을 다른 사용자 세계에서 다시 쓴다.

설계(NPC-SYSTEM-DESIGN §10.1)는 "캐시는 공개·무개인화 자료만 공유한다"고 정했다. 잡담 가운데 무개인화인 것은 두 인물이
그 세계에서 아직 잡담을 나눈 적이 없을 때뿐이다. 그때 생성 입력은 두 인물의 공개 설정·장면 공개 자료·주제뿐이고, 사용자·
기억·이전 발화·시각이 없다. 그래서 캐시는 양쪽 끝에 같은 조건을 건다.

- 넣을 때: 그 입력으로 만들어 검수를 통과한 대본만(worker 의 standalone).
- 꺼낼 때: 틀 세계에서도 두 인물이 아직 잡담을 나눈 적이 없을 때만(`fresh_pair`). 이미 이야기한 짝에게 첫 만남 대본을
  틀면 "기억에 없는 만남을 만들지 않는다"와 이어지는 대화 원칙이 깨진다.

주제는 평소 고르기(시나리오 2 : 일상 1, 덜 다룬 주제 먼저)가 정한 것만 쓴다. 캐시가 주제 배분을 바꾸지 않는다.
키는 발화자 → 수신자, 주제, 공개 지문(public_hash)이다. 목소리·첫마디·공개 사실·정책 판이 바뀌면 지문이 달라져 옛 대본을
쓰지 않고, 같은 짝·주제의 옛 지문 행은 새 대본이 들어올 때 지운다.

재생은 공급자를 부르지 않으므로 공급자 장애·호출 예산과 무관하게 틀 수 있다. 재생도 평소처럼 advance 를 거쳐 실제로 말한
줄만 사건·기억이 된다. 검수는 확률적이라 한 대본이 너무 많은 세계에 퍼지지 않게 재생 횟수에 상한을 두고, 관리자는
`/office/admin/dialogue-cache` 로 대본을 보고 지울 수 있다.
"""
from __future__ import annotations

import uuid
from datetime import timedelta

from sqlalchemy import delete, func, or_, select

from ..config import settings
from ..definitions import canonical_hash
from ..models import OfficeConversation, OfficeDialogueCache, OfficeEvent, OfficeMemory, utcnow
from .contracts import OfficeProjection
from .policy import POLICY_VERSION
from .store import add_event, world_scope


def public_hash(projection: OfficeProjection, pair: list[str]) -> str:
    """두 인물의 공개 페르소나와 그 장면의 공개 자료, 정책 판의 지문. 어느 하나가 바뀌면 대본은 낡은 것이다."""
    actors = sorted((a for a in projection.actors if a.id in pair), key=lambda a: a.id)
    scenes = sorted({a.scene for a in actors})
    return canonical_hash({
        "policy": POLICY_VERSION,
        "actors": [a.model_dump(exclude={"max_conversations"}) for a in actors],
        "scenes": {s: projection.scenes[s].model_dump() for s in scenes if s in projection.scenes},
    })


async def fresh_pair(db, world, pair: list[str]) -> bool:
    """두 인물 모두 이 세계(같은 사용자·시험)에서 잡담을 나눈 적이 없는가 — 생성 쪽 standalone 과 같은 범위를 본다
    (참여한 대화의 발화, 잡담 기억)."""
    lines = await db.scalar(select(OfficeEvent.id).join(OfficeConversation, OfficeEvent.conversation_id == OfficeConversation.id)
        .where(OfficeEvent.world_id.in_(world_scope(world)), OfficeEvent.kind == "ambient_line",
               or_(*(OfficeConversation.participants.contains([actor]) for actor in pair))).limit(1))
    if lines is not None:
        return False
    memories = await db.scalar(select(OfficeMemory.id).where(OfficeMemory.world_id.in_(world_scope(world)),
        OfficeMemory.scope == "ambient", or_(*(OfficeMemory.participants.contains([actor]) for actor in pair))).limit(1))
    return memories is None


async def remember(db, world, conv, projection: OfficeProjection, turns: list[dict], job_id: uuid.UUID | None) -> None:
    """만든 대본을 캐시에 넣는다. 발화자는 첫 줄을 말한 사람. 같은 짝·주제의 낡은 지문 행은 지우고, 같은 키가 상한을
    넘으면 오래된 것부터 버린다."""
    if not settings.office_cache_enabled or len(turns) < 2:
        return
    speaker = str(turns[0]["speaker_id"])
    listener = next((str(t["speaker_id"]) for t in turns if str(t["speaker_id"]) != speaker), None)
    if listener is None:
        return
    digest = public_hash(projection, list(conv.participants))
    same_pair = (OfficeDialogueCache.speaker_id == speaker, OfficeDialogueCache.listener_id == listener,
                 OfficeDialogueCache.topic_id == conv.topic_id)
    await db.execute(delete(OfficeDialogueCache).where(*same_pair, OfficeDialogueCache.public_hash != digest))
    db.add(OfficeDialogueCache(id=uuid.uuid4(), speaker_id=speaker, listener_id=listener, topic_id=conv.topic_id,
        public_hash=digest, turns=turns, source_job_id=job_id, source_world_id=world.id))
    await db.flush()
    older = (await db.scalars(select(OfficeDialogueCache.id).where(*same_pair, OfficeDialogueCache.public_hash == digest)
        .order_by(OfficeDialogueCache.created_at.desc()).offset(settings.office_cache_per_key))).all()
    if older:
        await db.execute(delete(OfficeDialogueCache).where(OfficeDialogueCache.id.in_(older)))


async def candidates(db, world, projection: OfficeProjection, pair: list[str], topic_id: str) -> list[OfficeDialogueCache]:
    """이 짝(양방향)·지문·주제에 맞고, 재생 상한 아래이며, 이 세계에서 만들지도 틀지도 않은 대본. 덜 틀어 본 것부터."""
    digest = public_hash(projection, pair)
    a, b = pair
    rows = (await db.scalars(select(OfficeDialogueCache).where(
        OfficeDialogueCache.public_hash == digest, OfficeDialogueCache.topic_id == topic_id,
        OfficeDialogueCache.replays < settings.office_cache_max_replays,
        ((OfficeDialogueCache.speaker_id == a) & (OfficeDialogueCache.listener_id == b)) |
        ((OfficeDialogueCache.speaker_id == b) & (OfficeDialogueCache.listener_id == a)),
        OfficeDialogueCache.source_world_id.is_(None) | OfficeDialogueCache.source_world_id.notin_(world_scope(world)))
        .order_by(OfficeDialogueCache.replays, OfficeDialogueCache.created_at.desc())
        .limit(settings.office_cache_per_key * 2))).all()
    if not rows:
        return []
    shown = set((await db.scalars(select(OfficeEvent.meta["cache_id"].astext).where(
        OfficeEvent.world_id.in_(world_scope(world)), OfficeEvent.kind == "ambient_start",
        OfficeEvent.meta["cache_id"].astext.in_([str(r.id) for r in rows])))).all())
    return [r for r in rows if str(r.id) not in shown]


async def choose(db, world, projection: OfficeProjection, pairs: list[list[str]], topic_for, exchanges: int):
    """틀 만한 캐시 대본이 있으면 (짝, 주제, 대본) 을, 없으면 None. 처음 잡담하는 짝만 본다.

    대본이 상한(per_key)만큼 모였으면 늘 캐시로 튼다. 아직 모이는 중이면 세계·차례로 번갈아(대략 절반) 새로 만들어
    대본의 종류를 넓힌다. 모자라면(min 미만) 새로 만든다."""
    if not settings.office_cache_enabled:
        return None
    for pair in pairs:
        if not await fresh_pair(db, world, pair):
            continue
        topic = topic_for(pair)
        pool = await candidates(db, world, projection, pair, topic["id"])
        alternate = (world.id.int + exchanges) % 2 == 1
        if len(pool) >= settings.office_cache_per_key or (len(pool) >= settings.office_cache_min and alternate):
            return pair, topic, pool[0]
    return None


def replay(db, world, conv, entry: OfficeDialogueCache, now) -> None:
    """캐시 대본으로 대화를 바로 '말하는 중' 상태에 올린다 — 작업(job)도 공급자 호출도 없다. 화면은 평소처럼 한 줄씩 넘긴다."""
    entry.replays += 1
    conv.status = "speaking"
    conv.state = {"turns": list(entry.turns), "index": 0, "next_at": now.isoformat(),
                  "expires_at": (now + timedelta(seconds=60)).isoformat(), "cache_id": str(entry.id)}
    add_event(db, world, conv, "ambient_start", meta={"participants": conv.participants, "cache_id": str(entry.id)})
    add_event(db, world, conv, "ambient_ready", meta={"participants": conv.participants, "cached": True})


async def stats(db) -> dict:
    total = await db.scalar(select(func.count()).select_from(OfficeDialogueCache))
    replays = await db.scalar(select(func.coalesce(func.sum(OfficeDialogueCache.replays), 0)))
    since = utcnow() - timedelta(hours=1)
    fresh = await db.scalar(select(func.count()).select_from(OfficeDialogueCache).where(OfficeDialogueCache.created_at >= since))
    return {"entries": total, "replays": replays, "added_hour": fresh}

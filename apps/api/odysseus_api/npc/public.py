"""Compile a minimal, versioned office projection. Never call from an LLM tool."""
from __future__ import annotations

import uuid
from collections import defaultdict

from fastapi import HTTPException
from sqlalchemy import select

from ..avatar_alloc import allocate
from ..definitions import canonical_hash
from ..demo import NO_EXAM_MESSAGE, is_demo_admin
from ..deps import is_staff
from ..models import Assessment, AssessmentScenario, Assignment, Scenario, User
from ..office import MAX_COLLEAGUES
from .contracts import OfficeProjection, OfficePublic, PublicActor, npc_id


async def assessment_access(db, user: User, assessment_id: uuid.UUID):
    assessment = await db.get(Assessment, assessment_id)
    if assessment is None:
        raise HTTPException(404, "시험을 찾을 수 없습니다")
    # 둘러보기 계정은 사무실에 들어가지 않는다 — 관리 화면만 본다 (demo.py)
    if is_demo_admin(user):
        raise HTTPException(403, NO_EXAM_MESSAGE)
    if user.role == "guest":
        if user.guest_category and assessment.category != user.guest_category:
            raise HTTPException(403, "이 사무실에 접근할 수 없습니다")
    elif not is_staff(user):
        assignment = await db.scalar(select(Assignment.id).where(
            Assignment.user_id == user.id, Assignment.assessment_id == assessment_id))
        if assignment is None:
            raise HTTPException(403, "배정된 사무실이 아닙니다")
    return assessment


def compile_public(rows) -> tuple[OfficeProjection, list[dict]]:
    actors, roster, scenes, seen = [], [], {}, set()
    for scenario_id, characters, public_raw in rows:
        public = OfficePublic.model_validate(public_raw or {})
        public = public if public.published else OfficePublic()
        scene = str(scenario_id)
        scenes[scene] = public
        allocation = allocate(characters or [])
        for c in characters or []:
            identity = npc_id(scenario_id, c)
            if identity in seen or len(actors) >= MAX_COLLEAGUES:
                continue
            seen.add(identity)
            # Explicit public allowlist; raw exam cards never enter the result.
            actor = PublicActor(id=identity, name=str(c.get("name") or "동료")[:60],
                                role=str(c.get("role") or "")[:100],
                                voice=str(c.get("office_voice") or "")[:600] if public.published else "",
                                opening=str(c.get("encounter") or "반갑습니다. 편하게 이야기해 주세요.")[:200],
                                max_conversations=c.get("office_max_conversations", 12), scene=scene)
            actors.append(actor)
            roster.append({"key": identity, "npc_id": identity, "name": actor.name[:40],
                           "role": actor.role[:40], "color": str(c.get("color") or "")[:9],
                           "avatar_preset": str(c.get("avatar_preset") or allocation.get(c.get("key"), ""))[:40],
                           "gender": str(c.get("gender") or "")[:10], "encounter": actor.opening})
    return OfficeProjection(actors=actors, scenes=scenes), roster


async def public_rows(db, assessment_ids):
    rows = (await db.execute(select(AssessmentScenario.assessment_id, Scenario.id,
                Scenario.characters, Scenario.office_public)
            .join(Scenario, Scenario.id == AssessmentScenario.scenario_id)
            .where(AssessmentScenario.assessment_id.in_(assessment_ids))
            .order_by(AssessmentScenario.assessment_id, AssessmentScenario.ordinal))).all()
    grouped = defaultdict(list)
    for aid, sid, characters, public in rows:
        grouped[aid].append((sid, characters, public))
    return grouped


async def projection_for(db, assessment_id):
    grouped = await public_rows(db, [assessment_id])
    projection, roster = compile_public(grouped.get(assessment_id, []))
    return projection, canonical_hash(projection.model_dump()), roster

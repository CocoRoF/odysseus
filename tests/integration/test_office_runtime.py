"""Run only against an explicitly provided disposable PostgreSQL database.
ODYSSEUS_OFFICE_INTEGRATION=1 DATABASE_URL=... python -m unittest discover -s tests/integration
"""
import asyncio
import json
import os
import unittest
import uuid
from datetime import timedelta
from unittest.mock import AsyncMock, patch

import httpx
from sqlalchemy import delete, func, select

from odysseus_api.main import app
from odysseus_api.db import Base, engine, SessionLocal
from odysseus_api.deps import get_current_user
from odysseus_api.models import (User, Scenario, Assessment, AssessmentScenario, OfficeWorld,
    OfficeConversation, OfficeDialogueCache, OfficeEvent, OfficeJob, OfficeMemory, Attempt, utcnow)
from odysseus_api.migrations import run_schema_migrations
from odysseus_api.ai.provider import ResolvedAi
from odysseus_api.config import settings
from odysseus_api.npc import cache, worker
from odysseus_api.npc.contracts import OfficeProjection
from odysseus_api.npc.store import context_memory, provider_blocked, snapshot_relations
from odysseus_api.definitions import build_assessment_definition, bind_definition


@unittest.skipUnless(os.getenv("ODYSSEUS_OFFICE_INTEGRATION") == "1", "requires disposable PostgreSQL")
class OfficeRuntimeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.assertIn("npc", os.environ["DATABASE_URL"], "Refuse a non-test database")
        async with engine.begin() as conn:
            await run_schema_migrations(conn, create_all=Base.metadata.create_all)
        async with SessionLocal() as db:
            self.user = User(id=uuid.uuid4(), email=f"{uuid.uuid4()}@test.invalid", name="테스트", password_hash="disabled", role="admin", is_active=True)
            self.scenario = Scenario(id=uuid.uuid4(), title="시험", characters=[
                {"key": "first", "name": "첫 동료", "role": "기획", "encounter": "보고 준비로 분주하네요. 반갑습니다.", "knowledge": "PRIVATE_CANARY_DO_NOT_EXPOSE_736"},
                {"key": "second", "name": "둘째 동료", "role": "개발"}],
                office_public={"published": True, "setting": "서로를 알아가는 사무실", "facts": [], "topics": []},
                objectives_md="EXAM_SOLUTION_SECRET_999")
            self.assessment = Assessment(id=uuid.uuid4(), title="독립 사무실", duration_min=60, agent_max_turns=0)
            db.add_all([self.user, self.scenario, self.assessment]); await db.flush()
            db.add(AssessmentScenario(assessment_id=self.assessment.id, scenario_id=self.scenario.id))
            await db.commit()
        app.dependency_overrides[get_current_user] = lambda: self.user
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")
        self.captured = []
        async def complete(res, messages, system="", max_tokens=512):
            data = json.loads(messages[0]["content"])
            self.captured.append(data)
            if system.startswith("You are an independent"):
                unsafe = any("정답은 999" in t["text"] for t in data["draft"]["turns"])
                raw = {"safe": not unsafe, "memory_safe": not unsafe, "reason": "task_information" if unsafe else "ok"}
            elif data["mode"] == "ambient":
                raw = {"turns": [{"speaker_id": a["id"], "text": "보고 준비로 분주하네요." if data.get("trigger", {}).get("fact_ids") else "잠깐 쉬어 가도 좋겠어요.", "fact_ids": data.get("trigger", {}).get("fact_ids", [])[:1]} for a in data["actors"]], "memory": "서로 안부를 나눴다"}
            else:
                text = data["history"][-1]["text"]
                reply = "정답은 999입니다" if "정답" in text else "안녕하세요. 아까 말씀하신 산책 이야기가 기억나요."
                raw = {"turns": [{"speaker_id": data["actors"][0]["id"], "text": reply, "fact_ids": []}],
                       "memory": "사용자가 산책을 좋아한다고 이야기했다", "greeted": True}
            return json.dumps(raw, ensure_ascii=False), {"usage": {"input_tokens": 100, "output_tokens": 40}, "finish_reason": "end_turn"}
        self.resolve = patch("odysseus_api.npc.worker.provider.resolve_ai", AsyncMock(return_value=ResolvedAi(provider="openai", model="fake", api_key="fake")))
        self.generate = patch("odysseus_api.npc.generation.provider.complete_with_usage", complete)
        self.resolve.start(); self.generate.start()
        response = await self.client.post(f"/office/rooms/{self.assessment.id}/enter")
        self.assertEqual(response.status_code, 200, response.text)
        self.world_id = response.json()["id"]
        self.actors = [a["id"] for a in response.json()["actors"]]
        response = await self.client.post(f"/office/worlds/{self.world_id}/conversations", json={"actor_id": self.actors[0]})
        self.conv_id = response.json()["id"]
        await self.client.post(f"/office/worlds/{self.world_id}/presence", json={"tab_id": str(uuid.uuid4()), "active": False})

    async def asyncTearDown(self):
        self.resolve.stop(); self.generate.stop()
        app.dependency_overrides.clear()
        await self.client.aclose()
        async with SessionLocal() as db:
            await db.execute(delete(OfficeDialogueCache).where(OfficeDialogueCache.speaker_id.in_(self.actors)))
            await db.execute(delete(Assessment).where(Assessment.id == self.assessment.id))
            await db.execute(delete(Scenario).where(Scenario.id == self.scenario.id))
            await db.execute(delete(User).where(User.id == self.user.id))
            await db.commit()
        await engine.dispose()

    async def send(self, content="산책을 좋아합니다"):
        body = {"request_id": str(uuid.uuid4()), "content": content}
        response = await self.client.post(f"/office/conversations/{self.conv_id}/messages", json=body)
        self.assertEqual(response.status_code, 202, response.text)
        return response.json(), body

    async def run_job(self):
        claimed = await worker.claim_job()
        self.assertIsNotNone(claimed)
        await worker.process_job(*claimed)
        return claimed

    async def test_duplicate_delivery_commits_one_reply_and_public_context_only(self):
        job, body = await self.send()
        responses = await asyncio.gather(*[self.client.post(f"/office/conversations/{self.conv_id}/messages", json=body) for _ in range(5)])
        self.assertTrue(all(r.json()["id"] == job["id"] for r in responses))
        claimed = await self.run_job()
        await worker.process_job(*claimed)
        response = await self.client.get(f"/office/conversations/{self.conv_id}/messages")
        self.assertEqual(len(response.json()["messages"]), 3)
        self.assertEqual(response.json()["job"]["status"], "succeeded")
        captured = json.dumps(self.captured)
        self.assertNotIn("PRIVATE_CANARY", captured); self.assertNotIn("EXAM_SOLUTION", captured)
        mismatch = await self.client.post(f"/office/conversations/{self.conv_id}/messages", json={**body, "content": "다른 내용"})
        self.assertEqual(mismatch.status_code, 409)

    async def test_memory_is_private_and_relationship_snapshot_is_narrow(self):
        await self.send(); await self.run_job()
        other = await self.client.post(f"/office/worlds/{self.world_id}/conversations", json={"actor_id": self.actors[1]})
        self.assertFalse(other.json()["has_met"])  # 말 걸기 창을 연 것만으로는 만난 것이 아니다
        async with SessionLocal() as db:
            world = await db.get(OfficeWorld, uuid.UUID(self.world_id))
            conv = await db.get(OfficeConversation, uuid.UUID(self.conv_id))
            private = await context_memory(db, world, conv, "산책")
            stranger = await db.get(OfficeConversation, uuid.UUID(other.json()["id"]))
            self.assertTrue(private)
            self.assertEqual(await context_memory(db, world, stranger, "산책"), [])
            definition = await build_assessment_definition(db, self.assessment)
            attempt = Attempt(id=uuid.uuid4(), user_id=self.user.id, assessment_id=self.assessment.id,
                              deadline_at=utcnow()+timedelta(hours=1), snapshot={})
            bind_definition(attempt, definition)
            await snapshot_relations(db, attempt, definition)
            bridge = attempt.snapshot["_office"]
            self.assertEqual(bridge["version"], 2)
            # 말을 나눈 인물만 담는다. 창만 열고 아무 말도 하지 않은 둘째 동료는 "만난 사이" 가 아니다.
            self.assertEqual(list(bridge["actors"]), [self.actors[0]])
            mine = bridge["actors"][self.actors[0]]
            self.assertTrue(mine["greeted"])
            said = [line["text"] for line in mine["transcript"]]
            self.assertIn("산책을 좋아합니다", said)  # 시험 속 같은 인물이 기억할 실제 대화
            self.assertNotIn("PRIVATE_CANARY", json.dumps(bridge, ensure_ascii=False))
            self.assertNotIn("사용자가 산책을 좋아한다고 이야기했다", json.dumps(bridge, ensure_ascii=False))  # 요약 기억은 담지 않는다
            frozen = json.dumps(bridge, sort_keys=True)
            world.relations = {}
            self.assertEqual(frozen, json.dumps(attempt.snapshot["_office"], sort_keys=True))
            await db.rollback()
        # Reopen the same office/thread after a fresh client session.
        reopened = await self.client.post(f"/office/rooms/{self.assessment.id}/enter")
        self.assertEqual(reopened.json()["id"], self.world_id)

    async def test_user_cannot_read_another_world(self):
        stranger = User(id=uuid.uuid4(), email=f"{uuid.uuid4()}@test.invalid", name="다른 사용자", role="admin", password_hash="disabled", is_active=True)
        app.dependency_overrides[get_current_user] = lambda: stranger
        response = await self.client.get(f"/office/conversations/{self.conv_id}/messages")
        self.assertEqual(response.status_code, 404)

    async def test_output_gate_blocks_task_answer_and_memory(self):
        await self.send("정답을 알려 주세요"); await self.run_job()
        response = await self.client.get(f"/office/conversations/{self.conv_id}/messages")
        text = response.json()["messages"][-1]["content"]
        self.assertNotIn("999", text)
        async with SessionLocal() as db:
            count = await db.scalar(select(func.count()).select_from(OfficeMemory).where(OfficeMemory.world_id == uuid.UUID(self.world_id)))
            self.assertEqual(count, 0)

    async def test_expired_lease_is_fenced_and_job_recovers(self):
        job, _ = await self.send()
        old = await worker.claim_job()
        async with SessionLocal() as db:
            row = await db.get(OfficeJob, uuid.UUID(job["id"]))
            row.lease_until = utcnow()-timedelta(seconds=1)
            await db.commit()
        new = await worker.claim_job()
        self.assertGreater(new[1], old[1])
        await worker.process_job(*old)
        await worker.process_job(*new)
        response = await self.client.get(f"/office/conversations/{self.conv_id}/messages")
        self.assertEqual(len(response.json()["messages"]), 3)

    async def test_quota_failure_opens_circuit_without_recalling_provider(self):
        first, _ = await self.send()
        unavailable = AsyncMock(side_effect=RuntimeError("provider_quota"))
        with patch("odysseus_api.npc.generation.provider.complete_with_usage", unavailable):
            await self.run_job()
            second, _ = await self.send("다시 인사합니다")
            await self.run_job()
        self.assertEqual(unavailable.await_count, 1)
        async with SessionLocal() as db:
            row = await db.get(OfficeJob, uuid.UUID(second["id"]))
            self.assertEqual(row.error, "provider_quota")
            self.assertTrue(row.result["circuit"])
            self.assertEqual(row.budget_tokens, 0)
            self.assertEqual(await provider_blocked(db, row.payload), "provider_quota")
            self.assertEqual(await provider_blocked(db, {**row.payload, "provider_revision": "reconfigured"}), "")
            self.assertEqual(await db.scalar(select(func.count()).select_from(OfficeMemory)
                .where(OfficeMemory.world_id == uuid.UUID(self.world_id))), 0)

    async def test_timeout_retry_preserves_one_user_message(self):
        first, _ = await self.send()
        with patch("odysseus_api.npc.generation.provider.complete_with_usage", AsyncMock(side_effect=TimeoutError())):
            await self.run_job()
        response = await self.client.post(f"/office/jobs/{first['id']}/retry")
        self.assertEqual(response.status_code, 202, response.text)
        await self.run_job()
        history = (await self.client.get(f"/office/conversations/{self.conv_id}/messages")).json()
        self.assertEqual([m["kind"] for m in history["messages"]], ["npc_message", "user_message", "npc_message"])
        self.assertEqual(history["job"]["status"], "succeeded")

    async def test_revoked_user_cannot_trigger_provider_or_commit_reply(self):
        job, _ = await self.send()
        async with SessionLocal() as db:
            user = await db.get(User, self.user.id)
            user.is_active = False
            await db.commit()
        await self.run_job()
        self.assertEqual(self.captured, [])
        async with SessionLocal() as db:
            row = await db.get(OfficeJob, uuid.UUID(job["id"]))
            self.assertEqual(row.status, "cancelled")

    async def test_admission_budget_rejects_before_creating_event(self):
        with patch.object(settings, "office_max_tokens_global_hour", settings.office_token_reservation-1):
            response = await self.client.post(f"/office/conversations/{self.conv_id}/messages",
                json={"request_id": str(uuid.uuid4()), "content": "안녕하세요"})
        self.assertEqual(response.status_code, 429)
        history = (await self.client.get(f"/office/conversations/{self.conv_id}/messages")).json()
        self.assertEqual([m["kind"] for m in history["messages"]], ["npc_message"])
        self.assertIsNone(history["job"])

    async def test_ambient_jobs_leave_provider_capacity_for_user(self):
        async with SessionLocal() as db:
            for index in range(3):
                world = OfficeWorld(id=uuid.uuid4(), user_id=self.user.id, assessment_id=self.assessment.id,
                    revision=f"capacity-{index}", projection={}, relations={}, presence={})
                db.add(world); await db.flush()
                conversation = OfficeConversation(id=uuid.uuid4(), world_id=world.id, mode="ambient",
                    participants=self.actors, status="queued")
                db.add(conversation); await db.flush()
                db.add(OfficeJob(world_id=world.id, conversation_id=conversation.id, request_id=uuid.uuid4(),
                    kind="ambient", priority=10, payload={"provider_id": None},
                    deadline_at=utcnow()+timedelta(seconds=90)))
            await db.commit()
        with patch.object(settings, "office_worker_concurrency", 4), patch.object(settings, "office_provider_concurrency", 3):
            self.assertIsNotNone(await worker.claim_job())
            self.assertIsNotNone(await worker.claim_job())
            self.assertIsNone(await worker.claim_job())
            job, _ = await self.send()
            claimed = await worker.claim_job()
            self.assertEqual(str(claimed[0]), job["id"])

    async def test_changed_publication_starts_new_world_but_keeps_original_history(self):
        await self.send(); await self.run_job()
        async with SessionLocal() as db:
            scenario = await db.get(Scenario, self.scenario.id)
            scenario.office_public = {**scenario.office_public, "setting": "새로 공개한 사무실 배경"}
            await db.commit()
        entered = (await self.client.post(f"/office/rooms/{self.assessment.id}/enter")).json()
        self.assertNotEqual(entered["id"], self.world_id)
        self.assertEqual(entered["sequence"], 0)
        history = (await self.client.get(f"/office/conversations/{self.conv_id}/messages")).json()
        self.assertEqual(len(history["messages"]), 3)
        reopened = (await self.client.post(f"/office/worlds/{entered['id']}/conversations", json={"actor_id": self.actors[0]})).json()
        recovered = (await self.client.get(f"/office/conversations/{reopened['id']}/messages")).json()
        self.assertEqual([m["id"] for m in recovered["messages"]], [m["id"] for m in history["messages"]])
        self.assertTrue(reopened["has_met"])

    async def test_private_dialogue_does_not_postpone_ambient_and_close_releases_cooldown(self):
        tab = str(uuid.uuid4())
        await self.client.post(f"/office/worlds/{self.world_id}/presence", json={
            "tab_id": tab, "talking_to": self.actors[0], "pairs": [self.actors]})
        async with SessionLocal() as db:
            world = await db.get(OfficeWorld, uuid.UUID(self.world_id))
            world.next_ambient_at = utcnow()-timedelta(seconds=1)
            await db.commit()
        await worker.schedule_ambient()
        async with SessionLocal() as db:
            world = await db.get(OfficeWorld, uuid.UUID(self.world_id))
            self.assertLessEqual((world.next_ambient_at-utcnow()).total_seconds(), 3)
            self.assertEqual(await db.scalar(select(func.count()).select_from(OfficeJob)
                .where(OfficeJob.world_id == world.id)), 0)
            world.next_ambient_at = utcnow()+timedelta(seconds=60)
            await db.commit()
        await self.client.post(f"/office/worlds/{self.world_id}/presence", json={
            "tab_id": tab, "talking_to": None, "pairs": [self.actors]})
        async with SessionLocal() as db:
            world = await db.get(OfficeWorld, uuid.UUID(self.world_id))
            self.assertLessEqual((world.next_ambient_at-utcnow()).total_seconds(), 3)

    async def test_only_spoken_ambient_lines_are_remembered_and_user_interrupts(self):
        tab = str(uuid.uuid4())
        response = await self.client.post(f"/office/worlds/{self.world_id}/presence", json={"tab_id": tab, "pairs": [self.actors]})
        self.assertTrue(response.json()["controller"])
        async with SessionLocal() as db:
            world = await db.get(OfficeWorld, uuid.UUID(self.world_id))
            world.next_ambient_at = utcnow()-timedelta(seconds=1)
            await db.commit()
        await worker.schedule_ambient(); await self.run_job()
        response = await self.client.post(f"/office/worlds/{self.world_id}/presence", json={"tab_id": tab, "pairs": [self.actors]})
        scene = response.json()["ambient"]
        self.assertEqual(scene["status"], "speaking")
        # A second tab cannot advance or seize a live controller.
        second = await self.client.post(f"/office/worlds/{self.world_id}/presence", json={"tab_id": str(uuid.uuid4())})
        self.assertFalse(second.json()["controller"])
        async with SessionLocal() as db:
            self.assertEqual(await db.scalar(select(func.count()).select_from(OfficeMemory).where(OfficeMemory.world_id == uuid.UUID(self.world_id))), 0)
        response = await self.client.post(f"/office/conversations/{scene['id']}/advance", json={"tab_id": tab, "index": 0})
        self.assertEqual(response.status_code, 200, response.text)
        await self.client.post(f"/office/conversations/{scene['id']}/advance", json={"tab_id": tab, "index": 0})
        await self.client.post(f"/office/worlds/{self.world_id}/conversations", json={"actor_id": self.actors[0]})
        async with SessionLocal() as db:
            count = await db.scalar(select(func.count()).select_from(OfficeMemory).where(OfficeMemory.world_id == uuid.UUID(self.world_id)))
            self.assertEqual(count, 1)
            conv = await db.get(OfficeConversation, uuid.UUID(scene["id"]))
            self.assertEqual(conv.status, "paused"); self.assertEqual(conv.state["index"], 1)
        blocked = await self.client.post(f"/office/conversations/{scene['id']}/advance", json={"tab_id": tab, "index": 1})
        self.assertNotIn("event", blocked.json())
        resumed = await self.client.post(f"/office/worlds/{self.world_id}/presence", json={"tab_id": tab, "pairs": [self.actors]})
        self.assertEqual(resumed.json()["ambient"]["id"], scene["id"])
        self.assertEqual(resumed.json()["ambient"]["index"], 1)
        self.assertEqual(resumed.json()["ambient"]["status"], "speaking")
        async with SessionLocal() as db:
            conv = await db.get(OfficeConversation, uuid.UUID(scene["id"]))
            conv.state = {**conv.state, "next_at": utcnow().isoformat()}
            await db.commit()
        spoken = await self.client.post(f"/office/conversations/{scene['id']}/advance", json={"tab_id": tab, "index": 1})
        self.assertEqual(spoken.json()["event"]["speaker_id"], self.actors[1])
        # A readonly tab's portrait is also an interaction: the controller cannot resume it.
        other_tab = str(uuid.uuid4())
        await self.client.post(f"/office/worlds/{self.world_id}/presence", json={"tab_id": other_tab, "talking_to": self.actors[0]})
        controller = (await self.client.post(f"/office/worlds/{self.world_id}/presence", json={"tab_id": tab, "pairs": [self.actors]})).json()
        self.assertEqual(controller["ambient"]["status"], "paused")
        await self.client.post(f"/office/worlds/{self.world_id}/presence", json={"tab_id": other_tab, "active": False})
        controller = (await self.client.post(f"/office/worlds/{self.world_id}/presence", json={"tab_id": tab, "pairs": [self.actors]})).json()
        self.assertEqual(controller["ambient"]["status"], "speaking")

    async def test_visible_colleagues_from_different_scenarios_share_public_premises(self):
        async with SessionLocal() as db:
            world = await db.get(OfficeWorld, uuid.UUID(self.world_id))
            projection = json.loads(json.dumps(world.projection))
            projection["actors"][1]["scene"] = "another-scenario"
            projection["scenes"]["another-scenario"] = {"published": True, "setting": "OTHER_SETTING",
                "facts": [{"id": "other", "text": "OTHER_SCENARIO_FACT"}], "topics": []}
            world.projection = projection
            world.next_ambient_at = utcnow()+timedelta(minutes=5)
            await db.commit()
        tab = str(uuid.uuid4())
        await self.client.post(f"/office/worlds/{self.world_id}/presence", json={"tab_id":tab,"pairs":[self.actors]})
        async with SessionLocal() as db:
            world = await db.get(OfficeWorld, uuid.UUID(self.world_id))
            self.assertLessEqual((world.next_ambient_at-utcnow()).total_seconds(), 3)
            world.next_ambient_at = utcnow()-timedelta(seconds=1)
            await db.commit()
        await worker.schedule_ambient(); await self.run_job()
        context = next(c for c in self.captured if c.get("mode") == "ambient")
        self.assertEqual(len(context["actors"]), 2)
        self.assertEqual(context["facts"][0]["text"], "OTHER_SCENARIO_FACT")
        self.assertNotIn("PRIVATE_CANARY", json.dumps(self.captured))
        response = await self.client.post(f"/office/worlds/{self.world_id}/presence", json={"tab_id":tab,"pairs":[self.actors]})
        scene = response.json()["ambient"]
        self.assertEqual(scene["status"], "speaking")
        spoken = await self.client.post(f"/office/conversations/{scene['id']}/advance", json={"tab_id":tab,"index":0})
        self.assertEqual(spoken.json()["event"]["kind"], "ambient_line")

    async def test_opening_is_npc_first_idempotent_and_costs_no_model_call(self):
        for _ in range(2):
            await self.client.post(f"/office/worlds/{self.world_id}/conversations", json={"actor_id": self.actors[0]})
        history = (await self.client.get(f"/office/conversations/{self.conv_id}/messages")).json()
        self.assertEqual(len(history["messages"]), 1)
        self.assertEqual(history["messages"][0]["speaker_id"], self.actors[0])
        self.assertEqual(history["messages"][0]["content"], "보고 준비로 분주하네요. 반갑습니다.")
        self.assertIsNone(history["job"])
        self.assertEqual(self.captured, [])

    async def test_reauthored_opening_refreshes_untouched_intro_but_preserves_real_dialogue(self):
        async def revise(text):
            async with SessionLocal() as db:
                scenario = await db.get(Scenario, self.scenario.id)
                scenario.characters = [{**c, "encounter": text} if c["key"] == "first" else c for c in scenario.characters]
                await db.commit()
            world = (await self.client.post(f"/office/rooms/{self.assessment.id}/enter")).json()
            self.world_id = world["id"]
            conversation = (await self.client.post(f"/office/worlds/{self.world_id}/conversations",
                json={"actor_id": self.actors[0]})).json()
            self.conv_id = conversation["id"]
            return (await self.client.get(f"/office/conversations/{self.conv_id}/messages")).json()

        edited = await revise("지금은 좀 예민하네요. 그래도 말씀은 들을게요.")
        self.assertEqual(len(edited["messages"]), 2)
        self.assertEqual(edited["messages"][-1]["content"], "지금은 좀 예민하네요. 그래도 말씀은 들을게요.")
        self.assertEqual(self.captured, [])
        await self.client.post(f"/office/worlds/{self.world_id}/conversations", json={"actor_id": self.actors[0]})
        history = (await self.client.get(f"/office/conversations/{self.conv_id}/messages")).json()
        self.assertEqual(len(history["messages"]), 2)
        await self.send(); await self.run_job()
        history = (await self.client.get(f"/office/conversations/{self.conv_id}/messages")).json()
        revised = await revise("잠깐 쉬면서 얘기해도 괜찮을까요?")
        self.assertEqual([e["id"] for e in revised["messages"]], [e["id"] for e in history["messages"]])

    async def test_generated_ambient_is_saved_while_user_talks_and_cap_survives_reentry(self):
        tab = str(uuid.uuid4())
        await self.client.post(f"/office/worlds/{self.world_id}/presence", json={"tab_id": tab, "pairs": [self.actors]})
        async with SessionLocal() as db:
            world = await db.get(OfficeWorld, uuid.UUID(self.world_id))
            world.next_ambient_at = utcnow()-timedelta(seconds=1)
            world.projection = {**world.projection, "actors": [{**a, "max_conversations": 1} for a in world.projection["actors"]]}
            await db.commit()
        await worker.schedule_ambient()
        # Pause before claiming: no ambient provider work may be dispatched.
        await self.client.post(f"/office/worlds/{self.world_id}/conversations", json={"actor_id": self.actors[0]})
        self.assertIsNone(await worker.claim_job())
        await self.client.post(f"/office/worlds/{self.world_id}/presence", json={"tab_id": tab, "pairs": [self.actors]})
        claimed = await worker.claim_job()
        self.assertIsNotNone(claimed)
        # A running result is retained during user interaction, not played or discarded.
        await self.client.post(f"/office/worlds/{self.world_id}/conversations", json={"actor_id": self.actors[0]})
        await worker.process_job(*claimed)
        async with SessionLocal() as db:
            job = await db.get(OfficeJob, claimed[0]); scene_id = str(job.conversation_id)
            conv = await db.get(OfficeConversation, job.conversation_id)
            self.assertEqual(job.status, "succeeded"); self.assertEqual(conv.status, "paused")
            self.assertEqual(len(conv.state["turns"]), 2)
        await self.client.post(f"/office/worlds/{self.world_id}/presence", json={"tab_id": tab, "pairs": [self.actors]})
        for index in range(3):
            async with SessionLocal() as db:
                conv = await db.get(OfficeConversation, uuid.UUID(scene_id))
                conv.state = {**conv.state, "next_at": utcnow().isoformat()}
                await db.commit()
            await self.client.post(f"/office/conversations/{scene_id}/advance", json={"tab_id": tab, "index": index})
        async with SessionLocal() as db:
            world = await db.get(OfficeWorld, uuid.UUID(self.world_id)); world.next_ambient_at = utcnow()-timedelta(seconds=1)
            await db.commit()
        await worker.schedule_ambient()
        self.assertIsNone(await worker.claim_job())
        # Private user messages remain available even after the autonomous cap.
        await self.send("잠깐 이야기해요"); await self.run_job()
        history = (await self.client.get(f"/office/conversations/{self.conv_id}/messages")).json()
        self.assertEqual(history["job"]["status"], "succeeded")

    async def test_next_scenario_exchange_receives_actual_prior_lines_and_counts(self):
        tab = str(uuid.uuid4())
        await self.client.post(f"/office/worlds/{self.world_id}/presence", json={"tab_id": tab, "pairs": [self.actors]})
        async with SessionLocal() as db:
            world = await db.get(OfficeWorld, uuid.UUID(self.world_id))
            projection = json.loads(json.dumps(world.projection))
            scene = projection["actors"][0]["scene"]
            projection["scenes"][scene] = {"published": True, "setting": "보고를 준비 중인 팀",
                "facts": [{"id": "report", "text": "팀이 보고를 준비하고 있다"}],
                "topics": [{"id": "preparation", "kind": "scenario", "intent": "보고 준비의 분주한 분위기", "fact_ids": ["report"]}]}
            world.projection = projection; world.next_ambient_at = utcnow()-timedelta(seconds=1)
            await db.commit()
        await worker.schedule_ambient(); await self.run_job()
        scene = (await self.client.post(f"/office/worlds/{self.world_id}/presence", json={"tab_id": tab, "pairs": [self.actors]})).json()["ambient"]
        actual = []
        for index in range(3):
            async with SessionLocal() as db:
                conv = await db.get(OfficeConversation, uuid.UUID(scene["id"]))
                conv.state = {**conv.state, "next_at": utcnow().isoformat()}
                await db.commit()
            response = (await self.client.post(f"/office/conversations/{scene['id']}/advance", json={"tab_id": tab, "index": index})).json()
            if response.get("event"): actual.append(response["event"])
        async with SessionLocal() as db:
            world = await db.get(OfficeWorld, uuid.UUID(self.world_id)); world.next_ambient_at = utcnow()-timedelta(seconds=1)
            await db.commit()
        await worker.schedule_ambient(); await self.run_job()
        contexts = [c for c in self.captured if c.get("mode") == "ambient"]
        self.assertEqual(contexts[-1]["trigger"]["kind"], "scenario")
        self.assertEqual([e["id"] for e in contexts[-1]["history"]], [e["id"] for e in actual])
        self.assertEqual([a["exchanges_spoken"] for a in contexts[-1]["continuity"]], [1, 1])
        self.assertNotIn("PRIVATE_CANARY", json.dumps(contexts))

    # ── 잡담 대본 캐시(npc/cache.py): 공개 설정만으로 만든 짝의 첫 잡담만 다른 세계에서 다시 쓴다 ──

    async def ambient_due(self, tab):
        await self.client.post(f"/office/worlds/{self.world_id}/presence", json={"tab_id": tab, "pairs": [self.actors]})
        async with SessionLocal() as db:
            world = await db.get(OfficeWorld, uuid.UUID(self.world_id))
            world.next_ambient_at = utcnow()-timedelta(seconds=1)
            await db.commit()

    async def seed_cache(self, count, text="처음 뵙네요, 같은 층에서 일하게 됐어요.", **fields):
        async with SessionLocal() as db:
            world = await db.get(OfficeWorld, uuid.UUID(self.world_id))
            digest = cache.public_hash(OfficeProjection.model_validate(world.projection), list(self.actors))
            rows = [OfficeDialogueCache(id=uuid.uuid4(), speaker_id=self.actors[0], listener_id=self.actors[1],
                topic_id="social", public_hash=digest, source_world_id=uuid.uuid4(),
                turns=[{"speaker_id": self.actors[0], "text": f"{text}({n})", "fact_ids": []},
                       {"speaker_id": self.actors[1], "text": "반가워요. 잘 부탁드려요.", "fact_ids": []}], **fields)
                    for n in range(count)]
            db.add_all(rows)
            await db.commit()
            return [r.id for r in rows]

    async def latest_ambient(self):
        async with SessionLocal() as db:
            return (await db.scalars(select(OfficeConversation).where(OfficeConversation.world_id == uuid.UUID(self.world_id),
                OfficeConversation.mode == "ambient").order_by(OfficeConversation.created_at.desc()))).first()

    async def speak_all(self, tab, conv_id):
        for index in range(4):
            async with SessionLocal() as db:
                conv = await db.get(OfficeConversation, conv_id)
                if conv.status != "speaking":
                    return
                conv.state = {**conv.state, "next_at": utcnow().isoformat()}
                await db.commit()
            await self.client.post(f"/office/conversations/{conv_id}/advance", json={"tab_id": tab, "index": index})

    async def test_cached_first_meeting_plays_without_provider_and_is_remembered_as_spoken(self):
        tab = str(uuid.uuid4())
        ids = await self.seed_cache(settings.office_cache_per_key)
        await self.ambient_due(tab)
        # 공급자가 막혀 있어도 캐시 재생은 공급자를 부르지 않으니 틀 수 있다
        with patch("odysseus_api.npc.worker.provider_blocked", AsyncMock(return_value=True)):
            await worker.schedule_ambient()
        conv = await self.latest_ambient()
        self.assertEqual(conv.status, "speaking")
        self.assertIn(uuid.UUID(conv.state["cache_id"]), ids)
        async with SessionLocal() as db:
            self.assertEqual(await db.scalar(select(func.count()).select_from(OfficeJob).where(OfficeJob.world_id == conv.world_id)), 0)
        self.assertFalse([c for c in self.captured if c.get("mode") == "ambient"])
        await self.speak_all(tab, conv.id)
        async with SessionLocal() as db:
            lines = (await db.scalars(select(OfficeEvent.content).where(OfficeEvent.conversation_id == conv.id,
                OfficeEvent.kind == "ambient_line").order_by(OfficeEvent.sequence))).all()
            memories = await db.scalar(select(func.count()).select_from(OfficeMemory).where(OfficeMemory.conversation_id == conv.id))
            entry = await db.get(OfficeDialogueCache, uuid.UUID(conv.state["cache_id"]))
        self.assertEqual(len(lines), 2); self.assertEqual(memories, 2); self.assertEqual(entry.replays, 1)

    async def test_pair_that_already_talked_never_replays_a_first_meeting(self):
        tab = str(uuid.uuid4())
        await self.ambient_due(tab)
        await worker.schedule_ambient(); await self.run_job()
        first = await self.latest_ambient()
        self.assertNotIn("cache_id", first.state)
        await self.speak_all(tab, first.id)
        await self.seed_cache(settings.office_cache_per_key)
        await self.ambient_due(tab)
        await worker.schedule_ambient()
        second = await self.latest_ambient()
        self.assertNotEqual(second.id, first.id)
        self.assertNotIn("cache_id", second.state or {})
        async with SessionLocal() as db:
            self.assertEqual(await db.scalar(select(func.count()).select_from(OfficeJob)
                .where(OfficeJob.conversation_id == second.id)), 1)

    async def test_only_context_free_generation_is_cached_and_without_time(self):
        tab = str(uuid.uuid4())
        await self.ambient_due(tab)
        await worker.schedule_ambient(); await self.run_job()
        first = await self.latest_ambient()
        contexts = [c for c in self.captured if c.get("mode") == "ambient"]
        self.assertNotIn("now", contexts[-1]); self.assertEqual(contexts[-1]["history"], [])
        async with SessionLocal() as db:
            rows = (await db.scalars(select(OfficeDialogueCache).where(OfficeDialogueCache.source_world_id == first.world_id))).all()
        self.assertEqual(len(rows), 1)
        # 이 세계에서 만든 대본은 이 세계에서 다시 틀지 않는다
        async with SessionLocal() as db:
            world = await db.get(OfficeWorld, first.world_id)
            self.assertEqual(await cache.candidates(db, world, OfficeProjection.model_validate(world.projection), list(self.actors), "social"), [])
        await self.speak_all(tab, first.id)
        await self.ambient_due(tab)
        await worker.schedule_ambient(); await self.run_job()
        contexts = [c for c in self.captured if c.get("mode") == "ambient"]
        self.assertIn("now", contexts[-1]); self.assertTrue(contexts[-1]["history"])
        async with SessionLocal() as db:
            self.assertEqual(await db.scalar(select(func.count()).select_from(OfficeDialogueCache)
                .where(OfficeDialogueCache.source_world_id == first.world_id)), 1)

    async def test_changed_public_voice_retires_scripts_and_replay_cap_holds(self):
        tab = str(uuid.uuid4())
        await self.seed_cache(settings.office_cache_per_key, replays=settings.office_cache_max_replays)
        await self.ambient_due(tab)
        await worker.schedule_ambient()
        self.assertNotIn("cache_id", (await self.latest_ambient()).state or {})
        async with SessionLocal() as db:
            await db.execute(delete(OfficeEvent).where(OfficeEvent.world_id == uuid.UUID(self.world_id), OfficeEvent.kind.like("ambient%")))
            await db.execute(delete(OfficeJob).where(OfficeJob.world_id == uuid.UUID(self.world_id)))
            await db.execute(delete(OfficeConversation).where(OfficeConversation.world_id == uuid.UUID(self.world_id),
                OfficeConversation.mode == "ambient"))
            await db.execute(delete(OfficeDialogueCache))
            await db.commit()
        old = await self.seed_cache(settings.office_cache_per_key)
        async with SessionLocal() as db:
            world = await db.get(OfficeWorld, uuid.UUID(self.world_id))
            projection = json.loads(json.dumps(world.projection))
            projection["actors"][0]["voice"] = "말끝을 흐리며 조심스럽게 말한다"
            world.projection = projection
            await db.commit()
        await self.ambient_due(tab)
        await worker.schedule_ambient()
        self.assertNotIn("cache_id", (await self.latest_ambient()).state or {})
        await self.run_job()
        async with SessionLocal() as db:
            left = await db.scalar(select(func.count()).select_from(OfficeDialogueCache).where(OfficeDialogueCache.id.in_(old)))
            fresh = await db.scalar(select(func.count()).select_from(OfficeDialogueCache))
        self.assertEqual(left, 0); self.assertEqual(fresh, 1)

    async def test_admin_can_review_and_remove_cached_scripts(self):
        ids = await self.seed_cache(2)
        listed = (await self.client.get("/office/admin/dialogue-cache")).json()["entries"]
        self.assertEqual({e["id"] for e in listed} >= {str(i) for i in ids}, True)
        self.assertEqual((await self.client.delete(f"/office/admin/dialogue-cache/{ids[0]}")).json()["deleted"], 1)
        self.assertEqual((await self.client.delete(f"/office/admin/dialogue-cache/{ids[0]}")).status_code, 404)
        self.assertGreaterEqual((await self.client.delete("/office/admin/dialogue-cache")).json()["deleted"], 1)
        async with SessionLocal() as db:
            self.assertEqual(await db.scalar(select(func.count()).select_from(OfficeDialogueCache)), 0)


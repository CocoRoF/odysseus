"""AI 실패 턴의 환불 집계와 편집기 조건부 저장 — 일회용 PostgreSQL 에서만 돈다.

ODYSSEUS_OFFICE_INTEGRATION=1 DATABASE_URL=... python -m unittest discover -s tests/integration -p 'test_turn_failures.py'

유닛 테스트는 환불 **결정**을 본다. 여기서는 그 결정이 실제 라우터를 지나 행으로 남고, 한도·게스트
총량·평가자 집계가 JSONB 플래그를 같은 방식으로 세는지를 본다. 저장의 조건부 쓰기는 행 잠금이
걸린 비교라 진짜 트랜잭션 두 개로만 확인할 수 있다.
"""

import asyncio
import os
import unittest
import uuid
from datetime import timedelta
from unittest.mock import AsyncMock, patch

import anthropic
import httpx
import httpx2
from geny_executor.llm_client.anthropic import AnthropicClient
from sqlalchemy import delete, select

from odysseus_api import runqueue
from odysseus_api import workspace as ws
from odysseus_api.ai import agent as agent_ai
from odysseus_api.ai import npc as npc_ai
from odysseus_api.ai.provider import ResolvedAi
from odysseus_api.ai_incidents import incident_counts, incidents, recent_failures, refunded_agent, refunded_messenger
from odysseus_api.config import settings
from odysseus_api.db import Base, SessionLocal, engine
from odysseus_api.definitions import bind_definition, build_assessment_definition
from odysseus_api.deps import get_current_user
from odysseus_api.guests import GuestPolicy, assert_chat_quota
from odysseus_api.main import app
from odysseus_api.migrations import run_schema_migrations
from odysseus_api.models import (
    AgentMessage,
    Assessment,
    AssessmentScenario,
    Attempt,
    MessengerMessage,
    Scenario,
    User,
    utcnow,
)
from odysseus_api.routers import agent as agent_router
from odysseus_api.schemas import AgentSendIn

FAKE_AI = ResolvedAi(provider="anthropic", model="fake", api_key="fake")


def _executor_error(sdk_error):
    try:
        raise AnthropicClient.__new__(AnthropicClient)._classify_error(sdk_error) from sdk_error
    except Exception as e:  # noqa: BLE001
        return e


def _rate_limited():
    req = httpx2.Request("POST", "https://api.anthropic.com/v1/messages")
    resp = httpx2.Response(429, request=req, json={"type": "error", "error": {"message": "slow down"}})
    return _executor_error(anthropic.RateLimitError("Error code: 429", response=resp, body=resp.json()))


def _timed_out():
    return _executor_error(anthropic.APITimeoutError(request=httpx2.Request("POST", "https://api.anthropic.com")))


@unittest.skipUnless(os.getenv("ODYSSEUS_OFFICE_INTEGRATION") == "1", "requires disposable PostgreSQL")
class TurnFailureTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.assertIn("npc", os.environ["DATABASE_URL"], "Refuse a non-test database")
        # Redis 클라이언트는 이벤트 루프에 묶인다 — 테스트마다 새 루프이므로 새로 만든다 (Redis 가 없으면 로컬 폴백).
        runqueue._redis = None
        async with engine.begin() as conn:
            await run_schema_migrations(conn, create_all=Base.metadata.create_all)
        async with SessionLocal() as db:
            self.user = User(
                id=uuid.uuid4(), email=f"{uuid.uuid4()}@test.invalid", name="응시자",
                password_hash="disabled", role="candidate", is_active=True,
            )
            self.scenario = Scenario(
                id=uuid.uuid4(), title="보고서", agent_enabled=True,
                characters=[{"key": "kim", "name": "김과장", "role": "기획"}],
                initial_files=[{"path": "report.md", "content": "초안"}],
            )
            self.assessment = Assessment(id=uuid.uuid4(), title="시험", duration_min=60, agent_max_turns=2)
            db.add_all([self.user, self.scenario, self.assessment])
            await db.flush()
            db.add(AssessmentScenario(assessment_id=self.assessment.id, scenario_id=self.scenario.id))
            await db.flush()
            definition = await build_assessment_definition(db, self.assessment)
            self.attempt = Attempt(
                id=uuid.uuid4(), user_id=self.user.id, assessment_id=self.assessment.id,
                deadline_at=utcnow() + timedelta(hours=1), snapshot={},
            )
            bind_definition(self.attempt, definition)
            db.add(self.attempt)
            await db.commit()
        app.dependency_overrides[get_current_user] = lambda: self.user
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")
        self.base = f"/attempts/{self.attempt.id}/scenarios/{self.scenario.id}"
        self.patches = [
            patch("odysseus_api.routers.messenger.resolve_attempt_ai", AsyncMock(return_value=FAKE_AI)),
            patch("odysseus_api.routers.agent.resolve_attempt_ai", AsyncMock(return_value=FAKE_AI)),
        ]
        for p in self.patches:
            p.start()

    async def asyncTearDown(self):
        for p in self.patches:
            p.stop()
        await self.settle()
        app.dependency_overrides.clear()
        await self.client.aclose()
        async with SessionLocal() as db:
            await db.execute(delete(Assessment).where(Assessment.id == self.assessment.id))
            await db.execute(delete(Scenario).where(Scenario.id == self.scenario.id))
            await db.execute(delete(User).where(User.id == self.user.id))
            await db.commit()
        await engine.dispose()
        if runqueue._redis is not None:
            await runqueue._redis.aclose()
            runqueue._redis = None

    async def settle(self):
        """끊김 기록·lease 해제는 백그라운드 태스크다 — 다음 확인 전에 끝낸다."""
        while agent_router._BACKGROUND:
            await asyncio.gather(*list(agent_router._BACKGROUND), return_exceptions=True)

    async def rows(self, model):
        async with SessionLocal() as db:
            return (
                await db.execute(select(model).where(model.attempt_id == self.attempt.id).order_by(model.created_at))
            ).scalars().all()

    # ── 메신저 ──────────────────────────────────────────────────────────

    async def test_messenger_refunds_are_recorded_once_and_counted_by_every_limit(self):
        seen_envelopes: list[str] = []
        outcomes = [_timed_out(), _timed_out(), None]

        async def complete(res, messages, system="", max_tokens=None):
            seen_envelopes.append(messages[0]["content"])
            outcome = outcomes.pop(0)
            if outcome is not None:
                raise outcome
            return "마감은 금요일이에요."

        with patch.object(npc_ai.provider, "complete_text", complete):
            for _ in range(3):
                r = await self.client.post(f"{self.base}/messenger/kim", json={"content": "마감이 언제인가요?"})
                self.assertEqual(r.status_code, 200, r.text)
            failed_reply = (await self.client.get(f"{self.base}/messenger")).json()[1]

        self.assertEqual(failed_reply["meta"]["error"], "AI_TIMEOUT")
        self.assertTrue(failed_reply["meta"]["refunded"])
        self.assertIn("남은 횟수에 포함되지 않습니다", failed_reply["content"])
        # 세 번째(성공한) 호출의 봉투 — 앞의 실패 교환 두 개는 흔적이 없다
        self.assertNotIn("(시스템)", seen_envelopes[-1])
        self.assertEqual(seen_envelopes[-1].count("마감이 언제인가요?"), 1)

        async with SessionLocal() as db:
            self.assertEqual(await refunded_messenger(db, self.attempt.id), 2)
            # 게스트 총량도 같은 플래그를 뺀다: 보낸 3 - 환불 2 = 1
            await assert_chat_quota(db, attempt_id=self.attempt.id, policy=GuestPolicy(chat_total_per_attempt=2))
            with self.assertRaises(Exception) as over:
                await assert_chat_quota(db, attempt_id=self.attempt.id, policy=GuestPolicy(chat_total_per_attempt=1))
            self.assertEqual(getattr(over.exception, "status_code", None), 429)
            summary = await incidents(db, self.attempt.id)
        self.assertEqual(summary["messenger"], 2)
        self.assertEqual(summary["refunded"], 2)

        # 메신저 한도: 쓴 것은 1건 — 한도가 1이면 다음 전송은 막힌다
        with patch.object(settings, "messenger_max_per_attempt", 1):
            r = await self.client.post(f"{self.base}/messenger/kim", json={"content": "하나 더"})
        self.assertEqual(r.status_code, 429, r.text)

    async def test_legacy_failure_rows_without_the_flag_are_not_refunded(self):
        # 결정은 기록할 때 한다 — 플래그 없이 남은 예전 실패는 코드가 같아도 소급해서 돌려주지 않는다
        async with SessionLocal() as db:
            db.add(MessengerMessage(attempt_id=self.attempt.id, scenario_id=self.scenario.id, character_key="kim",
                                    sender="candidate", content="질문"))
            db.add(MessengerMessage(attempt_id=self.attempt.id, scenario_id=self.scenario.id, character_key="kim",
                                    sender="npc", content="(지금 자리를 비운 것 같습니다)", meta={"error": "AI_TIMEOUT"}))
            await db.commit()
            self.assertEqual(await refunded_messenger(db, self.attempt.id), 0)
            self.assertEqual((await incidents(db, self.attempt.id))["total"], 1)

    # ── 에이전트 ────────────────────────────────────────────────────────

    async def agent_turn(self, client, content="작업해 줘"):
        with patch.object(agent_ai.provider, "build_client", lambda res: client):
            r = await self.client.post(f"{self.base}/agent/messages", json={"content": content})
        self.assertEqual(r.status_code, 200, r.text)
        await self.settle()
        return r.text

    async def usage(self):
        return (await self.client.get(f"/attempts/{self.attempt.id}/agent/usage")).json()

    async def test_agent_refund_depends_on_what_the_candidate_received(self):
        class FailsAtOnce:
            async def create_message(self, **_):
                raise _rate_limited()

        body = await self.agent_turn(FailsAtOnce())
        self.assertIn('"refunded": true', body)
        u = await self.usage()
        self.assertEqual((u["used"], u["remaining"], u["refunded"]), (0, 2, 1))

        class Call:
            tool_use_id, tool_name = "t1", "write_file"
            tool_input = {"path": "notes.md", "content": "에이전트가 쓴 메모"}

        class WritesThenFails:
            calls = 0

            async def create_message(self, **_):
                WritesThenFails.calls += 1
                if WritesThenFails.calls == 1:
                    return type("R", (), {"text": "", "tool_calls": [Call()]})()
                raise _rate_limited()

        body = await self.agent_turn(WritesThenFails())
        self.assertIn('"refunded": false', body)
        u = await self.usage()
        self.assertEqual((u["used"], u["remaining"], u["refunded"]), (1, 1, 1))

        replies = [m for m in await self.rows(AgentMessage) if m.role == "assistant"]
        self.assertEqual(replies[0].meta.get("refunded"), True)
        self.assertNotIn("refunded", replies[1].meta)
        # 실패로 끝났어도 평가자는 무엇이 돌았는지 본다
        self.assertEqual([s["tool"] for s in replies[1].meta["steps"]], ["write_file"])
        async with SessionLocal() as db:
            self.assertIsNotNone(await ws.get_file(db, self.attempt.id, self.scenario.id, "notes.md"))
            self.assertEqual(await refunded_agent(db, self.attempt.id), 1)

    async def open_turn(self, turn, content="오래 걸리는 일"):
        """라우터의 스트림을 직접 열고, 가짜 턴이 ``started`` 를 알린 뒤에 돌려준다."""
        started = asyncio.Event()

        async def fake_turn(*_a, **_k):
            async for ev in turn(started):
                yield ev

        self._turn_patch = patch.object(agent_ai, "run_agent_turn", fake_turn)
        self._turn_patch.start()
        self._db = SessionLocal()
        response = await agent_router.send_agent_message(
            self.attempt.id, self.scenario.id, AgentSendIn(content=content), self.user, self._db
        )
        stream = response.body_iterator
        pending = asyncio.ensure_future(stream.__anext__())
        await asyncio.wait_for(started.wait(), 5)
        return stream, pending

    async def end_from_candidate_side(self, stream, pending):
        """Starlette 가 끊김을 알아챘을 때처럼 — 스트림 태스크를 취소해 제너레이터를 닫는다."""
        if pending.done():
            await stream.aclose()
        else:
            pending.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await pending
        self._turn_patch.stop()
        await self.settle()
        await self._db.close()

    async def last_reply(self):
        return [m for m in await self.rows(AgentMessage) if m.role == "assistant"][-1]

    async def assert_not_an_incident(self):
        async with SessionLocal() as db:
            self.assertEqual((await incidents(db, self.attempt.id))["total"], 0)
            self.assertEqual(await incident_counts(db, [self.attempt.id]), {})
            health = await recent_failures(db, minutes=5)
        # 공급자 장애 배너는 전역 집계라 다른 테스트의 행이 섞일 수 있다 — 응시자가 끝낸 코드가 없는지만 본다
        seen_codes = {code for codes in health["by_model"].values() for code in codes}
        self.assertEqual(seen_codes & {"AI_CANCELLED", "AI_DISCONNECTED", "AI_INTERRUPTED"}, set())

    async def test_stopping_before_anything_is_produced_is_refunded_but_not_an_incident(self):
        async def thinking(started):
            started.set()
            await asyncio.sleep(30)  # 공급자가 아직 답을 만드는 중
            yield {"delta": "늦은 답"}

        stream, pending = await self.open_turn(thinking, content="전부 지워 줘")
        r = await self.client.post(f"/attempts/{self.attempt.id}/agent/cancel")
        self.assertEqual(r.status_code, 200, r.text)
        await self.end_from_candidate_side(stream, pending)

        reply = await self.last_reply()
        self.assertEqual((reply.meta["error"], reply.meta.get("refunded"), reply.content), ("AI_CANCELLED", True, ""))
        u = await self.usage()
        self.assertEqual((u["used"], u["refunded"]), (0, 1))
        await self.assert_not_an_incident()

        # 멈춘 지시는 다음 턴의 맥락에 남지 않는다
        seen: list[list[dict]] = []

        async def answer(db, res, attempt_id, scenario_id, user_id, messages):
            seen.append(list(messages))
            yield {"delta": "b.md 만 지웠습니다"}
            yield {"steps": []}

        with patch.object(agent_ai, "run_agent_turn", answer):
            r = await self.client.post(f"{self.base}/agent/messages", json={"content": "b.md 만 지워 줘"})
        self.assertEqual(r.status_code, 200, r.text)
        await self.settle()
        self.assertEqual(seen[0], [{"role": "user", "content": "b.md 만 지워 줘"}])

    async def test_a_disconnect_before_anything_is_produced_is_refunded_too(self):
        async def thinking(started):
            started.set()
            await asyncio.sleep(30)
            yield {"delta": "늦은 답"}

        stream, pending = await self.open_turn(thinking)
        await self.end_from_candidate_side(stream, pending)  # 새로고침 — [중단] 표시 없음

        reply = await self.last_reply()
        self.assertEqual((reply.meta["error"], reply.meta.get("refunded")), ("AI_DISCONNECTED", True))
        self.assertEqual((await self.usage())["used"], 0)
        await self.assert_not_an_incident()

    async def test_stopping_after_a_tool_started_is_consumed(self):
        async def edits_files(started):
            yield {"tool_started": "write_file"}  # 도구가 돌기 시작했다 — 화면에는 아직 아무것도 안 갔다
            started.set()
            await asyncio.sleep(30)
            yield {"tool": {"name": "write_file", "detail": "app.py"}}

        stream, pending = await self.open_turn(edits_files)
        await self.client.post(f"/attempts/{self.attempt.id}/agent/cancel")
        await self.end_from_candidate_side(stream, pending)

        reply = await self.last_reply()
        self.assertEqual(reply.meta["error"], "AI_INTERRUPTED")
        self.assertNotIn("refunded", reply.meta)
        u = await self.usage()
        self.assertEqual((u["used"], u["refunded"]), (1, 0))
        await self.assert_not_an_incident()

    async def test_disconnecting_after_text_arrived_is_consumed_and_kept(self):
        async def streams_text(started):
            started.set()
            yield {"delta": "살펴보는 중"}
            await asyncio.sleep(30)
            yield {"delta": "끝"}

        stream, pending = await self.open_turn(streams_text)
        self.assertIn("살펴보는 중", await pending)  # 첫 글자는 응시자에게 갔다
        await self.end_from_candidate_side(stream, pending)

        replies = [m for m in await self.rows(AgentMessage) if m.role == "assistant"]
        self.assertEqual(len(replies), 1, "끊긴 턴도 한 행으로 남아야 한다")
        self.assertEqual((replies[0].meta["error"], replies[0].content), ("AI_INTERRUPTED", "살펴보는 중"))
        self.assertNotIn("refunded", replies[0].meta)
        self.assertEqual((await self.usage())["used"], 1)
        await self.assert_not_an_incident()

    # ── 편집기 조건부 저장 ──────────────────────────────────────────────

    async def test_conditional_save_never_overwrites_a_newer_server_change(self):
        async with SessionLocal() as db:
            row, _ = await ws.save_file(db, self.attempt.id, self.scenario.id, "app.py", "v0")
            await db.commit()
            base = ws.content_sha256(row.content)
            # 에이전트가 먼저 고친다
            await ws.save_file(db, self.attempt.id, self.scenario.id, "app.py", "agent", actor="agent")
            await db.commit()

        r = await self.client.put(f"{self.base}/files/content", json={"path": "app.py", "content": "mine", "base_sha256": base})
        self.assertEqual(r.status_code, 409, r.text)
        self.assertEqual(r.json()["detail"]["code"], "FILE_CHANGED")
        self.assertEqual(r.json()["detail"]["sha256"], ws.content_sha256("agent"))

        # 서버에 이미 같은 내용이면(재시도가 먼저 도착한 경우) 충돌이 아니다
        r = await self.client.put(f"{self.base}/files/content", json={"path": "app.py", "content": "agent", "base_sha256": base})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["sha256"], ws.content_sha256("agent"))

        # 명시적으로 덮어쓰기(기준 없이)는 허용된다 — 응시자가 고른 경우다
        r = await self.client.put(f"{self.base}/files/content", json={"path": "app.py", "content": "mine"})
        self.assertEqual(r.status_code, 200, r.text)
        listed = {f["path"]: f["sha256"] for f in (await self.client.get(f"{self.base}/files")).json()}
        self.assertEqual(listed["app.py"], ws.content_sha256("mine"))

        await self.client.delete(f"{self.base}/files?path=app.py")
        r = await self.client.put(f"{self.base}/files/content", json={"path": "app.py", "content": "mine", "base_sha256": listed["app.py"]})
        self.assertEqual(r.status_code, 409, r.text)
        self.assertEqual(r.json()["detail"]["code"], "FILE_DELETED")

    async def test_two_conditional_saves_from_the_same_base_cannot_both_win(self):
        async with SessionLocal() as db:
            row, _ = await ws.save_file(db, self.attempt.id, self.scenario.id, "race.py", "base")
            await db.commit()
        base = ws.content_sha256("base")

        first_locked = asyncio.Event()
        release_first = asyncio.Event()

        async def first():
            async with SessionLocal() as db:
                await ws.save_file(db, self.attempt.id, self.scenario.id, "race.py", "first", base_sha256=base)
                first_locked.set()
                await release_first.wait()
                await db.commit()

        async def second():
            await first_locked.wait()
            async with SessionLocal() as db:
                task = asyncio.ensure_future(
                    ws.save_file(db, self.attempt.id, self.scenario.id, "race.py", "second", base_sha256=base)
                )
                await asyncio.sleep(0.3)
                self.assertFalse(task.done(), "두 번째 저장은 첫 번째가 끝날 때까지 기다려야 한다")
                release_first.set()
                with self.assertRaises(ws.WorkspaceConflict):
                    await task

        await asyncio.gather(first(), second())
        async with SessionLocal() as db:
            self.assertEqual((await ws.get_file(db, self.attempt.id, self.scenario.id, "race.py")).content, "first")


if __name__ == "__main__":
    unittest.main()

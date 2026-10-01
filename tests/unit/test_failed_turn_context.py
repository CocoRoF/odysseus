"""답을 받지 못한 턴은 누구의 말로도 남지 않는다 — NPC 맥락과 자동평가 증거.

실패 행의 본문은 "(시스템) AI 공급자의 호출 한도에 걸렸습니다…" 같은 안내다. 이것이
  · 다음 턴의 NPC 봉투에 들어가면 인물이 장애 안내를 한 것처럼 되고,
  · 재전송한 같은 질문이 두 번 들어가며,
  · 자동평가 증거에 인물 이름으로 들어가면 평가 모델이 장애를 동료의 대답으로 읽는다.
설계 9.2: 실패한 작업을 정상 발화로 저장·제시하지 않는다.
"""

import json
import pathlib
import sys
import unittest
import uuid
from types import SimpleNamespace
from unittest.mock import patch

REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "apps" / "api"))

from odysseus_api.ai import autoeval  # noqa: E402
from odysseus_api.ai.agent import conversation_context  # noqa: E402
from odysseus_api.ai.npc import build_turn_message, without_failed_exchanges  # noqa: E402

CHARACTER = {"key": "kim", "name": "김과장"}
FAILURE_TEXT = "(시스템) AI 공급자의 호출 한도에 걸렸습니다. 잠시 후 다시 시도하세요 — 이 질문은 남은 횟수에 포함되지 않습니다."


def msg(sender, content, **meta):
    return SimpleNamespace(sender=sender, content=content, meta=meta, character_key="kim", created_at=None)


class NpcHistoryTests(unittest.TestCase):
    def test_retry_after_a_failure_reads_as_one_question(self):
        history = [
            msg("npc", "안녕하세요, 보고서 건으로 연락드렸어요.", opening=True),
            msg("candidate", "마감이 언제인가요?"),
            msg("npc", FAILURE_TEXT, error="AI_RATE_LIMIT", refunded=True),
            msg("candidate", "마감이 언제인가요?"),
        ]
        envelope = build_turn_message(CHARACTER, history)
        self.assertNotIn("(시스템)", envelope)
        self.assertNotIn("AI 공급자", envelope)
        self.assertEqual(envelope.count("마감이 언제인가요?"), 1, envelope)
        self.assertTrue(envelope.endswith("[방금 상대가 보낸 메시지]\n마감이 언제인가요?"), envelope)
        self.assertIn("김과장: 안녕하세요, 보고서 건으로 연락드렸어요.", envelope)

    def test_only_the_failed_exchange_is_removed(self):
        history = [
            msg("candidate", "자료 위치 알려 주세요"),
            msg("npc", "data 폴더에 있어요"),
            msg("candidate", "형식은요?"),
            msg("npc", "(시스템) AI 처리 중 오류가 났습니다", error="AI_BACKEND_ERROR"),
            msg("candidate", "그럼 담당자는 누구죠?"),
        ]
        kept = without_failed_exchanges(history)
        self.assertEqual(
            [m.content for m in kept], ["자료 위치 알려 주세요", "data 폴더에 있어요", "그럼 담당자는 누구죠?"]
        )

    def test_a_normal_thread_is_untouched(self):
        history = [msg("npc", "첫 인사", opening=True), msg("candidate", "질문"), msg("npc", "답"), msg("candidate", "다음")]
        self.assertEqual(without_failed_exchanges(history), history)


def row(role, content, **meta):
    return SimpleNamespace(role=role, content=content, meta=meta)


class AgentContextTests(unittest.TestCase):
    """에이전트 다음 턴의 맥락 — 일어나지 않은 교환은 없고, 반쯤 된 일은 반쯤 됐다고 적힌다."""

    def test_a_stopped_request_with_nothing_produced_leaves_no_trace(self):
        rows = [
            row("user", "파일 목록 보여 줘"),
            row("assistant", "a.md, b.md 가 있습니다", steps=[{"tool": "list_files", "detail": ""}]),
            row("user", "전부 지워 줘"),  # 잘못 지시했다는 걸 깨닫고 멈췄다
            row("assistant", "", error="AI_CANCELLED", refunded=True, steps=[]),
            row("user", "b.md 만 지워 줘"),
            row("assistant", "", error="AI_TIMEOUT", refunded=True, steps=[]),
        ]
        self.assertEqual(
            conversation_context(rows),
            [
                {"role": "user", "content": "파일 목록 보여 줘"},
                {"role": "assistant", "content": "a.md, b.md 가 있습니다"},
            ],
        )

    def test_an_interrupted_turn_is_kept_and_marked(self):
        rows = [
            row("user", "리팩터링해 줘"),
            row("assistant", "", error="AI_INTERRUPTED", steps=[{"tool": "write_file", "detail": "app.py"}]),
            row("user", "이어서 해 줘"),
            row("assistant", "테스트까지 고쳤", error="AI_INTERRUPTED", steps=[]),
        ]
        ctx = conversation_context(rows)
        self.assertEqual([m["role"] for m in ctx], ["user", "assistant", "user", "assistant"])
        self.assertIn("끝나기 전에 멈췄습니다", ctx[1]["content"])
        self.assertIn("write_file", ctx[1]["content"])
        self.assertTrue(ctx[3]["content"].startswith("테스트까지 고쳤"))
        self.assertIn("끝나기 전에 멈췄습니다", ctx[3]["content"])

    def test_a_question_whose_turn_left_no_record_is_dropped(self):
        # 턴 도중 프로세스가 사라져 답 행이 없다 — 연속한 사용자 메시지는 역할 교대를 깨뜨린다
        rows = [row("user", "첫 질문"), row("user", "둘째 질문"), row("assistant", "둘째 답")]
        self.assertEqual(
            conversation_context(rows),
            [{"role": "user", "content": "둘째 질문"}, {"role": "assistant", "content": "둘째 답"}],
        )
        self.assertEqual(conversation_context([row("assistant", "잘린 답"), row("user", "끝에 남은 질문")]), [])


class _Rows:
    def __init__(self, rows):
        self._rows = rows

    def scalars(self):
        return self

    def all(self):
        return self._rows


class _FakeDb:
    """gather_evidence 가 부르는 순서대로 행을 돌려준다 — 메신저, 에이전트, 실행, 이벤트."""

    def __init__(self, *results):
        self._results = list(results)

    async def execute(self, _query):
        return _Rows(self._results.pop(0))


class EvaluationEvidenceTests(unittest.IsolatedAsyncioTestCase):
    async def gather(self, messenger, agent):
        scenario = SimpleNamespace(
            id=uuid.uuid4(),
            title="보고서",
            characters=[CHARACTER],
            rubric=None,
            objectives_md="숨은 목표",
            initial_files=[],
            desktop_apps=[],
            agent_enabled=True,
        )
        attempt = SimpleNamespace(id=uuid.uuid4())

        async def no_files(*_a, **_k):
            return []

        with patch.object(autoeval.ws, "list_files", no_files):
            return await autoeval.gather_evidence(_FakeDb(messenger, agent, [], []), attempt, scenario, [])

    async def test_failed_npc_turn_is_a_system_failure_not_the_characters_words(self):
        ev = await self.gather(
            [
                msg("candidate", "마감이 언제인가요?"),
                msg("npc", FAILURE_TEXT, error="AI_RATE_LIMIT", refunded=True),
            ],
            [],
        )
        messenger = ev["untrusted_evidence"]["messenger"]
        self.assertEqual(messenger[0], {"thread": "김과장", "from": "candidate", "text": "마감이 언제인가요?"})
        self.assertEqual(messenger[1], {"thread": "김과장", "from": "system", "error": "AI_RATE_LIMIT"})
        self.assertNotIn("(시스템)", json.dumps(ev["untrusted_evidence"], ensure_ascii=False))
        notes = " ".join(ev["trusted"]["server_notes"])
        self.assertIn("답을 받지 못한 턴", notes)

    async def test_agent_failures_keep_what_was_received_and_mark_the_rest(self):
        ev = await self.gather(
            [],
            [
                SimpleNamespace(role="user", content="파일 정리해 줘", meta={}),
                SimpleNamespace(role="assistant", content="", meta={"error": "AI_TIMEOUT", "refunded": True, "steps": []}),
                SimpleNamespace(role="user", content="다시 해 줘", meta={}),
                SimpleNamespace(
                    role="assistant",
                    content="두 파일을 옮겼습니다",
                    meta={"error": "AI_DISCONNECTED", "steps": [{"tool": "move_file", "detail": "a → b"}]},
                ),
            ],
        )
        agent = ev["untrusted_evidence"]["agent"]
        self.assertEqual(agent[1], {"role": "system", "error": "AI_TIMEOUT"})
        self.assertEqual(
            agent[3], {"role": "agent", "text": "두 파일을 옮겼습니다", "error": "AI_DISCONNECTED", "tools": ["move_file"]}
        )

    async def test_no_failure_note_when_nothing_failed(self):
        ev = await self.gather([msg("candidate", "안녕하세요"), msg("npc", "네 안녕하세요")], [])
        self.assertNotIn("답을 받지 못한 턴", " ".join(ev["trusted"]["server_notes"]))


if __name__ == "__main__":
    unittest.main()

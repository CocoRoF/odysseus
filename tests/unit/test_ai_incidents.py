"""AI 실패가 질문 한도를 어떻게 바꾸는가 — 환불 결정과 오류 분류의 동작.

질문 한도는 응시 전략의 일부다. 그래서 두 방향이 똑같이 중요하다.
  1. 공급자가 답을 **하나도** 만들지 못했으면 그 질문은 소모되지 않는다.
  2. 한 글자라도 받았거나 도구가 돌기 시작했으면 소모된다 — 응시자가 멈추거나 끊었어도 같다.
     그렇지 않으면 에이전트가 일하는 것을 보고 멈추는 것이 공짜 질문이 된다.

분류는 실제 예외로 확인한다. 공급자 SDK → geny-executor → 우리 분류기를 거치는 경로가
문자열 추측에 기대면, 429 가 "기타 오류" 가 되거나 Redis 장애가 "AI 공급자에 연결할 수
없습니다" 가 된다 — 둘 다 안내가 거짓이 되고 환불이 틀린다.
"""

import pathlib
import sys
import unittest
from unittest.mock import patch

REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "apps" / "api"))

import anthropic  # noqa: E402
import httpx2  # noqa: E402
import openai  # noqa: E402
import redis.exceptions  # noqa: E402
from geny_executor.core.errors import APIError, ErrorCategory  # noqa: E402
from geny_executor.llm_client._cli_runtime import CLIResult, CLITimeout  # noqa: E402
from geny_executor.llm_client.anthropic import AnthropicClient  # noqa: E402
from geny_executor.llm_client.claude_code import _classify_cli_result  # noqa: E402
from geny_executor.llm_client.openai import OpenAIClient  # noqa: E402

from odysseus_api.ai import agent as agent_ai  # noqa: E402
from odysseus_api.ai import npc  # noqa: E402
from odysseus_api.ai.errors import PUBLIC_MESSAGES, ProviderCallError, classify, public_meta  # noqa: E402
from odysseus_api.ai.provider import ResolvedAi  # noqa: E402
from odysseus_api.ai_incidents import (  # noqa: E402
    CANDIDATE_ENDED_CODES,
    PROVIDER_FAULT_CODES,
    REFUNDABLE_CODES,
    candidate_ended_code,
    failure_meta,
    refund_decision,
)


class RefundDecisionTests(unittest.TestCase):
    def test_provider_fault_with_nothing_received_is_refunded(self):
        for code in ("AI_TIMEOUT", "AI_RATE_LIMIT", "AI_QUOTA", "AI_AUTH", "AI_UNAVAILABLE"):
            self.assertTrue(refund_decision(code, produced_output=False, tools_started=False), code)

    def test_any_received_text_consumes_the_question(self):
        # 답을 읽을 만큼 받은 뒤 공급자가 끊긴 턴 — 돌려주면 한도에 가까울수록 이득이 된다
        for code in REFUNDABLE_CODES:
            self.assertFalse(refund_decision(code, produced_output=True, tools_started=False), code)

    def test_a_started_tool_consumes_the_question(self):
        # 에이전트가 파일을 고친 뒤 다음 호출에서 429 — 워크스페이스는 이미 바뀌었다
        for code in REFUNDABLE_CODES:
            self.assertFalse(refund_decision(code, produced_output=False, tools_started=True), code)

    def test_unclassified_failures_are_not_refunded(self):
        for code in ("AI_BACKEND_ERROR", "AI_BAD_RESPONSE", None, "", "SOMETHING_ELSE"):
            self.assertFalse(refund_decision(code, produced_output=False, tools_started=False), code)

    def test_candidate_ended_turn_follows_the_same_rule_as_an_outage(self):
        # 멈췄든 끊겼든 아무것도 나오기 전이면 쓰인 질문이 아니다
        for stopped in (True, False):
            code = candidate_ended_code(stopped=stopped, produced_output=False, tools_started=False)
            self.assertEqual(code, "AI_CANCELLED" if stopped else "AI_DISCONNECTED")
            self.assertTrue(refund_decision(code, produced_output=False, tools_started=False), code)

    def test_stopping_after_output_or_a_started_tool_is_consumed(self):
        # 에이전트가 파일을 고치는 것을 보고 [중단] — 누가 끝냈든 무엇이 나왔는가가 기준이다
        for stopped in (True, False):
            for produced, tools in ((True, False), (False, True), (True, True)):
                code = candidate_ended_code(stopped=stopped, produced_output=produced, tools_started=tools)
                self.assertEqual(code, "AI_INTERRUPTED")
                self.assertFalse(refund_decision(code, produced_output=produced, tools_started=tools))
        # 코드만 보고 돌려주는 경로가 없다 — 이름이 CANCELLED 여도 무언가 나왔으면 소모
        self.assertFalse(refund_decision("AI_CANCELLED", produced_output=False, tools_started=True))
        self.assertFalse(refund_decision("AI_INTERRUPTED", produced_output=False, tools_started=False))

    def test_candidate_ended_codes_are_never_provider_faults(self):
        self.assertEqual(CANDIDATE_ENDED_CODES & REFUNDABLE_CODES, frozenset())
        self.assertEqual(CANDIDATE_ENDED_CODES & PROVIDER_FAULT_CODES, frozenset())

    def test_every_code_has_candidate_facing_copy(self):
        for code in REFUNDABLE_CODES | CANDIDATE_ENDED_CODES:
            self.assertIn(code, PUBLIC_MESSAGES)

    def test_failure_meta_records_the_decision_once(self):
        self.assertEqual(
            failure_meta("AI_TIMEOUT", "cid1", produced_output=False, tools_started=False),
            {"error": "AI_TIMEOUT", "correlation_id": "cid1", "refunded": True},
        )
        self.assertEqual(
            failure_meta("AI_TIMEOUT", "cid2", produced_output=False, tools_started=True),
            {"error": "AI_TIMEOUT", "correlation_id": "cid2"},
        )
        self.assertEqual(
            failure_meta("AI_DISCONNECTED", produced_output=False, tools_started=False),
            {"error": "AI_DISCONNECTED", "refunded": True},
        )
        self.assertEqual(
            failure_meta("AI_INTERRUPTED", produced_output=True, tools_started=False),
            {"error": "AI_INTERRUPTED"},
        )


class PublicMetaTests(unittest.TestCase):
    def test_refund_flag_reaches_the_candidate_only_as_recorded(self):
        out = public_meta({"error": "AI_RATE_LIMIT", "correlation_id": "abc123", "refunded": True})
        self.assertEqual(out["error"], "AI_RATE_LIMIT")
        self.assertEqual(out["error_message"], PUBLIC_MESSAGES["AI_RATE_LIMIT"])
        self.assertTrue(out["refunded"])
        self.assertNotIn("refunded", public_meta({"error": "AI_RATE_LIMIT"}))
        # 문자열 "true" 같은 흉내는 플래그가 아니다
        self.assertNotIn("refunded", public_meta({"error": "AI_RATE_LIMIT", "refunded": "true"}))

    def test_unknown_codes_are_downgraded_and_internal_keys_dropped(self):
        out = public_meta({"error": "SOMETHING_INTERNAL sk-secret", "guard": "meta_leak", "office_social": "x"})
        self.assertEqual(out, {"error": "AI_BACKEND_ERROR", "error_message": PUBLIC_MESSAGES["AI_BACKEND_ERROR"]})


def _anthropic_status(cls, status: int, message: str):
    req = httpx2.Request("POST", "https://api.anthropic.com/v1/messages")
    resp = httpx2.Response(status, request=req, json={"type": "error", "error": {"message": message}})
    return cls(f"Error code: {status} - {message}", response=resp, body=resp.json())


def _through_executor(client_cls, sdk_error):
    """실제 실행기가 하듯 SDK 예외를 APIError 로 바꾸고 원인을 남긴다."""
    client = client_cls.__new__(client_cls)
    try:
        raise client._classify_error(sdk_error) from sdk_error
    except APIError as e:
        return e


def _cli_timeout():
    try:
        try:
            raise CLITimeout("stream timeout after 300.0s")
        except CLITimeout as inner:
            raise APIError(f"{inner} [cli_version=2.1.0]", category=ErrorCategory.CLI_TIMEOUT) from inner
    except APIError as e:
        return e


class ProviderClassificationTests(unittest.TestCase):
    def code(self, e):
        return classify(ProviderCallError(e), provider_only=True)

    def test_anthropic_errors_through_the_executor(self):
        req = httpx2.Request("POST", "https://api.anthropic.com/v1/messages")
        cases = {
            "AI_RATE_LIMIT": _anthropic_status(anthropic.RateLimitError, 429, "per-minute token limit"),
            "AI_TIMEOUT": anthropic.APITimeoutError(request=req),
            "AI_UNAVAILABLE": anthropic.APIConnectionError(request=req),
            "AI_AUTH": _anthropic_status(anthropic.AuthenticationError, 401, "invalid x-api-key"),
            "AI_QUOTA": _anthropic_status(
                anthropic.BadRequestError, 400, "Your credit balance is too low to access the Anthropic API."
            ),
        }
        for expected, sdk_error in cases.items():
            self.assertEqual(self.code(_through_executor(AnthropicClient, sdk_error)), expected, repr(sdk_error))

    def test_openai_insufficient_quota_is_quota_not_a_retryable_rate_limit(self):
        req = httpx2.Request("POST", "https://api.openai.com/v1/chat/completions")
        resp = httpx2.Response(
            429, request=req, json={"error": {"type": "insufficient_quota", "code": "insufficient_quota"}}
        )
        sdk_error = openai.RateLimitError(
            "Error code: 429 - {'error': {'type': 'insufficient_quota'}}", response=resp, body=resp.json()
        )
        self.assertEqual(self.code(_through_executor(OpenAIClient, sdk_error)), "AI_QUOTA")

    def test_bad_request_is_not_the_providers_fault(self):
        sdk_error = _anthropic_status(anthropic.BadRequestError, 400, "messages: text content blocks must be non-empty")
        self.assertEqual(self.code(_through_executor(AnthropicClient, sdk_error)), "AI_BACKEND_ERROR")

    def test_claude_code_cli_failures(self):
        # 300 초 스트림 타임아웃 — 예전 분류는 "timed out" 문구만 찾아 이것을 기타 오류로 셌다
        self.assertEqual(self.code(_cli_timeout()), "AI_TIMEOUT")
        usage = _classify_cli_result(
            CLIResult(returncode=1, stdout=b"", stderr=b"Claude AI usage limit reached|1760000000", duration_ms=10)
        )
        self.assertEqual(self.code(usage), "AI_QUOTA")
        hourly = _classify_cli_result(
            CLIResult(returncode=1, stdout=b"", stderr=b"5-hour limit reached \xe2\x88\x99 resets 3pm", duration_ms=10)
        )
        self.assertEqual(self.code(hourly), "AI_QUOTA")
        crashed = _classify_cli_result(CLIResult(returncode=1, stdout=b"", stderr=b"segfault", duration_ms=10))
        self.assertEqual(self.code(crashed), "AI_BACKEND_ERROR")

    def test_tool_side_failures_never_get_provider_codes(self):
        for e in (
            redis.exceptions.ConnectionError("Error 111 connecting to redis:6379. Connection refused."),
            ConnectionError("connection reset"),
            TimeoutError("run timed out"),
        ):
            self.assertEqual(classify(e, provider_only=True), "AI_BACKEND_ERROR", repr(e))


class ProviderBoundaryTests(unittest.IsolatedAsyncioTestCase):
    """공급자 호출만 껍질을 쓰는가 — 실제 에이전트 루프와 NPC 생성기로 확인한다."""

    res = ResolvedAi(provider="anthropic", model="fake", api_key="fake")

    async def _drain(self, gen):
        events = []
        try:
            async for ev in gen:
                events.append(ev)
        except BaseException as e:  # noqa: BLE001
            return events, e
        return events, None

    async def test_redis_failure_inside_a_tool_is_not_a_provider_outage(self):
        class Call:
            tool_use_id, tool_name, tool_input = "t1", "run_command", {"command": "python main.py"}

        class Response:
            text, tool_calls = "", [Call()]

        class Client:
            async def create_message(self, **_):
                return Response()

        async def tool(*_a, **_k):
            raise redis.exceptions.ConnectionError("Error 111 connecting to redis:6379. Connection refused.")

        with patch.object(agent_ai.provider, "build_client", lambda res: Client()), patch.object(
            agent_ai, "execute_agent_tool", tool
        ):
            events, error = await self._drain(
                agent_ai.run_agent_turn(None, self.res, None, None, None, [{"role": "user", "content": "실행해 줘"}])
            )
        self.assertIn({"tool_started": "run_command"}, events, "도구가 돌기 시작했다는 사실이 환불 판단에 가야 한다")
        self.assertNotIsInstance(error, ProviderCallError)
        self.assertEqual(classify(error, provider_only=True), "AI_BACKEND_ERROR")

    async def test_provider_failure_in_the_tool_loop_is_marked(self):
        class Client:
            async def create_message(self, **_):
                raise _through_executor(AnthropicClient, _anthropic_status(anthropic.RateLimitError, 429, "slow down"))

        with patch.object(agent_ai.provider, "build_client", lambda res: Client()):
            events, error = await self._drain(
                agent_ai.run_agent_turn(None, self.res, None, None, None, [{"role": "user", "content": "안녕"}])
            )
        self.assertEqual(events, [])
        self.assertIsInstance(error, ProviderCallError)
        self.assertEqual(classify(error, provider_only=True), "AI_RATE_LIMIT")

    async def test_provider_client_that_cannot_be_built_is_a_provider_failure(self):
        def broken(res):
            raise _through_executor(AnthropicClient, anthropic.APIConnectionError(
                request=httpx2.Request("POST", "https://api.anthropic.com/v1/messages")))

        with patch.object(agent_ai.provider, "build_client", broken):
            _events, error = await self._drain(
                agent_ai.run_agent_turn(None, self.res, None, None, None, [{"role": "user", "content": "안녕"}])
            )
        self.assertIsInstance(error, ProviderCallError)
        self.assertEqual(classify(error, provider_only=True), "AI_UNAVAILABLE")

    async def test_npc_reply_marks_the_provider_call(self):
        async def fail(*_a, **_k):
            raise anthropic.APITimeoutError(request=httpx2.Request("POST", "https://api.anthropic.com/v1/messages"))

        class Scenario:
            id = "s"
            characters = [{"key": "k", "name": "동료"}]
            npc_base_prompt = ""
            npc_policy_version = 0
            objectives_md = ""

        with patch.object(npc.provider, "complete_text", fail):
            with self.assertRaises(ProviderCallError) as caught:
                await npc.generate_reply(self.res, Scenario(), {"key": "k", "name": "동료"}, [])
        self.assertEqual(classify(caught.exception, provider_only=True), "AI_TIMEOUT")


if __name__ == "__main__":
    unittest.main()

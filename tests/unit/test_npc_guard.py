"""NPC 답장의 프롬프트 누출 가드 — 서버 없이 검사한다.

피드백에서 실제로 잡힌 사례: 데이터 분석가 NPC 가 "태호는 반말과 재촉(...) 섞인 말투에 대해
규칙에 따라 반응해야 함. (...) 규칙 4: 'Disrespect compounds; while insulted you do not
discuss the work at all...'" 를 답장 본문으로 내보냈다. 응시자에게 프롬프트가 그대로 보인 것이다.
"""

import pathlib
import sys
import unittest

REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "apps" / "api"))

from odysseus_api.ai.npc import (  # noqa: E402
    META_FALLBACK,
    meta_guard,
    meta_leak,
    strip_reasoning,
)
from odysseus_api.ai.npc_prompt import BASE_RULES  # noqa: E402

LEAKED_REPLY = (
    "태호는 반말과 재촉(\"아니 알려줘;;\") 섞인 말투에 대해 규칙에 따라 반응해야 함. 이미 정상 요청으로 "
    "넘어갔다가 다시 무례한 말투로 돌아온 상황 - 이건 \"compound\"되는 상황이고, 이미 한번 리페어가 "
    "있었으므로 다시 반응해야 함.\n\n앞서 이미 한 번 사과/존댓말 복구가 있었고, 방금 다시 반말로 돌아왔다. "
    "규칙 4: \"Disrespect compounds; while insulted you do not discuss the work at all... a second round "
    "is not a fresh start.\" 즉 다시 존댓말로 안 돌아오면 협조 안 함, 짧고 담담하게."
)


class MetaLeakTests(unittest.TestCase):
    def test_reported_leak_is_caught(self):
        self.assertIsNotNone(meta_leak(LEAKED_REPLY))

    def test_rule_number_in_korean_is_caught(self):
        self.assertIsNotNone(meta_leak("규칙 4에 따라 지금은 업무 얘기를 하지 않겠습니다."))

    def test_verbatim_rule_fragment_is_caught(self):
        # 규칙 원문의 한 문장이 그대로 실려 나온 경우 — 패턴이 없어도 조각 대조로 잡는다
        self.assertIsNotNone(meta_leak("You never mirror their register — you answer in yours and let them notice the gap."))

    def test_envelope_header_is_caught(self):
        self.assertIsNotNone(meta_leak("[메신저 대화 — 지금까지]\n상대: 안녕하세요"))

    def test_normal_korean_reply_passes(self):
        for reply in (
            "네, data/requests.jsonl 돌려서 total_requests, error_requests 까지 정리해 드릴게요.",
            "그 부분은 정하늘님 소관이라 그쪽에 여쭤보시는 게 빠를 거예요.",
            "p95 는 nearest-rank 방식입니다. 성공 요청만 모아 오름차순 정렬하고 ceil(0.95*n)-1 번째 값이에요.",
            "처음 뵙는 분 같은데, 어느 팀이세요?",
            "config/routing.yaml 의 rules 는 위에서부터 먼저 매치되는 규칙이 이깁니다.",
            "rules 에 규칙 2개를 legacy-extract-sample 보다 위에 추가하시면 됩니다.",
            "지금은 rules 3개가 있는데 실제로 매치되는 건 하나뿐이에요.",
        ):
            self.assertIsNone(meta_leak(reply), reply)

    def test_knowledge_with_english_keys_passes(self):
        # 인물 카드의 knowledge 를 그대로 옮긴 답장 — 영어 키가 많아도 프롬프트 누출이 아니다
        reply = (
            '{"total_requests": 1200, "error_requests": 31, "slow_requests": 88, "cache_hits": 240, '
            '"p95_latency_ms": {"llm-large": 2100, "llm-small": 640}}'
        )
        self.assertIsNone(meta_leak(reply))

    def test_scenario_specific_rules_are_used_when_given(self):
        custom = "Always answer in exactly one sentence and never mention the weather forecast."
        # 규칙 원문 한 문장이 통째로 실려 나온 경우
        self.assertIsNotNone(
            meta_leak("Always answer in exactly one sentence and never mention the weather forecast — 그게 제 원칙이에요.", custom)
        )
        # 전역 규칙 조각은 시나리오별 규칙을 쓸 때 대조 대상이 아니다
        self.assertIsNone(meta_leak("You never mirror their register — you answer in yours and let them notice the gap.", custom))
        self.assertIsNotNone(meta_leak("You never mirror their register — you answer in yours and let them notice the gap.", BASE_RULES))


class StripReasoningTests(unittest.TestCase):
    def test_think_block_is_removed(self):
        self.assertEqual(strip_reasoning("<think>규칙 4를 적용해야 한다</think>\n네, 알겠습니다."), "네, 알겠습니다.")

    def test_no_block_is_untouched(self):
        self.assertEqual(strip_reasoning("  네, 알겠습니다. "), "네, 알겠습니다.")


class MetaGuardTests(unittest.TestCase):
    def test_leak_is_replaced_and_reported(self):
        reply, hit = meta_guard(LEAKED_REPLY)
        self.assertEqual(reply, META_FALLBACK)
        self.assertTrue(hit)

    def test_reasoning_block_alone_does_not_trip(self):
        reply, hit = meta_guard("<think>규칙 4 적용</think>지금은 그 얘기를 하고 싶지 않네요.")
        self.assertIsNone(hit)
        self.assertEqual(reply, "지금은 그 얘기를 하고 싶지 않네요.")


if __name__ == "__main__":
    unittest.main()

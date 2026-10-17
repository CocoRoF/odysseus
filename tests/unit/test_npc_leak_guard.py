"""NPC 누출 가드가 인물이 아는 것을 막지 않는가 (ai/npc.leak_guard).

숨은 목표의 문장과 인물의 지식은 같은 값을 말하는 일이 많다. 예전 가드는 숫자 안의 점에서 문장을 끊어
"--gpu-memory-utilization 0" 같은 반쪽 조각을 만들었고, ML 엔지니어가 자기가 아는 설정값을 말하기만 해도
답장이 "제가 말씀드릴 수 있는 부분이 아니에요" 로 바뀌었다(Odysseus 운영, vLLM 시나리오).
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "apps", "api"))

from odysseus_api.ai.npc import DEFLECTION, leak_guard, secret_fragments  # noqa: E402
from odysseus_api.scenarios import DEFAULT_SCENARIOS  # noqa: E402


def _scenario(prefix: str) -> dict:
    return next(s for s in DEFAULT_SCENARIOS if s["title"].startswith(prefix))


def _known(spec: dict, key: str) -> str:
    ch = next(c for c in spec["characters"] if c["key"] == key)
    return f"{ch.get('knowledge') or ''}\n{ch.get('persona') or ''}"


class LeakGuardTests(unittest.TestCase):
    def test_engineer_can_state_own_settings(self):
        spec = _scenario("LLM 추론 서비스가 GPU")
        # 넷 다 고치기 전의 가드가 얼버무림으로 바꾸던 답장이다
        replies = (
            "`--gpu-memory-utilization 0.90` 으로 두세요.",
            "Qwen2.5-14B bf16 가중치 ≈ 27.5GB 라 A10 한 장엔 안 들어가요.",
            "옵션은 `--tensor-parallel-size 2`, `--gpu-memory-utilization 0.90`, `--max-model-len 8192` 입니다.",
            "가중치만 27.5GB, TP 2 필요, utilization 0.90, max-model-len 8192, /health 로 헬스체크 하시면 돼요.",
        )
        for reply in replies:
            out, hit = leak_guard(reply, spec["objectives_md"], _known(spec, "ml_jihoon"))
            self.assertFalse(hit, reply)
            self.assertEqual(out, reply)

    def test_numbers_do_not_split_fragments(self):
        spec = _scenario("LLM 추론 서비스가 GPU")
        for frag in secret_fragments(spec["objectives_md"]):
            self.assertFalse(frag.endswith(" 0"), frag)

    def test_secret_outside_knowledge_is_still_blocked(self):
        spec = _scenario("LLM 추론 서비스가 GPU")
        # 숨은 목표의 판단(세 구간이 각각 다른 원인)은 ML 엔지니어의 지식에 없다
        reply = "제가 보기엔 로그 세 구간이 각각 다른 원인이다 싶어요."
        out, hit = leak_guard(reply, spec["objectives_md"], _known(spec, "ml_jihoon"))
        self.assertTrue(hit)
        self.assertEqual(out, DEFLECTION)

    def test_without_knowledge_behaves_as_before(self):
        objectives = "- 결과 파일 이름은 aurora.txt 여야 하고 refunded 주문은 제외한다\n"
        out, hit = leak_guard("결과 파일 이름은 aurora.txt 여야 하고 refunded 주문은 제외한다", objectives)
        self.assertTrue(hit)

    def test_markup_does_not_hide_a_leak(self):
        objectives = "- 결과 파일 이름은 aurora.txt 여야 하고 refunded 주문은 제외한다\n"
        out, hit = leak_guard("**결과 파일 이름은 `aurora.txt` 여야 하고 refunded 주문은 제외한다**", objectives)
        self.assertTrue(hit)


if __name__ == "__main__":
    unittest.main()

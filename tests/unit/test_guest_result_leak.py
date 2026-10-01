"""게스트 결과 화면은 정답지를 옮겨 적은 문장을 내보내지 않는다."""

import unittest
from types import SimpleNamespace

from odysseus_api.guest_result import _answer_corpus, _scenario_view, _shares_answer

OBJECTIVES = """
- 박준영이 실제로 원하는 것: 10:00~16:00 응답 가능 + **화·목 동기화 회의**.
- 시행일 **2026-11-02**, 재점검 **2027-02-02**
- `output/agreement.md` — 합의 내용, 응답 시간대, 시행일·재점검일
"""


class LeakFilterTests(unittest.TestCase):
    def setUp(self):
        self.corpus = _answer_corpus(
            SimpleNamespace(objectives_md=OBJECTIVES, checks=[{"label": "합의문 작성", "path": "output/agreement.md"}])
        )

    def test_answer_phrase_is_caught(self):
        # 2026-09-20 운영에서 실제로 새어 나간 문장
        leaked = "박준영에게 먼저 배경과 확인 사항을 질문하여 표면 요구 이면의 진짜 목적(화·목 회의, 응답시간대)을 일부 파악함"
        self.assertTrue(_shares_answer(leaked, self.corpus))
        self.assertTrue(_shares_answer("시행일을 2026-11-02 로 잡았다", self.corpus))
        self.assertTrue(_shares_answer("output/agreement.md 를 만들었다", self.corpus))

    def test_plain_action_passes(self):
        self.assertFalse(_shares_answer("박준영에게 먼저 배경을 물었다", self.corpus))
        self.assertFalse(_shares_answer("정소민에게 확인이 필요하다는 사실을 스스로 알아챘다", self.corpus))
        self.assertFalse(_shares_answer("", self.corpus))

    def test_view_drops_only_the_leaking_strength(self):
        row = {
            "title": "t", "points": 100, "score_pct": 10, "earned_points": 10, "checks": [],
            "process": [], "result": [],
            "strengths": ["박준영에게 먼저 배경을 물었다", "응답 시간대와 화·목 회의를 알아냄"],
        }
        view = _scenario_view(row, self.corpus)
        self.assertEqual(view["strengths"], ["박준영에게 먼저 배경을 물었다"])


if __name__ == "__main__":
    unittest.main()

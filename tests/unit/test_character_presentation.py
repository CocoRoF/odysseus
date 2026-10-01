"""기본 제공 인물의 겉모습 설정 — 성별과 사무실 인사말.

성별은 **아바타를 고르지 않았을 때 후보를 좁히는** 값이다. 비어 있으면 전체에서
고르므로 김수진에게 남성 아바타가 붙을 수 있다. 그건 무작위가 아니라 틀린 것이다.

사무실 인사말은 응시를 **시작하기 전** 화면에서 나온다. 그래서 여기에는 문제에 대한
정보가 있으면 안 된다 — 요구사항은 응시를 시작한 뒤 메신저에서만 오간다.
"""

import pathlib
import sys
import unittest

REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "apps" / "api"))

from odysseus_api.scenarios import DEFAULT_SCENARIOS  # noqa: E402
from odysseus_api.schemas import CharacterIn  # noqa: E402

CHARACTERS = [(s["title"], c) for s in DEFAULT_SCENARIOS for c in (s.get("characters") or [])]


class FieldTests(unittest.TestCase):
    def test_every_character_has_a_gender(self):
        missing = [c["key"] for _, c in CHARACTERS if c.get("gender") not in ("female", "male")]
        self.assertEqual(missing, [], "성별이 없으면 아바타가 성별을 무시하고 배정된다")

    def test_every_character_has_an_encounter_line(self):
        missing = [c["key"] for _, c in CHARACTERS if not (c.get("encounter") or "").strip()]
        self.assertEqual(missing, [], "인사말이 없으면 모두 같은 일반 문구로 맞이한다")

    def test_lines_fit_the_box(self):
        long = [c["key"] for _, c in CHARACTERS if len(c.get("encounter", "")) > 200]
        self.assertEqual(long, [], "대화 상자가 담지 못한다 (스키마 상한 200자)")

    def test_schema_accepts_them(self):
        for _, c in CHARACTERS:
            CharacterIn.model_validate(c)


class NoSpoilerTests(unittest.TestCase):
    """인사말이 문제의 답이나 과제를 흘리지 않는가."""

    #: 산출물·경로·수치처럼 '무엇을 해야 하는가'로 읽히는 흔적
    TELLS = ("output/", ".csv", ".md", ".py", "파일로", "저장해", "제출", "만들어 주세요", "고쳐")

    def test_no_task_shaped_words(self):
        bad = [
            (c["key"], t)
            for _, c in CHARACTERS
            for t in self.TELLS
            if t in c.get("encounter", "")
        ]
        self.assertEqual(bad, [], "사무실 인사말은 응시 시작 전에 보인다 — 과제를 담으면 안 된다")

    def test_encounter_is_not_the_knowledge(self):
        # 인사말이 knowledge 에서 잘라 온 문장이면 답이 새는 것이다
        for _, c in CHARACTERS:
            enc = (c.get("encounter") or "").strip()
            know = c.get("knowledge") or ""
            if enc and len(enc) > 12:
                self.assertNotIn(enc, know, f"{c['key']}: 인사말이 knowledge 안의 문장이다")


if __name__ == "__main__":
    unittest.main()

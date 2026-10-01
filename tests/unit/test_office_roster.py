"""사무실 동료 명단이 문제의 답을 흘리지 않는가 — 계약 검사.

`Scenario.characters[].knowledge` 에는 그 문제의 **숨은 요구사항이 통째로** 들어 있다.
응시를 시작하기 전에 보이는 화면(사무실)에 그것이 한 글자라도 나가면 시험이 성립하지
않는다. `persona` 도 마찬가지로 나가지 않는다 — 그것은 NPC 를 어떻게 공략할지에 대한
힌트다.

그래서 이 화면이 쓰는 투영은 `OfficeColleague` 하나뿐이고, 그 모델이 담을 수 있는
필드가 곧 노출 한계다. 모델이 넓어지면 이 검사가 먼저 깨진다.
"""

import pathlib
import re
import sys
import unittest

REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "apps" / "api"))

from odysseus_api.schemas import MyAssignmentOut, OfficeColleague  # noqa: E402

ATTEMPTS = REPO_ROOT / "apps" / "api" / "odysseus_api" / "routers" / "attempts.py"
FORBIDDEN = ("persona", "knowledge")


class ProjectionTests(unittest.TestCase):
    def test_colleague_can_only_carry_a_name_tag(self):
        # 필드를 넓히는 일은 **의도적이어야 한다**. 이 집합이 곧 노출 한계이고,
        # 여기 없는 것은 사무실 화면까지 내려오지 않는다.
        self.assertEqual(
            set(OfficeColleague.model_fields),
            {"key", "npc_id", "name", "role", "color", "avatar_preset", "gender", "encounter"},
        )

    def test_forbidden_fields_are_not_on_the_model(self):
        for field in FORBIDDEN:
            self.assertNotIn(field, OfficeColleague.model_fields)

    def test_assignment_carries_colleagues(self):
        self.assertIn("colleagues", MyAssignmentOut.model_fields)

    def test_extra_fields_are_dropped_not_kept(self):
        # 원본 인물 dict 를 통째로 넘겨도 답이 딸려 나오지 않아야 한다
        built = OfficeColleague.model_validate(
            {
                "key": "pm", "name": "김수진", "role": "PM", "color": "#0ea5e9",
                "avatar_preset": "charactor-01", "gender": "female",
                "encounter": "안녕하세요.",
                "persona": "차분하다", "knowledge": "정답은 42",
            }
        )
        dumped = built.model_dump()
        self.assertEqual(
            set(dumped), {"key", "npc_id", "name", "role", "color", "avatar_preset", "gender", "encounter"}
        )
        blob = repr(dumped)
        for secret in ("차분하다", "정답은 42"):
            self.assertNotIn(secret, blob)


class RouterContractTests(unittest.TestCase):
    """라우터가 인물 dict 에서 꺼내 쓰는 키가 허용 목록 안인가."""

    def setUp(self):
        self.src = ATTEMPTS.read_text(encoding="utf-8")

    def test_router_never_reads_persona_or_knowledge(self):
        for field in FORBIDDEN:
            self.assertNotIn(
                f'"{field}"', self.src,
                f"attempts.py 가 {field} 를 읽는다 — 사무실 화면으로 새어 나갈 수 있다",
            )

    def test_router_builds_the_projection_not_a_raw_dict(self):
        # characters 를 그대로 실어 보내는 경로가 생기면 이 검사가 잡는다
        self.assertIn("OfficeColleague(", self.src)
        self.assertNotIn("colleagues=characters", self.src)
        self.assertIsNone(
            re.search(r"colleagues\s*=\s*[^\n]*\bcharacters\b", self.src),
            "characters 를 colleagues 로 그대로 넘기고 있다",
        )


if __name__ == "__main__":
    unittest.main()


class ExamProjectionTests(unittest.TestCase):
    """응시 화면(AttemptScenarioOut.characters)도 답을 싣지 않는가."""

    def setUp(self):
        self.src = ATTEMPTS.read_text(encoding="utf-8")

    def test_exam_characters_carry_only_the_name_tag(self):
        start = self.src.index("characters=[")
        block = self.src[start : self.src.index("]", start)]
        for field in FORBIDDEN:
            self.assertNotIn(field, block, f"응시 화면 인물 투영에 {field} 가 있다")
        for allowed in ("key", "name", "role", "color", "avatar_preset", "gender"):
            self.assertIn(allowed, block)

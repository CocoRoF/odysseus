"""방 하나(=시험 하나)의 상한 — 시나리오 수와 방에 서는 동료 수.

시나리오를 여럿 묶으면 그 인물이 전부 한 방에 서서 서로를 가린다. 그래서 두 군데서 막는다.
API 와 웹이 **같은 숫자**를 써야 하고(둘이 어긋나면 화면은 더 넣게 해 놓고 저장에서 400 이 난다),
라우터가 실제로 그 숫자를 쓰는지도 본문에서 확인한다.
"""
import pathlib
import re
import sys
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "apps/api"))

from odysseus_api.office import MAX_COLLEAGUES, MAX_SCENARIOS_PER_ASSESSMENT  # noqa: E402

WEB_LIMITS = ROOT / "apps/web/lib/assessment-limits.ts"
ASSESSMENTS = ROOT / "apps/api/odysseus_api/routers/assessments.py"
ATTEMPTS = ROOT / "apps/api/odysseus_api/routers/attempts.py"
FORM = ROOT / "apps/web/components/AssessmentForm.tsx"


def web_const(name: str) -> int:
    m = re.search(rf"export const {name} = (\d+);", WEB_LIMITS.read_text(encoding="utf-8"))
    assert m, f"{name} 이 {WEB_LIMITS.name} 에 없다"
    return int(m.group(1))


class LimitsAgreeTests(unittest.TestCase):
    def test_web_and_api_use_the_same_numbers(self):
        self.assertEqual(web_const("MAX_SCENARIOS_PER_ASSESSMENT"), MAX_SCENARIOS_PER_ASSESSMENT)
        self.assertEqual(web_const("MAX_COLLEAGUES"), MAX_COLLEAGUES)

    def test_numbers_are_small_enough_to_read_a_room(self):
        # 방은 6×5 칸부터다 — 여기서 커지면 사람이 서로를 가린다
        self.assertLessEqual(MAX_SCENARIOS_PER_ASSESSMENT, 3)
        self.assertLessEqual(MAX_COLLEAGUES, 8)

    def test_form_tells_the_admin_the_limit(self):
        src = FORM.read_text(encoding="utf-8")
        self.assertIn("MAX_SCENARIOS_PER_ASSESSMENT", src, "편집 화면이 상한을 모른다")
        self.assertIn("MAX_COLLEAGUES", src)


class EnforcementTests(unittest.TestCase):
    """숫자만 있고 지키지 않으면 소용이 없다 — 라우터 본문에서 확인한다."""

    def test_saving_an_assessment_checks_the_scenario_limit(self):
        src = ASSESSMENTS.read_text(encoding="utf-8")
        self.assertIn("MAX_SCENARIOS_PER_ASSESSMENT", src)
        self.assertIsNotNone(
            re.search(r"len\(body\.scenarios\) > MAX_SCENARIOS_PER_ASSESSMENT", src),
            "시나리오 수를 세지 않는다",
        )
        # 이미 상한을 넘겨 저장된 시험은 그대로 둘 수 있어야 한다(편집이 통째로 막히면 운영이 멈춘다)
        self.assertIn("adding", src, "기존 시험을 봐 주는 예외가 없다 — 편집이 전부 막힌다")

    def test_office_projection_keeps_the_roster_limit(self):
        from odysseus_api.npc.public import compile_public
        import uuid
        characters = [{"key": f"person_{i}", "name": f"동료 {i}"} for i in range(12)]
        projection, roster = compile_public([(uuid.uuid4(), characters, {})])
        self.assertEqual(len(roster), MAX_COLLEAGUES)
        self.assertEqual(len(projection.actors), MAX_COLLEAGUES)


class PickColleaguesTests(unittest.TestCase):
    """명단 고르기의 동작 — 로컬·운영 데이터에는 인물 합이 여섯을 넘는 시험이 드물어 여기서 직접 확인한다."""

    @staticmethod
    def people(prefix: str, n: int) -> list[dict]:
        return [{"key": f"{prefix}{i}", "name": f"{prefix}{i}"} for i in range(n)]

    def test_stops_at_the_limit_in_scenario_order(self):
        from odysseus_api.office import pick_colleagues
        picked = pick_colleagues([self.people("a", 3), self.people("b", 3), self.people("c", 3)])
        self.assertEqual([c["key"] for c in picked], ["a0", "a1", "a2", "b0", "b1", "b2"])

    def test_same_person_in_two_scenarios_stands_once(self):
        from odysseus_api.office import pick_colleagues
        shared = {"key": "lead", "name": "팀장"}
        picked = pick_colleagues([[shared, *self.people("a", 2)], [shared, *self.people("b", 5)]])
        keys = [c["key"] for c in picked]
        self.assertEqual(keys.count("lead"), 1)
        self.assertEqual(len(keys), MAX_COLLEAGUES)
        self.assertEqual(keys[:3], ["lead", "a0", "a1"], "앞 시나리오의 인물이 먼저다")

    def test_small_rooms_are_not_padded_and_blank_keys_are_skipped(self):
        from odysseus_api.office import pick_colleagues
        picked = pick_colleagues([[{"key": ""}, {"name": "키 없음"}, None, {"key": "x"}], None])
        self.assertEqual([c["key"] for c in picked], ["x"])

    def test_limit_is_an_argument(self):
        from odysseus_api.office import pick_colleagues
        self.assertEqual(len(pick_colleagues([self.people("a", 9)], limit=2)), 2)


if __name__ == "__main__":
    unittest.main()

"""시험 분야(category) — 세 곳이 같은 목록을 보는가.

분야 목록은 API(`categories.py`)가 정본이고, 웹(`lib/categories.ts`)이 같은 목록을 들고
있으며, 마이그레이션 9 는 배포 시점의 프리셋 분야를 스냅샷으로 백필한다. 셋 중 하나만
고치면 필터 버튼이 갈라지거나 옛 시험이 미분류로 남는다. 그래서 여기서 셋을 맞대 본다.
"""

import pathlib
import re
import sys
import unittest

REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "apps" / "api"))

from odysseus_api.categories import ASSESSMENT_CATEGORIES, CATEGORY_KEYS, normalize_category  # noqa: E402
from odysseus_api.migrations import MIGRATIONS  # noqa: E402
from odysseus_api.scenarios import DEFAULT_ASSESSMENTS  # noqa: E402
from odysseus_api.schemas import AssessmentIn, AssessmentOut, AssessmentSummary, MyAssignmentOut  # noqa: E402

WEB_CATEGORIES = REPO_ROOT / "apps" / "web" / "lib" / "categories.ts"


class PresetTests(unittest.TestCase):
    def test_every_preset_has_a_known_category(self):
        for spec in DEFAULT_ASSESSMENTS:
            self.assertIn("category", spec, f"{spec['title']}: 분야가 없다")
            self.assertNotEqual(spec["category"], "", f"{spec['title']}: 분야가 비어 있다")
            self.assertIn(spec["category"], CATEGORY_KEYS, f"{spec['title']}: 목록에 없는 분야 {spec['category']!r}")

    def test_user_named_categories_exist(self):
        # 요구된 세 축은 반드시 있다
        for key in ("infra", "dev", "ai"):
            self.assertIn(key, CATEGORY_KEYS)


class MigrationSnapshotTests(unittest.TestCase):
    def test_category_backfill_snapshot_is_sane(self):
        """마이그레이션 9 는 그때의 프리셋 스냅샷이다 — 시험이 시나리오 하나가 되며(17) 제목이 바뀌었으니
        프리셋과 같을 필요는 없고, 적힌 분야가 목록에 있으면 된다."""
        m = next(x for x in MIGRATIONS if x.name == "assessment category")
        self.assertTrue(any("ADD COLUMN IF NOT EXISTS category" in s for s in m.statements))
        for stmt in m.statements:
            hit = re.search(r"SET category = '([^']+)' WHERE category = '' AND title = '([^']+)'", stmt)
            if hit:
                self.assertIn(hit.group(1), CATEGORY_KEYS)

    def test_label_backfill_matches_plan(self):
        """마이그레이션 17 의 꼬리표 스냅샷은 지금 프리셋(ASSESSMENT_PLAN)과 같아야 한다."""
        from odysseus_api.scenarios import ASSESSMENT_PLAN

        m = next(x for x in MIGRATIONS if x.name == "시험 하나 = 시나리오 하나")
        backfilled = {}
        for stmt in m.statements:
            hit = re.search(r"SET label = '([^']+)' WHERE label = '' AND title = '([^']+)'", stmt)
            if hit:
                backfilled[hit.group(2)] = hit.group(1)
        expected = {title: label for title, (_cat, label, _demo, _pitch) in ASSESSMENT_PLAN.items()}
        self.assertEqual(backfilled, expected, "꼬리표를 바꿨다면 새 마이그레이션으로 백필하라")

    def test_one_scenario_per_assessment(self):
        for spec in DEFAULT_ASSESSMENTS:
            self.assertEqual(len(spec["scenarios"]), 1, f"{spec['title']}: 시험은 시나리오 하나다")
            self.assertTrue(spec.get("label"), f"{spec['title']}: 꼬리표가 없다")

    def test_labels_unique_within_category(self):
        seen: dict[tuple[str, str], str] = {}
        for spec in DEFAULT_ASSESSMENTS:
            key = (spec["category"], spec["label"])
            self.assertNotIn(key, seen, f"{spec['category']} 분야에 꼬리표 {spec['label']!r} 가 둘: {seen.get(key)} / {spec['title']}")
            seen[key] = spec["title"]

    def test_every_category_has_at_least_two(self):
        """분야당 시험 2개 이상 (2026-09-20 지시). 비어 있는 분야는 고를 수 없어 없느니만 못하다."""
        from collections import Counter

        counts = Counter(spec["category"] for spec in DEFAULT_ASSESSMENTS)
        for key in CATEGORY_KEYS:
            self.assertGreaterEqual(counts[key], 2, f"{key}: 시험이 {counts[key]}개")

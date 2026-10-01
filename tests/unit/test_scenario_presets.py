"""기본 제공 시나리오 프리셋 검증 — 서버도 도커도 없이, 순수 함수로.

여기서 증명하려는 것은 두 가지다.

1. **프리셋이 스키마상 유효한가** — 저장 API 가 받아 주는 모양인가, 인물 키가 맞물리는가,
   경로가 겹치지 않는가, 체크가 필요한 필드를 갖췄는가.
2. **문제가 실제로 풀리는가** — 초기 상태에서는 체크가 통과하지 않고(문제가 성립하고),
   참조 해답을 넣으면 파일 기반 체크가 **전부** 통과하는가(정답이 존재한다).

사무 트랙(b01–b10)과 일반 문제 해결 트랙(g01–)은 실행할 코드가 없어 체크가 전부 파일 기반이다. 그래서 러너 없이
`odysseus_api.checks` 로 끝까지 채점할 수 있고, 이 테스트가 CI 에서 매번 돈다.
"""

import pathlib
import re
import sys
import unittest

REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "apps" / "api"))
sys.path.insert(0, str(REPO_ROOT / "tests" / "smoke"))

from business_solutions import BUSINESS_SOLUTIONS  # noqa: E402
from general_solutions import GENERAL_SOLUTIONS  # noqa: E402
from odysseus_api.checks import FILE_CHECK_TYPES, count_words, csv_lookup, evaluate_file_check  # noqa: E402
from odysseus_api.desktop import OPTIONAL_APPS  # noqa: E402
from odysseus_api.scenarios import (  # noqa: E402
    DEFAULT_ASSESSMENTS,
    DEFAULT_SCENARIOS,
    OFFICE_SCENARIOS,
)
from odysseus_api.schemas import ScenarioIn  # noqa: E402


#: 사무 트랙과 일반 트랙의 참조 해답 — 둘 다 파일 기반이라 같은 방식으로 검증한다
OFFICE_SOLUTIONS: dict[str, dict[str, str]] = {**BUSINESS_SOLUTIONS, **GENERAL_SOLUTIONS}


def _initial_files(scenario: dict) -> dict[str, str]:
    return {f["path"]: f.get("content", "") for f in scenario.get("initial_files", [])}


class ScenarioShapeTests(unittest.TestCase):
    def test_all_presets_validate(self):
        for spec in DEFAULT_SCENARIOS:
            with self.subTest(scenario=spec["title"]):
                parsed = ScenarioIn.model_validate(spec)
                self.assertTrue(parsed.title)
                self.assertTrue(parsed.objectives_md, "숨은 요구사항이 비어 있으면 채점 기준이 없다")
                self.assertTrue(parsed.checks, "자동 체크가 없으면 결과 평가가 전부 사람 몫이 된다")

    def test_titles_are_unique(self):
        titles = [s["title"] for s in DEFAULT_SCENARIOS]
        self.assertEqual(len(titles), len(set(titles)))

    def test_opening_messages_reference_existing_characters(self):
        for spec in DEFAULT_SCENARIOS:
            keys = {c["key"] for c in spec.get("characters", [])}
            for message in spec.get("opening_messages", []):
                with self.subTest(scenario=spec["title"]):
                    self.assertIn(message["character_key"], keys)

    def test_initial_file_paths_unique(self):
        for spec in DEFAULT_SCENARIOS:
            paths = [f["path"] for f in spec.get("initial_files", [])]
            with self.subTest(scenario=spec["title"]):
                self.assertEqual(len(paths), len(set(paths)))

    def test_check_fields_present(self):
        for spec in DEFAULT_SCENARIOS:
            for check in spec["checks"]:
                with self.subTest(scenario=spec["title"], check=check.get("label")):
                    ctype = check["type"]
                    if ctype == "command":
                        self.assertTrue(check.get("command"))
                        continue
                    self.assertTrue(check.get("path"))
                    if ctype in ("file_contains", "file_not_contains"):
                        self.assertTrue(check.get("pattern"))
                        re.compile(check["pattern"])  # 잘못된 정규식은 여기서 터진다
                    if ctype == "file_min_words":
                        self.assertGreater(int(check.get("min_count") or 0), 0)
                    if ctype == "csv_cell":
                        self.assertTrue(check.get("column"))
                        self.assertTrue(str(check.get("expected") or ""))
                        if check.get("row_match"):
                            self.assertIn("=", check["row_match"])

    def test_assessments_reference_known_scenarios(self):
        titles = {s["title"] for s in DEFAULT_SCENARIOS}
        for assessment in DEFAULT_ASSESSMENTS:
            for title in assessment["scenarios"]:
                with self.subTest(assessment=assessment["title"]):
                    self.assertIn(title, titles)

    def test_desktop_apps_are_known(self):
        for spec in DEFAULT_SCENARIOS:
            for app in spec.get("desktop_apps") or []:
                with self.subTest(scenario=spec["title"]):
                    self.assertIn(app, OPTIONAL_APPS)


class BusinessTrackTests(unittest.TestCase):
    """사무 트랙은 터미널 없이 풀려야 한다 — 그 전제를 테스트로 고정한다."""

    def test_business_scenarios_declare_apps(self):
        for spec in OFFICE_SCENARIOS:
            with self.subTest(scenario=spec["title"]):
                apps = spec.get("desktop_apps") or []
                self.assertTrue(apps, "사무 시나리오는 제공 앱을 명시해야 한다")
                self.assertIn("docs", apps, "문서 편집기 없이 문서를 만들라고 할 수는 없다")
                self.assertNotIn("terminal", apps)
                self.assertNotIn("ide", apps)

    def test_business_checks_need_no_runner(self):
        for spec in OFFICE_SCENARIOS:
            for check in spec["checks"]:
                with self.subTest(scenario=spec["title"], check=check.get("label")):
                    self.assertIn(check["type"], FILE_CHECK_TYPES)

    def test_every_business_scenario_has_a_reference_solution(self):
        for spec in OFFICE_SCENARIOS:
            with self.subTest(scenario=spec["title"]):
                self.assertIn(spec["title"], OFFICE_SOLUTIONS)

    def test_reference_solution_passes_every_check(self):
        for spec in OFFICE_SCENARIOS:
            solution = OFFICE_SOLUTIONS.get(spec["title"], {})
            files = {**_initial_files(spec), **solution}
            for check in spec["checks"]:
                passed, detail = evaluate_file_check(check, files)
                with self.subTest(scenario=spec["title"], check=check["label"]):
                    self.assertTrue(passed, f"참조 해답이 체크를 통과하지 못함: {detail}")

    def test_initial_state_fails_the_deliverable_checks(self):
        """문제가 성립하는가 — 아무것도 하지 않으면 산출물 체크는 떨어져야 한다."""
        for spec in OFFICE_SCENARIOS:
            files = _initial_files(spec)
            passed = [c["label"] for c in spec["checks"] if evaluate_file_check(c, files)[0]]
            with self.subTest(scenario=spec["title"]):
                self.assertEqual(passed, [], "초기 상태에서 통과하는 체크가 있다 — 문제가 이미 풀려 있다")

    def test_solution_files_are_declared_deliverables(self):
        """해답이 만드는 파일은 체크가 실제로 보는 경로여야 한다 (오탈자 방지)."""
        for spec in OFFICE_SCENARIOS:
            checked = {c.get("path") for c in spec["checks"] if c.get("path")}
            for path in OFFICE_SOLUTIONS.get(spec["title"], {}):
                with self.subTest(scenario=spec["title"], path=path):
                    self.assertIn(path, checked)


class CheckEngineTests(unittest.TestCase):
    def test_count_words_ignores_markup_only_tokens(self):
        self.assertEqual(count_words("# 제목\n- 항목 하나\n|  |"), 3)

    def test_csv_lookup_is_tolerant_about_header_style(self):
        text = "Order ID,Ship Date\nD-1001, 2026-09-09\n"
        value, why = csv_lookup(text, column="order_id", row_match=None)
        self.assertEqual(value, "D-1001", why)
        value, why = csv_lookup(text, column="ship date", row_match="order id=D-1001")
        self.assertEqual(value, "2026-09-09", why)

    def test_csv_cell_compares_numbers_not_formatting(self):
        check = {
            "type": "csv_cell",
            "path": "output/x.csv",
            "column": "revenue",
            "row_match": "branch=서울",
            "expected": "480000000",
        }
        files = {"output/x.csv": "branch,revenue\n서울,\"480,000,000\"\n"}
        passed, detail = evaluate_file_check(check, files)
        self.assertTrue(passed, detail)

    def test_file_not_contains_is_case_insensitive(self):
        check = {"type": "file_not_contains", "path": "a.md", "pattern": r"\bTBD\b"}
        self.assertFalse(evaluate_file_check(check, {"a.md": "결론: tbd"})[0])
        self.assertTrue(evaluate_file_check(check, {"a.md": "결론: 확정"})[0])

    def test_missing_file_fails_without_raising(self):
        for ctype in ("file_contains", "file_not_contains", "file_min_words", "csv_cell"):
            passed, detail = evaluate_file_check(
                {"type": ctype, "path": "nope.md", "pattern": "x", "min_count": 1, "column": "c", "expected": "1"},
                {},
            )
            self.assertFalse(passed)
            self.assertIn("없음", detail)


if __name__ == "__main__":
    unittest.main()

"""바탕화면 앱 게이트의 계약 — 서버가 관장하지 않는 앱을 목록으로 판정하지 않는가.

`Scenario.desktop_apps` 는 켜고 끌 수 있는 앱만 담는다(`desktop.OPTIONAL_APPS`).
메신저·AI 에이전트·뷰어는 거기 없다 — 메신저는 문제를 제시하는 수단 자체이고,
에이전트는 `agent_enabled` 가, 뷰어는 탐색기가 연다.

그런데 서버는 목록이 비어 있으면 OPTIONAL_APPS 를 **통째로** 돌려준다. 그래서 프론트의
"비어 있으면 전부" 분기는 실제로 절대 타지 않는다. 이 셋을 목록으로 판정하면 "목록에
없다"는 이유로 모든 시나리오에서 조용히 사라진다 — 실제로 그랬다.
"""

import pathlib
import re
import sys
import unittest

REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "apps" / "api"))

from odysseus_api.desktop import OPTIONAL_APPS, allowed_desktop_apps  # noqa: E402

#: 서버가 목록으로 관장하지 않는 앱
UNGOVERNED = ("messenger", "agent", "viewer")
EXAM_PAGE = REPO_ROOT / "apps" / "web" / "app" / "exam" / "[attemptId]" / "page.tsx"


class ServerContractTests(unittest.TestCase):
    def test_ungoverned_apps_are_not_in_the_list(self):
        for app in UNGOVERNED:
            self.assertNotIn(app, OPTIONAL_APPS, f"{app} 은 desktop_apps 가 관장하지 않는다")

    def test_empty_selection_expands_to_every_optional_app(self):
        # 이것이 프론트의 "비면 전부" 분기를 죽은 코드로 만드는 동작이다. 동작 자체는
        # 의도된 것이므로, 프론트가 그것을 알고 있어야 한다(아래 계약 검사).
        self.assertEqual(allowed_desktop_apps([]), list(OPTIONAL_APPS))
        self.assertNotEqual(allowed_desktop_apps([]), [])

    def test_a_narrow_selection_stays_narrow(self):
        self.assertEqual(allowed_desktop_apps(["docs", "files"]), ["files", "docs"])


class FrontendGateTests(unittest.TestCase):
    """프론트가 관장 밖 앱을 목록 판정에서 빼 두었는가 — 소스 계약."""

    def setUp(self):
        self.src = EXAM_PAGE.read_text(encoding="utf-8")
        match = re.search(r"const appAllowed = useCallback\((.*?)\n  \);", self.src, re.S)
        self.assertIsNotNone(match, "appAllowed 를 찾지 못했다")
        self.body = match.group(1)

    def test_gate_exempts_every_ungoverned_app(self):
        for app in UNGOVERNED:
            self.assertIn(
                f'"{app}"',
                self.body,
                f"{app} 이 appAllowed 의 예외에 없다 — 모든 시나리오에서 아이콘이 사라진다",
            )

    def test_gate_still_filters_a_governed_app(self):
        # 예외가 전부를 통과시켜 버리면 사무 시나리오에서 터미널이 다시 나타난다
        self.assertIn("allowed", self.body)
        self.assertIn("includes(id)", self.body)
        for app in ("terminal", "ide"):
            self.assertNotIn(f'id === "{app}"', self.body, f"{app} 은 목록이 판정해야 한다")


if __name__ == "__main__":
    unittest.main()

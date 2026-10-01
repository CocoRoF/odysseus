"""워크스페이스 되돌리기의 계산 — 무엇을 복원하고 무엇을 지우는가 (서버 없이).

파일 하나는 그 파일만 원래 내용으로, 전체는 초기 파일 복원 + 응시자가 만든 파일 삭제.
초기 파일이 아닌 것을 되돌리려 하면 원본이 없으므로 404.
"""

import pathlib
import sys
import unittest

REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "apps" / "api"))

from odysseus_api.workspace import WorkspaceError, initial_file_map, plan_reset  # noqa: E402

INITIAL = [
    {"path": "data/orders.csv", "content": "id,amount\n1,10\n"},
    {"path": "src/report.py", "content": "print('hi')\n"},
    {"path": "/docs/readme.md", "content": "# hi"},  # 선행 슬래시는 정규화된다
    {"path": "", "content": "무시"},  # 경로 없는 항목은 버린다
    {"path": "../etc/passwd", "content": "x"},  # 탈출 경로는 버린다
]


class InitialMapTests(unittest.TestCase):
    def test_paths_are_normalized_and_bad_entries_dropped(self):
        m = initial_file_map(INITIAL)
        self.assertEqual(set(m), {"data/orders.csv", "src/report.py", "docs/readme.md"})
        self.assertEqual(m["docs/readme.md"], "# hi")


class PlanResetTests(unittest.TestCase):
    def setUp(self):
        self.initial = initial_file_map(INITIAL)
        self.current = ["data/orders.csv", "src/report.py", "output/result.csv", "notes/.keep"]

    def test_single_file_restores_only_that_file(self):
        restore, remove = plan_reset(self.initial, self.current, "src/report.py")
        self.assertEqual(restore, ["src/report.py"])
        self.assertEqual(remove, [])

    def test_single_file_path_is_normalized(self):
        restore, _ = plan_reset(self.initial, self.current, "/src/report.py")
        self.assertEqual(restore, ["src/report.py"])

    def test_single_file_that_was_deleted_can_still_be_restored(self):
        restore, remove = plan_reset(self.initial, ["output/result.csv"], "docs/readme.md")
        self.assertEqual(restore, ["docs/readme.md"])
        self.assertEqual(remove, [])

    def test_non_initial_file_has_no_origin(self):
        with self.assertRaises(WorkspaceError) as ctx:
            plan_reset(self.initial, self.current, "output/result.csv")
        self.assertEqual(ctx.exception.code, 404)

    def test_full_reset_restores_all_initial_and_removes_candidate_files(self):
        restore, remove = plan_reset(self.initial, self.current, None)
        self.assertEqual(restore, ["data/orders.csv", "docs/readme.md", "src/report.py"])
        self.assertEqual(remove, ["notes/.keep", "output/result.csv"])

    def test_full_reset_on_empty_initial_only_removes(self):
        restore, remove = plan_reset({}, ["a.txt"], None)
        self.assertEqual(restore, [])
        self.assertEqual(remove, ["a.txt"])


if __name__ == "__main__":
    unittest.main()

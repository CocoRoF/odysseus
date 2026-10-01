"""아바타 프리셋 할당 — 한 방에서 얼굴이 겹치지 않고, 지정된 것을 피하고, 같은 인물은 같은 얼굴.

그리고 서버가 아는 프리셋 목록(people_presets.py, 생성)이 웹 매니페스트(people.ts, 생성)와
같은지 맞대 본다. 둘은 같은 도구가 같은 순간에 만들지만, 한쪽만 커밋되는 사고를 여기서 잡는다.
"""

import pathlib
import re
import sys
import unittest

REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "apps" / "api"))

from odysseus_api.avatar_alloc import allocate  # noqa: E402
from odysseus_api.people_presets import PRESET_IDS, PRESETS  # noqa: E402

FEMALE = [p["id"] for p in PRESETS if p["gender"] == "female"]
MALE = [p["id"] for p in PRESETS if p["gender"] == "male"]


def chars(*specs):
    out = []
    for s in specs:
        key, gender, *rest = s
        out.append({"key": key, "gender": gender, "avatar_preset": rest[0] if rest else "", "name": key})
    return out


class AllocationTests(unittest.TestCase):
    def test_no_duplicates_in_a_room_when_presets_suffice(self):
        keys = [f"f{i}" for i in range(len(FEMALE))]
        got = allocate(chars(*[(k, "female") for k in keys]))
        self.assertEqual(len(set(got.values())), len(keys), "프리셋이 충분한데 한 방에 같은 얼굴이 있다")
        self.assertTrue(set(got.values()) <= set(FEMALE))

    def test_explicit_presets_are_kept_and_avoided(self):
        fixed = FEMALE[0]
        got = allocate(chars(("a", "female", fixed), *[(f"f{i}", "female") for i in range(len(FEMALE) - 1)]))
        self.assertEqual(got["a"], fixed)
        others = [v for k, v in got.items() if k != "a"]
        self.assertNotIn(fixed, others, "지정된 얼굴을 다른 사람이 또 썼다")
        self.assertEqual(len(set(others)), len(others))

    def test_partial_assignment_across_scenarios_is_respected(self):
        # 한 문제에서는 지정되어 있고 다른 문제에서는 비어 있는 같은 인물 — 지정을 따른다
        fixed = FEMALE[1]
        got = allocate(chars(("pm", "female", fixed), ("pm", "female"), ("x", "female")))
        self.assertEqual(got["pm"], fixed)
        self.assertNotEqual(got["x"], fixed)

    def test_same_key_same_face(self):
        a = allocate(chars(("pm", "female"), ("dev", "male"), ("pm", "female")))
        b = allocate(chars(("pm", "female"), ("dev", "male")))
        self.assertEqual(a["pm"], b["pm"])
        self.assertEqual(len(a), 2)

    def test_gender_is_respected_and_blank_uses_everyone(self):
        got = allocate(chars(("m", "male"), ("f", "female"), ("n", "")))
        if MALE:
            self.assertIn(got["m"], MALE)
        self.assertIn(got["f"], FEMALE)
        self.assertIn(got["n"], PRESET_IDS)

    def test_balanced_when_more_people_than_presets(self):
        n = len(FEMALE) * 2 + 1
        got = allocate(chars(*[(f"f{i}", "female") for i in range(n)]))
        counts = {}
        for v in got.values():
            counts[v] = counts.get(v, 0) + 1
        self.assertLessEqual(max(counts.values()) - min(counts.values()), 1, f"고르지 않다: {counts}")

    def test_deterministic(self):
        spec = chars(*[(f"k{i}", "female" if i % 2 else "male") for i in range(9)])
        self.assertEqual(allocate(spec), allocate(spec))

    def test_unknown_explicit_preset_is_treated_as_blank(self):
        got = allocate(chars(("a", "female", "no-such-preset")))
        self.assertIn(got["a"], FEMALE)


class ManifestParityTests(unittest.TestCase):
    def test_server_list_matches_web_manifest(self):
        src = (REPO_ROOT / "apps" / "web" / "lib" / "people.ts").read_text(encoding="utf-8")
        web = re.findall(r'\{ id: "([^"]+)", name: "([^"]+)", gender: "([^"]*)", row: (\d+)', src)
        self.assertEqual(
            [(p["id"], p["name"], p["gender"]) for p in PRESETS],
            [(i, n, g) for i, n, g, _ in web],
            "people_presets.py 와 people.ts 가 다르다 — characters-import.mjs 를 다시 돌려라",
        )
        self.assertEqual([int(r) for *_, r in web], list(range(len(web))))


if __name__ == "__main__":
    unittest.main()

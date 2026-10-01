"""사무실 장면(프리셋) — 웹과 API 가 같은 것을 아는가, 구조 검증이 막을 것을 막는가.

장면 JSON 의 모양은 웹(scenes.ts)이 정본이고 API(schemas.OfficeSpec)는 구조만 지킨다. 기본 장면 id 와
크기 범위는 양쪽이 같아야 한다 — 어긋나면 관리자가 고른 기본 장면이 응시자 화면에서 자동으로 떨어진다.
"""

import pathlib
import re
import sys
import unittest
import uuid

from pydantic import ValidationError

REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "apps" / "api"))

from odysseus_api.migrations import MIGRATIONS  # noqa: E402
from odysseus_api.office import BUILTIN_SCENES, SCENE_LIMITS, is_valid_ref, parse_ref, resolve_ref, stamp_scene  # noqa: E402
from odysseus_api.schemas import (  # noqa: E402
    AssessmentIn,
    AssessmentOut,
    MyAssignmentOut,
    OfficePresetIn,
    OfficeSettingsIn,
    OfficeSpec,
)

SCENES_TS = REPO_ROOT / "apps" / "web" / "components" / "office" / "scenes.ts"


def spec(**over):
    base = {
        "cols": 8,
        "rows": 6,
        "floor": "oak",
        "props": [{"kind": "plant", "c": 0, "r": 0}],
        "decor": [{"kind": "clock", "c": 3}],
        "spots": [{"c": 2, "r": 2, "face": "up"}],
        "start": {"c": 5, "r": 4},
    }
    base.update(over)
    return base


class WebMirrorTests(unittest.TestCase):
    def test_builtin_scene_ids_match_scenes_ts(self):
        src = SCENES_TS.read_text(encoding="utf-8")
        block = src[src.index("export type BuiltinSceneId") : src.index("export type SceneId")]
        web = re.findall(r'\| "([a-z]+)"', block)
        self.assertEqual(tuple(web), BUILTIN_SCENES, "office.py 의 BUILTIN_SCENES 가 scenes.ts 와 다르다")

    def test_size_limits_match_scenes_ts(self):
        src = SCENES_TS.read_text(encoding="utf-8")
        hit = re.search(r"SCENE_LIMITS = \{ minCols: (\d+), maxCols: (\d+), minRows: (\d+), maxRows: (\d+) \}", src)
        self.assertIsNotNone(hit)
        self.assertEqual(
            [int(x) for x in hit.groups()],
            [SCENE_LIMITS["min_cols"], SCENE_LIMITS["max_cols"], SCENE_LIMITS["min_rows"], SCENE_LIMITS["max_rows"]],
        )


class RefTests(unittest.TestCase):
    def test_parse(self):
        self.assertEqual(parse_ref(""), ("", ""))
        self.assertEqual(parse_ref(None), ("", ""))
        self.assertEqual(parse_ref("builtin:meeting"), ("builtin", "meeting"))
        self.assertEqual(parse_ref("builtin:nope"), ("", ""))
        u = str(uuid.uuid4())
        self.assertEqual(parse_ref(u), ("custom", u))
        self.assertEqual(parse_ref("garbage"), ("", ""))
        self.assertTrue(is_valid_ref(""))
        self.assertTrue(is_valid_ref("builtin:server"))
        self.assertFalse(is_valid_ref("builtin:x"))
        self.assertFalse(is_valid_ref("abc"))

    def test_resolve_assessment_then_category_then_auto(self):
        u = str(uuid.uuid4())
        self.assertEqual(resolve_ref("builtin:lounge", "dev", {"dev": u}), "builtin:lounge")
        self.assertEqual(resolve_ref("", "dev", {"dev": u}), u)
        self.assertEqual(resolve_ref("", "dev", {"dev": "builtin:board"}), "builtin:board")
        self.assertEqual(resolve_ref("", "ai", {"dev": u}), "")
        self.assertEqual(resolve_ref("", "", {"": "builtin:coffee"}), "builtin:coffee")
        self.assertEqual(resolve_ref("garbage", "dev", {"dev": "garbage"}), "")


class SpecShapeTests(unittest.TestCase):
    def test_minimal_spec_is_accepted(self):
        s = OfficeSpec.model_validate(spec())
        self.assertEqual((s.cols, s.rows), (8, 6))
        self.assertEqual(s.cuts, [])

    def test_size_out_of_range(self):
        with self.assertRaises(ValidationError):
            OfficeSpec.model_validate(spec(cols=3))
        with self.assertRaises(ValidationError):
            OfficeSpec.model_validate(spec(rows=99))

    def test_out_of_bounds_items(self):
        with self.assertRaises(ValidationError):
            OfficeSpec.model_validate(spec(props=[{"kind": "plant", "c": 8, "r": 0}]))
        with self.assertRaises(ValidationError):
            OfficeSpec.model_validate(spec(start={"c": 7, "r": 4}))  # 2칸이라 오른쪽이 밖
        with self.assertRaises(ValidationError):
            OfficeSpec.model_validate(spec(door=7))
        with self.assertRaises(ValidationError):
            OfficeSpec.model_validate(spec(cuts=[{"c": 7, "r": 5, "w": 2, "h": 1}]))
        with self.assertRaises(ValidationError):
            OfficeSpec.model_validate(spec(spots=[{"c": 0, "r": 6, "face": "up"}]))
        with self.assertRaises(ValidationError):
            OfficeSpec.model_validate(spec(spots=[{"c": 0, "r": 0, "face": "north"}]))

    def test_unknown_fields_and_bad_kinds_rejected(self):
        with self.assertRaises(ValidationError):
            OfficeSpec.model_validate(spec(persona="x"))
        with self.assertRaises(ValidationError):
            OfficeSpec.model_validate(spec(props=[{"kind": "../evil", "c": 0, "r": 0}]))
        with self.assertRaises(ValidationError):
            OfficeSpec.model_validate(spec(floor="oak; drop"))

    def test_preset_in_and_settings(self):
        body = OfficePresetIn.model_validate({"name": "내 방", "spec": spec()})
        self.assertEqual(body.spec.cols, 8)
        st = OfficeSettingsIn.model_validate({"defaults": {"dev": "builtin:meeting", "ai": ""}})
        self.assertEqual(st.defaults, {"dev": "builtin:meeting"})
        with self.assertRaises(ValidationError):
            OfficeSettingsIn.model_validate({"defaults": {"dev": "nope"}})
        with self.assertRaises(ValidationError):
            OfficeSettingsIn.model_validate({"defaults": {"unknown-category": "builtin:meeting"}})


class AssessmentFieldTests(unittest.TestCase):
    def _body(self, ref):
        return {
            "title": "t",
            "office_preset": ref,
            "scenarios": [{"scenario_id": str(uuid.uuid4()), "points": 100}],
        }

    def test_assessment_accepts_known_refs_only(self):
        self.assertEqual(AssessmentIn.model_validate(self._body("")).office_preset, "")
        self.assertEqual(AssessmentIn.model_validate(self._body("builtin:server")).office_preset, "builtin:server")
        u = str(uuid.uuid4())
        self.assertEqual(AssessmentIn.model_validate(self._body(u)).office_preset, u)
        with self.assertRaises(ValidationError):
            AssessmentIn.model_validate(self._body("builtin:garden"))

    def test_outputs_carry_office_fields(self):
        self.assertIn("office_preset", AssessmentOut.model_fields)
        self.assertIn("office_preset", MyAssignmentOut.model_fields)
        self.assertIn("office_scene", MyAssignmentOut.model_fields)

    def test_migration_adds_column(self):
        m = next(x for x in MIGRATIONS if x.name == "office presets")
        self.assertTrue(any("office_preset" in s for s in m.statements))


if __name__ == "__main__":
    unittest.main()


class WallStyleTests(unittest.TestCase):
    def test_wall_style_is_part_of_the_spec(self):
        # 편집기가 벽 스타일을 바꾸면 spec.wall 이 실린다 — 예전에는 extra=forbid 에 막혀 저장이 실패했다
        self.assertEqual(OfficeSpec.model_validate(spec(wall="brick")).wall, "brick")
        self.assertIsNone(OfficeSpec.model_validate(spec()).wall)
        with self.assertRaises(ValidationError):
            OfficeSpec.model_validate(spec(wall="brick; drop"))


class BuiltinOverrideTests(unittest.TestCase):
    """템플릿(코드의 기본 장면)을 관리자가 고친 것 — DB 에 남아 재배포해도 유지되고, 지우면 기본값으로 돌아간다."""

    def test_stamp_scene_uses_template_identity(self):
        s = stamp_scene({"cols": 8, "id": "x", "label": "y"}, "breakroom", "고친 휴게실")
        self.assertEqual((s["id"], s["label"], s["cols"]), ("breakroom", "고친 휴게실", 8))
        self.assertEqual(stamp_scene(None, "coffee", "커피"), {"id": "coffee", "label": "커피"})

    def test_override_table_is_keyed_by_template_id(self):
        from odysseus_api.models import OfficeBuiltinOverride

        table = OfficeBuiltinOverride.__table__
        self.assertEqual(table.name, "office_builtin_overrides")
        self.assertEqual([c.name for c in table.primary_key.columns], ["builtin_id"])
        self.assertGreaterEqual(table.c.builtin_id.type.length, max(len(i) for i in BUILTIN_SCENES))

    def test_routes_match_web_callers(self):
        # 웹이 부르는 주소와 API 가 여는 주소가 같아야 한다 — 어긋나면 템플릿 저장이 조용히 404 가 된다
        api = REPO_ROOT / "apps" / "api" / "odysseus_api" / "routers"
        web = REPO_ROOT / "apps" / "web"
        office_router = (api / "office.py").read_text(encoding="utf-8")
        attempts_router = (api / "attempts.py").read_text(encoding="utf-8")
        self.assertIn('@router.get("/builtins"', office_router)
        self.assertIn('@router.put("/builtins/{builtin_id}"', office_router)
        self.assertIn('@router.delete("/builtins/{builtin_id}"', office_router)
        self.assertIn('@router.get("/my/office/builtins")', attempts_router)
        admin_page = (web / "app" / "admin" / "office" / "page.tsx").read_text(encoding="utf-8")
        office_page = (web / "app" / "office" / "page.tsx").read_text(encoding="utf-8")
        self.assertIn('"/admin/office/builtins"', admin_page)
        self.assertIn("`/admin/office/builtins/${", admin_page)
        self.assertIn('"/my/office/builtins"', office_page)


class AtlasNameContractTests(unittest.TestCase):
    """웹 아틀라스의 이름이 API 의 구조 검증을 통과하는가.

    구입한 팩으로 바꾼 뒤 소품 이름에 하이픈이 들어갔는데 API 패턴은 영숫자만 받아, 소품이 있는 장면은 템플릿이든
    프리셋이든 전부 422 로 저장되지 않았다(2026-09-13). 이름을 만드는 쪽(atlas.ts)과 받는 쪽(schemas)을 맞대 본다.
    """

    ATLAS_TS = REPO_ROOT / "apps" / "web" / "components" / "office" / "atlas.ts"

    def _block(self, src: str, start: str) -> str:
        i = src.index(start)
        return src[i : src.index("\n};", i)]

    def test_every_prop_name_is_accepted(self):
        src = self.ATLAS_TS.read_text(encoding="utf-8")
        names = re.findall(r'^\s+"?([^":\s]+)"?: \{ w:', self._block(src, "export const FOOT"), re.M)
        self.assertGreater(len(names), 100, "아틀라스에서 소품 이름을 읽지 못했다")
        scene_kinds = set(re.findall(r'kind: "([^"]+)"', SCENES_TS.read_text(encoding="utf-8")))
        self.assertTrue(scene_kinds, "scenes.ts 에서 소품 이름을 읽지 못했다")
        bad = []
        for kind in sorted(set(names) | scene_kinds):
            try:
                OfficeSpec.model_validate(spec(props=[{"kind": kind, "c": 0, "r": 0}], decor=[{"kind": kind, "c": 0}]))
            except ValidationError:
                bad.append(kind)
        self.assertEqual(bad, [], "API 가 거절하는 소품 이름")

    def test_floor_and_wall_keys_are_accepted(self):
        src = self.ATLAS_TS.read_text(encoding="utf-8")
        floors = re.findall(r'"([^"]+)"', re.search(r"export const FLOOR_KEYS = \[([^\]]*)\]", src).group(1))
        walls = re.findall(r"^\s+([A-Za-z0-9]+): \{ src:", self._block(src, "export const WALL_STYLES"), re.M)
        self.assertTrue(floors and walls)
        for f in floors:
            OfficeSpec.model_validate(spec(floor=f, tiles=[{"c": 0, "r": 0, "floor": f}]))
        for w in walls:
            OfficeSpec.model_validate(spec(wall=w))

    def test_kind_pattern_still_blocks_paths(self):
        for bad in ("../evil", "a/b", "-lead", "trail-", "a--b", "a.b", "a b"):
            with self.assertRaises(ValidationError, msg=bad):
                OfficeSpec.model_validate(spec(props=[{"kind": bad, "c": 0, "r": 0}]))

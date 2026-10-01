/** 템플릿 덮어쓰기 — 서버가 준 고친 모양을 어떻게 받고, 층이 그것을 쓰는가.
 *   node --test apps/web/components/office/ */
import assert from "node:assert/strict";
import test from "node:test";

import { SCENES } from "./scenes.ts";
import { builtinScene, readBuiltinOverrides } from "./builtin-scenes.ts";
import { buildFloor } from "./floorplan.ts";

test("템플릿 덮어쓰기: 알려진 템플릿의 올바른 장면만 받는다", () => {
  const edited = { ...SCENES.breakroom, id: "아무거나", label: "고친 휴게실", floor: "oak" };
  const out = readBuiltinOverrides({ breakroom: edited, nope: SCENES.coffee, coffee: { cols: 3 }, lounge: { ...SCENES.lounge, label: " " } });
  assert.deepEqual(Object.keys(out).sort(), ["breakroom", "lounge"], "모르는 템플릿·깨진 장면은 버린다");
  assert.equal(out.breakroom?.id, "breakroom", "id 는 템플릿 id 로 — 같은 장면이 한 층에 둘이면 거울로 세우는 규칙이 이것을 본다");
  assert.equal(out.breakroom?.label, "고친 휴게실");
  assert.equal(out.lounge?.label, SCENES.lounge.label, "이름이 비면 처음 이름");
  assert.equal(builtinScene("breakroom", out).floor, "oak");
  assert.equal(builtinScene("coffee", out), SCENES.coffee, "고치지 않은 템플릿은 코드의 기본값");
  assert.deepEqual(readBuiltinOverrides(null), {});
  assert.deepEqual(readBuiltinOverrides([SCENES.coffee]), {});
});

test("템플릿 덮어쓰기: 장면을 정하지 않은 방(자동)도 고친 모양으로 선다", () => {
  // 미분류("")의 첫 방은 라운지를 고른다(scenes.ts 의 PREFERENCE)
  const specs = [{ slug: "a", label: "A", accent: "#62A8C8", category: "" }];
  assert.equal(buildFloor(specs).rooms[0].spec.floor, SCENES.lounge.floor);
  const overrides = readBuiltinOverrides({ lounge: { ...SCENES.lounge, floor: "oak", label: "고친 라운지" } });
  const room = buildFloor(specs, overrides).rooms[0];
  assert.equal(room.spec.floor, "oak");
  assert.equal(room.spec.id, "lounge");
});

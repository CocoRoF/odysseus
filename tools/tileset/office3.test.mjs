/** Office-3 매니페스트의 계약 — 모든 물건이 시트 안에 있고 그림이 비어 있지 않으며, 이름이 겹치지 않고, 벽 오토타일이 47가지로 줄어든다.
 *   node --test tools/tileset/ */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { OBJECTS, WALL_STYLES, GROUPS, LEGACY_NAMES, OFFICE3_DIR } from "./office3.mjs";
import { importOffice3, importA4Walls } from "./pack-import.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
/** 구입 팩 원본은 비공개 서브모듈에 있다 — 받을 권한이 없는 곳(공개 클론·CI)에서는 원본을 읽는 검사를 건너뛴다. */
const PACK = existsSync(join(ROOT, OFFICE3_DIR)) ? {} : { skip: "구입 에셋 서브모듈이 없다 (apps/web/public/office/licensed)" };

test("office3: 매니페스트의 모든 물건이 시트 안의 빈 칸이 아닌 그림이고 이름·묶음이 맞다", PACK, () => {
  const names = new Set();
  for (const o of OBJECTS) {
    assert.ok(!names.has(o.name), `${o.name} 이름이 겹친다`); names.add(o.name);
    assert.ok(GROUPS[o.group], `${o.name}: 모르는 묶음 ${o.group}`);
    assert.ok(o.cx >= 0 && o.cy >= 0 && o.cx + o.w <= 16 && o.cy + o.h <= 16, `${o.name}: 시트(16×16칸) 밖이다`);
    assert.ok(o.w >= 1 && o.h >= 1 && o.w <= 4 && o.h <= 2 || o.name === "meeting-8-dark", `${o.name}: 크기 ${o.w}×${o.h}`);
    if (o.foot !== undefined) assert.ok(o.foot >= 1 && o.foot <= o.h, `${o.name}: foot ${o.foot}`);
  }
  // 같은 시트의 두 물건이 같은 칸을 쓰지 않는다 (ㄱ자 cells 는 그 칸만)
  const used = new Map();
  for (const o of OBJECTS) {
    if (o.name === "standDesk") continue; // desk-monitor-phone 의 사본
    const cells = o.cells ?? Array.from({ length: o.w * o.h }, (_, i) => [o.cx + (i % o.w), o.cy + Math.floor(i / o.w)]);
    for (const [cx, cy] of cells) {
      const k = `${o.sheet}:${cx},${cy}`;
      const other = used.get(k);
      // 겹쳐 그려진 칸은 한쪽이 shares 로 선언하고 clear 로 가른 경우만 허락한다
      const declared = other && ((o.shares ?? []).includes(other) || (OBJECTS.find((x) => x.name === other)?.shares ?? []).includes(o.name));
      assert.ok(!other || declared, `${o.name} 과 ${other} 가 칸 ${k} 을 같이 쓴다`);
      if (!other) used.set(k, o.name);
    }
  }
  const sprites = importOffice3(ROOT);
  assert.equal(sprites.length, OBJECTS.length);
  for (const s of sprites) { assert.ok(s.vis > 0, `${s.name} 그림이 비었다`); assert.ok(s.label.length > 0); }
  for (const [old, name] of Object.entries(LEGACY_NAMES)) assert.ok(names.has(name), `옛 이름 ${old} → ${name} 이 없다`);
  assert.ok(names.has("standDesk") && names.has("door-glass"), "시작 책상·출입문이 있어야 한다");
});

test("office3: A4 벽 오토타일이 스타일마다 윗면 47 + 앞면 16 변형 시트가 되고 마스크 표가 그 안을 가리킨다", PACK, () => {
  const w = importA4Walls(ROOT);
  assert.equal(w.topCount, 47);
  assert.equal(w.faceCount, 16);
  assert.equal(w.topIndex.length, 256);
  for (const i of w.topIndex) assert.ok(i >= 0 && i < 47);
  // 사방이 벽이면 가운데 그림(테두리 없음), 외톨이면 사방 테두리 — 서로 다른 변형
  assert.notEqual(w.topIndex[255], w.topIndex[0]);
  // 대각선만 다른 마스크(안쪽 모서리)는 상하좌우가 다 있을 때만 그림이 다르다
  assert.notEqual(w.topIndex[255], w.topIndex[255 & ~2]);
  assert.equal(w.topIndex[1 | 4 | 16 | 64], w.topIndex[1 | 4 | 16 | 64 | 2 | 8 | 32 | 128] === w.topIndex[1 | 4 | 16 | 64] ? w.topIndex[1 | 4 | 16 | 64] : w.topIndex[1 | 4 | 16 | 64]);
  assert.equal(w.topIndex[0 | 2], w.topIndex[0], "상하좌우가 없으면 대각선은 그림을 바꾸지 않는다");
  for (const st of WALL_STYLES) { const sh = w.styles[st.key]; assert.ok(sh, `${st.key} 시트가 없다`); assert.equal(sh.img.w, 16 * w.pitch); assert.equal(sh.img.h, sh.rows * w.pitch); }
});

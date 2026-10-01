/** 방 참고 그림 슬라이서의 계약 — 합성한 방을 자르고 다시 조립하면 원본과 같아야 한다.
 *   node --test tools/tileset/
 *  실제 참고 그림(images/assembled_preview_on_gray_floor.png)이 있으면 그것도 대조한다: 어긋난 픽셀 3% 미만. */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Canvas } from "./png.mjs";
import { analyze, compare, recompose, run, slice } from "./room-ref.mjs";
import { decodePng } from "./decode.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");

/** 합성 방: 배경 → 캡 레일 → 앞면(판 이음새) → 밑선 → 격자 바닥, 옆·아래 레일, 모서리 */
function synthRoom(W = 640, H = 520, tile = 48) {
  const cv = new Canvas(W, H);
  cv.rect(0, 0, W, H, [12, 12, 14]);
  const bx0 = 40, by0 = 30, bx1 = W - 41, by1 = H - 31;
  const cap = 20, face = 44, edge = 8, rail = 24, strip = 8;
  const fx0 = bx0 + rail + strip, fx1 = bx1 - rail - strip, fy0 = by0 + cap + face + edge, fy1 = by1 - rail - strip;
  // 바닥 격자
  for (let y = fy0; y <= fy1; y += 1) for (let x = fx0; x <= fx1; x += 1) {
    const gx = (x - fx0) % tile === 0, gy = (y - fy0) % tile === 0;
    cv.px(x, y, gx || gy ? [118, 126, 138] : [138, 148, 160], 255);
  }
  // 위 벽: 캡 · 앞면(판 주기 tile*3) · 밑선
  cv.rect(bx0, by0, bx1 - bx0 + 1, cap, [214, 218, 226]);
  cv.rect(bx0, by0 + cap, bx1 - bx0 + 1, face, [196, 190, 180]);
  for (let x = fx0; x <= fx1; x += tile * 3) cv.rect(x, by0 + cap, 2, face, [150, 144, 136]);
  cv.rect(bx0, by0 + cap + face, bx1 - bx0 + 1, edge, [70, 76, 88]);
  // 옆 벽: 레일 + 안쪽 어두운 띠
  cv.rect(bx0, fy0, rail, fy1 - fy0 + 1, [206, 210, 218]); cv.rect(bx0 + rail, fy0, strip, fy1 - fy0 + 1, [70, 76, 88]);
  cv.rect(bx1 - rail + 1, fy0, rail, fy1 - fy0 + 1, [206, 210, 218]); cv.rect(bx1 - rail - strip + 1, fy0, strip, fy1 - fy0 + 1, [70, 76, 88]);
  // 아래 벽: 어두운 띠 + 레일
  cv.rect(bx0, fy1 + 1, bx1 - bx0 + 1, strip, [70, 76, 88]); cv.rect(bx0, fy1 + 1 + strip, bx1 - bx0 + 1, rail, [206, 210, 218]);
  // 모서리 캡(밝은 정사각)
  for (const [x, y] of [[bx0, by0], [bx1 - rail + 1, by0], [bx0, by1 - rail + 1], [bx1 - rail + 1, by1 - rail + 1]]) cv.rect(x, y, rail, rail, [230, 232, 238]);
  return { img: { w: W, h: H, data: cv.d }, tile, floor: { x0: fx0, y0: fy0, x1: fx1, y1: fy1 } };
}

test("room-ref: 합성한 방을 자르고 다시 조립하면 원본과 같다", () => {
  const { img, tile, floor } = synthRoom();
  const a = analyze(img);
  assert.equal(a.tile, tile, `격자 주기 ${a.tile} ≠ ${tile}`);
  assert.deepEqual([a.floor.x0, a.floor.y0, a.floor.x1, a.floor.y1], [floor.x0, floor.y0, floor.x1, floor.y1], "바닥 영역이 틀렸다");
  assert.ok(a.topBands.length >= 3, `위 벽 띠가 ${a.topBands.length}개 (캡·앞면·밑선 셋 이상)`);
  assert.equal(a.panel, tile * 3, `앞면 판 주기 ${a.panel}`);
  const pieces = slice(img, a);
  for (const k of ["wall-top", "wall-top-left", "wall-top-right", "wall-left", "wall-right", "wall-bottom", "wall-bottom-left", "wall-bottom-right", "tile-floor", "wall-face", "wall-top-cap", "pillar-left", "pillar-right"]) assert.ok(pieces[k], `${k} 조각이 없다`);
  const rebuilt = recompose(a, pieces, img.w, img.h);
  const cmp = compare(img, rebuilt, a.box);
  assert.ok(cmp.offRatio < 0.002, `다시 조립하니 픽셀 ${(cmp.offRatio * 100).toFixed(2)}% 가 어긋난다`);
});

test("room-ref: 실제 참고 그림이 있으면 그것도 1% 안에서 다시 조립된다", (t) => {
  const src = join(ROOT, "images/assembled_preview_on_gray_floor.png");
  if (!existsSync(src)) { t.skip("images/assembled_preview_on_gray_floor.png 없음"); return; }
  const out = mkdtempSync(join(tmpdir(), "room-ref-"));
  const r = run(src, out);
  for (const k of ["wall-top", "wall-top-left", "wall-top-right", "wall-left", "wall-right", "wall-bottom", "wall-bottom-left", "wall-bottom-right", "tile-floor", "wall-face", "pillar-left", "pillar-right"]) assert.ok(r.pieces[k], `${k} 조각이 없다`);
  assert.ok(r.topBands.length >= 3, "위 벽 띠(캡·앞면·밑선)를 못 찾았다");
  assert.ok(r.recompose.offRatio < 0.01, `실제 그림 재조립 오차 ${(r.recompose.offRatio * 100).toFixed(2)}%`);
});

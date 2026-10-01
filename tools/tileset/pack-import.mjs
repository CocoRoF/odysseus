/** 팩(images/office_pixel_assets_128)을 게임 자산으로 들인다 — build.mjs 가 부른다.
 *
 *  산출:
 *   - 소품: 2배(64px/칸) 그림. 불투명 상자로 잘라 발자국 아래에 발을 맞춘다. 반쪽은 붙이고, 불량은 털고, 얹을 것은 얹는다.
 *   - 바닥: 반투명 오버레이를 바탕색 위에 합성해 불투명 128×128(=2×2칸) 타일로.
 *   - 벽: 팩의 띠를 잘라 위 벽(윗면+앞면)·옆 벽 이미지를 만든다.
 */
import { readFileSync } from "node:fs";
import { decodePng, resize } from "./decode.mjs";
import { Canvas } from "./png.mjs";
import { FLOORS, PACK_DIR, PACK_TILE, PROPS, WALLS, WALL_BODY } from "./pack.mjs";
import { OFFICE3_DIR, OFFICE3_SHEETS, OFFICE3_TILE, OBJECTS as OFFICE3_OBJECTS, WALL_STYLES as OFFICE3_WALLS } from "./office3.mjs";

const load = (root, file) => decodePng(readFileSync(`${root}/${PACK_DIR}/${file.includes("/") ? file : (file.startsWith("floor_") || file.startsWith("wall_") ? "tiles/" : "props/") + file}.png`));

function bbox(img, th = 8) {
  let l = img.w, t = img.h, r = -1, b = -1;
  for (let y = 0; y < img.h; y += 1) for (let x = 0; x < img.w; x += 1) {
    if (img.data[(y * img.w + x) * 4 + 3] <= th) continue;
    if (x < l) l = x; if (x > r) r = x; if (y < t) t = y; if (y > b) b = y;
  }
  return r < 0 ? null : { l, t, r, b, w: r - l + 1, h: b - t + 1 };
}
function crop(img, box) {
  const out = new Uint8Array(box.w * box.h * 4);
  for (let y = 0; y < box.h; y += 1) out.set(img.data.subarray(((y + box.t) * img.w + box.l) * 4, ((y + box.t) * img.w + box.r + 1) * 4), y * box.w * 4);
  return { w: box.w, h: box.h, data: out };
}
/** 가장 큰 연결 덩어리만 남긴다 — 캔버스에 노이즈가 깔린 불량 파일용 */
function despeckle(img) {
  const { w, h, data } = img;
  const seen = new Int32Array(w * h).fill(-1);
  let best = -1, bestN = 0, id = 0;
  const sizes = [];
  for (let s = 0; s < w * h; s += 1) {
    if (seen[s] >= 0 || data[s * 4 + 3] <= 8) continue;
    let n = 0; const stack = [s]; seen[s] = id;
    while (stack.length) {
      const p = stack.pop(); n += 1;
      const x = p % w, y = (p - x) / w;
      for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,-1],[1,-1],[-1,1]]) {
        const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const q = ny * w + nx; if (seen[q] >= 0 || data[q * 4 + 3] <= 8) continue;
        seen[q] = id; stack.push(q);
      }
    }
    sizes[id] = n; if (n > bestN) { bestN = n; best = id; } id += 1;
  }
  const out = new Uint8Array(data);
  for (let p = 0; p < w * h; p += 1) if (seen[p] !== best) out[p * 4 + 3] = 0;
  return { w, h, data: out };
}
function blit(dst, img, ox, oy) {
  for (let y = 0; y < img.h; y += 1) for (let x = 0; x < img.w; x += 1) {
    const o = (y * img.w + x) * 4; if (!img.data[o + 3]) continue;
    dst.px(ox + x, oy + y, [img.data[o], img.data[o + 1], img.data[o + 2]], img.data[o + 3]);
  }
}
const toImg = (cv) => ({ w: cv.w, h: cv.h, data: cv.d });

/** 소품 하나 → { img(2배 px), w, h(발자국 칸), wall } */
export function importProp(root, name) {
  const spec = PROPS[name];
  if (!spec) throw new Error(`pack: 모르는 소품 ${name}`);
  let img;
  if (spec.merge) {
    let [a, b] = spec.merge.map((f) => load(root, f));
    if (spec.despeckle) { a = despeckle(a); b = despeckle(b); }
    const ba = bbox(a), bb = bbox(b);
    const A = crop(a, ba), B = crop(b, bb);
    // 두 반쪽의 바닥을 맞춰 이어 붙인다
    const h = Math.max(A.h, B.h);
    const cv = new Canvas(A.w + B.w, h);
    blit(cv, A, 0, h - A.h); blit(cv, B, A.w, h - B.h);
    img = toImg(cv);
  } else {
    img = load(root, spec.file);
    if (spec.despeckle) img = despeckle(img);
    img = crop(img, bbox(img));
    if (spec.over) {
      // 얹는 것들을 전부 담을 만큼 캔버스를 늘린다 — 잘리지 않는다. 바탕은 아래에 붙는다.
      const tops = spec.over.map((o) => {
        let t = crop(load(root, o.file), bbox(load(root, o.file)));
        if (o.scale && o.scale !== 1) t = resize(t, Math.round(t.w * o.scale), Math.round(t.h * o.scale));
        return { img: t, dx: o.dx, dy: o.dy };
      });
      const minY = Math.min(0, ...tops.map((t) => t.dy));
      const maxY = Math.max(img.h, ...tops.map((t) => t.dy + t.img.h));
      const minX = Math.min(0, ...tops.map((t) => t.dx));
      const maxX = Math.max(img.w, ...tops.map((t) => t.dx + t.img.w));
      const cv = new Canvas(maxX - minX, maxY - minY);
      blit(cv, img, -minX, -minY);
      for (const t of tops) blit(cv, t.img, t.dx - minX, t.dy - minY);
      img = toImg(cv);
    }
  }
  // 발자국 칸(2배 px 기준)에 맞춘다: 너비는 칸 가운데, 아래는 발자국 바닥. 그림이 크면 위로 솟는다.
  const fw = spec.w * PACK_TILE;
  const cellH = Math.max(spec.h * PACK_TILE, Math.ceil(img.h / PACK_TILE) * PACK_TILE);
  const cv = new Canvas(Math.max(fw, img.w), cellH);
  blit(cv, img, Math.floor((cv.w - img.w) / 2), cellH - img.h);
  return { img: toImg(cv), w: spec.w, h: spec.h, rise: (cellH - spec.h * PACK_TILE) / PACK_TILE, wall: !!spec.wall, cols: Math.ceil(cv.w / PACK_TILE), vis: img.h };
}

/** 바닥 — 바탕색 위에 합성해 불투명 128×128 */
export function importFloor(root, key) {
  const spec = FLOORS[key];
  const img = load(root, spec.file);
  const cv = new Canvas(img.w, img.h);
  for (let y = 0; y < img.h; y += 1) for (let x = 0; x < img.w; x += 1) {
    const o = (y * img.w + x) * 4, a = img.data[o + 3] / 255;
    cv.px(x, y, [0, 1, 2].map((i) => Math.round(spec.base[i] * (1 - a) + img.data[o + i] * a)), 255);
  }
  return toImg(cv);
}

/** 벽 — 한 칸(64px) 두께.
 *   wall-h 128×64: 캡(wall_top 16px) 아래에 앞면(wall_bottom 의 얼굴 24px)을 두 번 이어 48px. 아래 이음새는 살짝 어둡게.
 *   wall-v  64×128: 안쪽 레일(wall_right, 16px) + 몸통 32px + 바깥 레일 16px — 좌우 대칭. */
export function importWalls(root) {
  const top = load(root, WALLS.top), bottom = load(root, WALLS.bottom), right = load(root, WALLS.right);
  const bt = bbox(top, 1), bb = bbox(bottom, 1), br = bbox(right, 1);
  const cap = crop(top, { l: 0, r: 127, t: bt.t, b: bt.b, w: 128, h: bt.h }); // 16px
  const strip = crop(bottom, { l: 0, r: 127, t: bb.t, b: bb.b, w: 128, h: bb.h }); // 32px: 위 8px 캡 + 24px 얼굴
  // 얼굴 48px: 캡 아래 그늘띠(8)+판 얼굴(16)을 한 번, 그 아래로 판 얼굴만 이어 붙인다 — 가운데 이음새가 생기지 않는다.
  const shade = crop(strip, { l: 0, r: 127, t: 8, b: 31, w: 128, h: 24 });
  const panel = crop(strip, { l: 0, r: 127, t: 16, b: 31, w: 128, h: 16 });
  const foot = crop(strip, { l: 0, r: 127, t: 24, b: 31, w: 128, h: 8 });
  const wallH = new Canvas(128, 64);
  blit(wallH, resize(cap, 128, 16), 0, 0);
  blit(wallH, shade, 0, 16);
  blit(wallH, panel, 0, 40);
  blit(wallH, foot, 0, 56);
  // 걸레받이 — 벽이 바닥에 닿는 선
  wallH.rect(0, 60, 128, 4, [0, 0, 0], 60);
  // 레일은 위아래 끝단(둥근 캡)을 빼고 가운데 88px 만 쓴다 — 반복해도 마디가 생기지 않는다.
  const rail = crop(right, { l: br.l, r: br.r, t: 20, b: 107, w: br.w, h: 88 });
  const wallV = new Canvas(64, 128);
  wallV.rect(0, 0, 64, 128, WALL_BODY);
  blit(wallV, resize(rail, 16, 128), 0, 0);
  blit(wallV, resize(rail, 16, 128), 48, 0);
  return { wallH: toImg(wallH), wallV: toImg(wallV) };
}


// ── 방 참고 그림의 조각(images/office_room_ref, room-ref.mjs 산출) → 우리 벽·바닥 ─────────
//
// 배율: 참고 그림의 위 벽 전체 높이(캡+앞면+밑선 ≈108px)를 96px(2배 아틀라스에서 1.5칸)에 맞춘다.
// 그 배율을 모든 조각에 같이 쓴다 — 레일 굵기가 위·옆·아래에서 같아 보인다.
//   wall-h   128×96  캡+앞면+밑선. 위쪽 벽. 캡이 고리 위로 반 칸(32px) 솟거나(h) 밑선이 복도로 반 칸 내려간다(hf).
//   wall-hb  256×64  킥 밴드+레일+어두운 바깥. 아래쪽(남쪽에 아무것도 없는) 벽. 눈금 주기가 살아 있다.
//   wall-vl   64×64  왼쪽 벽(바닥이 오른쪽): 벽 띠를 오른쪽에 붙이고 왼쪽은 투명. wall-vr 은 거울.
//   corner-* 모서리: 캡 상자·앞면 그림자·레일 시작을 품는다. 안쪽 벽 띠 폭(dx)만큼 고리 칸 안으로 맞춘다.
//   floor-slate 128×128 바닥.
import { existsSync } from "node:fs";

const REF_DIR = "images/office_room_ref";
const loadRef = (root, name) => decodePng(readFileSync(`${root}/${REF_DIR}/${name}.png`));

export function hasRoomRef(root) {
  return existsSync(`${root}/${REF_DIR}/pieces.json`);
}

export function importRoomRef(root) {
  const meta = JSON.parse(readFileSync(`${root}/${REF_DIR}/pieces.json`, "utf8"));
  const topH = meta.floor.y0 - meta.box.y0; // 캡+앞면+밑선
  const bottomH = meta.box.y1 - meta.floor.y1;
  const leftW = meta.floor.x0 - meta.box.x0, rightW = meta.box.x1 - meta.floor.x1;
  const s = 96 / topH;
  const sc = (img, w, h) => resize(img, Math.max(1, Math.round(w)), Math.max(1, Math.round(h)));
  const canvasWith = (w, h, img, ox, oy) => { const cv = new Canvas(w, h); blit(cv, img, ox, oy); return toImg(cv); };

  const wallH = sc(loadRef(root, "wall-top"), 128, 96);
  const bottom = loadRef(root, "wall-bottom");
  const wallHB = sc(bottom, 256, Math.min(64, Math.round(bottomH * s)));
  const hb = canvasWith(256, 64, wallHB, 0, 0);
  // 아래 벽이 64 보다 짧으면 마지막 줄(바깥 어두운 색)로 채운다
  if (wallHB.h < 64) { const last = { w: 256, h: 1, data: wallHB.data.subarray((wallHB.h - 1) * 256 * 4, wallHB.h * 256 * 4) }; const cv = new Canvas(256, 64); blit(cv, wallHB, 0, 0); for (let y = wallHB.h; y < 64; y += 1) blit(cv, last, 0, y); hb.data.set(cv.d); }

  const vlStrip = sc(loadRef(root, "wall-left"), leftW * s, 64);
  const vrStrip = sc(loadRef(root, "wall-right"), rightW * s, 64);
  const vl = canvasWith(64, 64, vlStrip, 64 - vlStrip.w, 0);
  const vr = canvasWith(64, 64, vrStrip, 0, 0);

  const tl = sc(loadRef(root, "wall-top-left"), loadRef(root, "wall-top-left").w * s, 96);
  const tr = sc(loadRef(root, "wall-top-right"), loadRef(root, "wall-top-right").w * s, 96);
  const bl = sc(loadRef(root, "wall-bottom-left"), loadRef(root, "wall-bottom-left").w * s, 64);
  const br = sc(loadRef(root, "wall-bottom-right"), loadRef(root, "wall-bottom-right").w * s, 64);

  // 기둥 발 — 옆 벽이 곧게 지나가는 벽(북쪽 방의 문 벽)에 닿는 자리에 얹는 상자. 같은 배율.
  const pillarL = loadRef(root, "pillar-left"), pillarR = loadRef(root, "pillar-right");
  const pl = sc(pillarL, pillarL.w * s, pillarL.h * s);
  const pr = sc(pillarR, pillarR.w * s, pillarR.h * s);

  const floor2 = loadRef(root, "tile-floor-2x2");
  const slate = floor2.w === 128 && floor2.h === 128 ? floor2 : resize(floor2, 128, 128);

  return {
    wallH, wallHB: hb, wallVL: vl, wallVR: vr,
    corners: { tl, tr, bl, br },
    pillars: { l: pl, r: pr },
    /** 안쪽 벽 띠의 폭(아틀라스 px) — 모서리 조각을 고리 칸 안쪽에 맞추는 기준 */
    stripW: { left: vlStrip.w, right: vrStrip.w },
    floor: slate,
  };
}

// ── 벽 세트 (images/office_wall_exact_reference_19) ─────────────────────────
//
// 19장 전부 128×128 RGBA, 벽 선이 타일 한가운데(63.5)를 지난다. 01~15 는 기둥(팔각 캡, x 52~75 · y 43~83)에
// 방향별 레일 토막(타일 끝까지)이 붙은 접합 타일, 16~19 는 기둥 없는 레일이다. 16=18, 17=19 로 그림이 같다(바이트까지).
// 세로 레일 x 58~69(12px) · 가로 레일 y 51~78(캡 52~57 · 앞면 58~72 · 그림자 74~78). 판 이음새는 1px 선이라 겹쳐 그려도 안 보인다.
export const WALLSET_DIR = "images/office_wall_exact_reference_19";
/** 시트 순서 = 좌표표의 인덱스. 이름은 파일의 연결 이름 그대로(N·E·S·W 순, 서북 모서리만 WN). */
export const WALL_TILE_ORDER = ["N", "E", "S", "W", "NE", "ES", "SW", "WN", "NS", "EW", "NEW", "NES", "ESW", "NSW", "NESW", "rail-h", "rail-v"];
const WALLSET_FILES = {
  N: "01_end_N", E: "02_end_E", S: "03_end_S", W: "04_end_W",
  NE: "05_corner_NE", ES: "06_corner_ES", SW: "07_corner_SW", WN: "08_corner_WN",
  NS: "09_straight_NS", EW: "10_straight_EW",
  NEW: "11_T_NEW", NES: "12_T_NES", ESW: "13_T_ESW", NSW: "14_T_NSW", NESW: "15_cross_NESW",
  "rail-h": "16_wall_top", "rail-v": "17_wall_right",
};
const WALLSET_TWINS = { "rail-h": "18_wall_bottom", "rail-v": "19_wall_left" };
const WALL_PX = 128;

export function hasWallSet(root) {
  return existsSync(`${root}/${WALLSET_DIR}/${WALLSET_FILES.N}.png`);
}

/** 19장을 읽어 한 줄 시트(17×128)로 잇고, 그림에서 기하를 잰다. 그림이 약속과 다르면 멈춘다 — 조용히 틀리게 그리지 않는다. */
export function importWallSet(root) {
  const read = (file) => decodePng(readFileSync(`${root}/${WALLSET_DIR}/${file}.png`));
  const tiles = {};
  for (const key of WALL_TILE_ORDER) {
    const img = read(WALLSET_FILES[key]);
    if (img.w !== WALL_PX || img.h !== WALL_PX) throw new Error(`[wallset] ${WALLSET_FILES[key]}: ${WALL_PX}×${WALL_PX} 이어야 한다 (${img.w}×${img.h})`);
    tiles[key] = img;
  }
  // 18/19 는 16/17 과 같은 그림이어야 한다 — 다르면 어느 쪽이 정본인지 사람이 정해야 한다
  for (const [key, twin] of Object.entries(WALLSET_TWINS)) {
    const b = read(twin), a = tiles[key];
    if (a.w !== b.w || a.h !== b.h || !a.data.every((v, i) => v === b.data[i])) throw new Error(`[wallset] ${twin} 이 ${WALLSET_FILES[key]} 과 다르다 — 레일은 위아래·좌우가 같은 그림이어야 한다`);
  }
  // 접합 타일의 연결이 이름과 맞는가 — 타일 가장자리 한가운데가 불투명해야 그쪽으로 이어진 것
  const opaque = (img, x, y) => img.data[(y * img.w + x) * 4 + 3] > 8;
  const mid = WALL_PX / 2 - 1;
  for (const key of WALL_TILE_ORDER) {
    if (key.startsWith("rail")) continue;
    const img = tiles[key];
    const has = { N: opaque(img, mid, 0) || opaque(img, mid + 1, 0), E: opaque(img, WALL_PX - 1, mid) || opaque(img, WALL_PX - 1, mid + 1), S: opaque(img, mid, WALL_PX - 1) || opaque(img, mid + 1, WALL_PX - 1), W: opaque(img, 0, mid) || opaque(img, 0, mid + 1) };
    for (const d of ["N", "E", "S", "W"]) if (has[d] !== key.includes(d)) throw new Error(`[wallset] ${WALLSET_FILES[key]}: ${d} 쪽 가장자리가 ${has[d] ? "이어져 있는데" : "비어 있는데"} 이름은 ${key} 다`);
  }
  // 기하 — 레일 단면과 기둥 상자. 타일 중심(64) 기준 2배 px. 좌표표는 ÷2 해 월드 px 로 낸다.
  const railH = bbox(tiles["rail-h"]), railV = bbox(tiles["rail-v"]);
  const endN = bbox(tiles.N), endS = bbox(tiles.S);
  if (!railH || !railV || !endN || !endS) throw new Error("[wallset] 빈 타일이 있다");
  const c = WALL_PX / 2;
  const geometry = {
    railH: { top: railH.t - c, bottom: railH.b + 1 - c },
    railV: { left: railV.l - c, right: railV.r + 1 - c },
    post: { left: endN.l - c, right: endN.r + 1 - c, top: endS.t - c, bottom: endN.b + 1 - c },
  };
  const sheet = new Canvas(WALL_PX * WALL_TILE_ORDER.length, WALL_PX);
  WALL_TILE_ORDER.forEach((key, i) => blit(sheet, tiles[key], i * WALL_PX, 0));
  return { sheet: { w: sheet.w, h: sheet.h, data: sheet.d }, order: WALL_TILE_ORDER, geometry, px: WALL_PX };
}

// ── Office-3 (구입 팩, RPG Maker 규격 48px) ────────────────────────
//
// 물건은 매니페스트(office3.mjs)의 칸 사각형 그대로 잘라 낸다 — 다듬지 않는다. 칸이 곧 발자국의 단위라 그림의 칸 수가
// 스프라이트의 칸 수다. 아틀라스 배율은 1(48px = 월드 한 칸). 색 이름이 필요한 물건(의자)은 그림에서 색상을 잰다.

const loadSheet = (() => { const cache = new Map(); return (root, name) => { if (!cache.has(name)) cache.set(name, decodePng(readFileSync(`${root}/${OFFICE3_DIR}/${name}.png`))); return cache.get(name); }; })();

/** 채도 높은 픽셀의 색상으로 색 이름을 고른다. 채도가 낮으면 밝기로 검정·회색. 주황 계열이 어두우면 갈색. */
function colorNameOf(img) {
  const hist = new Array(360).fill(0);
  let n = 0, sat = 0, lumSat = 0, lumAll = 0;
  for (let i = 0; i < img.w * img.h; i += 1) {
    const a = img.data[i * 4 + 3]; if (a < 128) continue;
    const r = img.data[i * 4] / 255, g = img.data[i * 4 + 1] / 255, b = img.data[i * 4 + 2] / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min, l = (max + min) / 2;
    n += 1; lumAll += l;
    if (d < 0.001) continue;
    const sv = d / (1 - Math.abs(2 * l - 1) || 1);
    if (sv < 0.3 || l < 0.12 || l > 0.95) continue;
    let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h = Math.round(h * 60); if (h < 0) h += 360;
    hist[h % 360] += 1; sat += 1; lumSat += l;
  }
  if (!n) return "회색";
  if (sat / n < 0.06) return lumAll / n < 0.32 ? "검정" : "회색";
  let best = 0, bestSum = -1;
  for (let h = 0; h < 360; h += 1) { let sum = 0; for (let k = -15; k <= 15; k += 1) sum += hist[(h + k + 360) % 360]; if (sum > bestSum) { bestSum = sum; best = h; } }
  const l = lumSat / sat;
  if (best >= 15 && best < 50) return l < 0.5 ? "갈색" : "주황";
  if (best >= 50 && best < 70) return "노랑";
  if (best >= 70 && best < 170) return "초록";
  if (best >= 170 && best < 205) return "하늘";
  if (best >= 205 && best < 255) return "파랑";
  if (best >= 255 && best < 300) return "보라";
  if (best >= 300 && best < 345) return "분홍";
  return "빨강";
}

export function visibleRows(img) {
  let t = img.h, b = -1;
  for (let y = 0; y < img.h; y += 1) for (let x = 0; x < img.w; x += 1) if (img.data[(y * img.w + x) * 4 + 3] > 8) { if (y < t) t = y; if (y > b) b = y; }
  return b < 0 ? 0 : b - t + 1;
}

/** 매니페스트의 모든 물건 → {name, label, group, w, h(칸), foot:{w,h}, rise, wall, walk, vis(px), img(48px/칸)} */
/** 잎(초록) 픽셀 — 화분이 다른 물건 위에 겹쳐 그려진 곳을 가르는 자 */
const isLeaf = (d, o) => d[o + 3] > 0 && d[o + 1] > d[o] + 8 && d[o + 1] >= d[o + 2];

/** 사각형 안을 지운다(캔버스 좌표, pad 포함). keep: "leaf" 면 잎과 그 테두리(1px)는 남기고, "notLeaf" 면 잎만 지운다. */
export function clearRect(cv, { x0, y0, x1, y1, keep }) {
  const w = cv.w, h = cv.h;
  const leaf = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i += 1) if (isLeaf(cv.d, i * 4)) leaf[i] = 1;
  const nearLeaf = (x, y) => {
    for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < w && yy < h && leaf[yy * w + xx]) return true;
    }
    return false;
  };
  for (let y = Math.max(0, y0); y < Math.min(h, y1); y += 1) for (let x = Math.max(0, x0); x < Math.min(w, x1); x += 1) {
    const i = y * w + x;
    if (keep === "leaf" && nearLeaf(x, y)) continue;
    if (keep === "notLeaf" && !leaf[i]) continue;
    cv.d[i * 4 + 3] = 0;
  }
}

/** 칸 경계를 넘어온 옆 물건의 조각을 지운다.
 *
 *  시트에서 물건끼리 붙어 그려져 칸 사각형으로 자르면 이웃의 가장자리가 따라온다 — 유리 탁자 위에 ㄱ자 소파의 밑단,
 *  복합기 옆에 이웃 기계의 테두리 한 줄, 정수기·조리대 맨 윗줄에 위 물건의 밑선 한 줄. 두 가지로 지운다.
 *   - isolate(매니페스트에서 켠다): 8-이웃으로 이어진 **가장 큰 덩어리만** 남긴다. 이웃이 칸 안으로 크게 넘어온 물건용.
 *   - 모든 물건: 가장자리에 붙은 **두께 2px 이하·알파 64 이하**의 흐린 조각(전체의 3% 이하)을 지운다 — 시트의 칸 경계에
 *     남은 잔상 줄이다. 제 그림의 테두리는 몸통과 이어져 있고 불투명하다.
 *  지운 덩어리 수를 돌려준다. */
export function cleanBleed(cv, { isolate = false } = {}) {
  const w = cv.w, h = cv.h, n = w * h;
  const lab = new Int32Array(n).fill(-1);
  const comps = [];
  for (let i = 0; i < n; i += 1) {
    if (lab[i] !== -1 || cv.d[i * 4 + 3] === 0) continue;
    const c = { id: comps.length, n: 0, x0: w, y0: h, x1: -1, y1: -1, amax: 0 };
    const stack = [i];
    lab[i] = c.id;
    while (stack.length) {
      const j = stack.pop();
      const x = j % w, y = (j - x) / w;
      c.n += 1;
      if (cv.d[j * 4 + 3] > c.amax) c.amax = cv.d[j * 4 + 3];
      if (x < c.x0) c.x0 = x; if (x > c.x1) c.x1 = x; if (y < c.y0) c.y0 = y; if (y > c.y1) c.y1 = y;
      for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
        if (!dx && !dy) continue;
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const k = yy * w + xx;
        if (lab[k] !== -1 || cv.d[k * 4 + 3] === 0) continue;
        lab[k] = c.id;
        stack.push(k);
      }
    }
    comps.push(c);
  }
  if (comps.length < 2) return 0;
  const total = comps.reduce((a, c) => a + c.n, 0);
  const big = comps.reduce((a, c) => (c.n > a.n ? c : a));
  const drop = new Set();
  for (const c of comps) {
    if (c === big) continue;
    if (isolate) { drop.add(c.id); continue; }
    const thinY = (c.y0 === 0 || c.y1 === h - 1) && c.y1 - c.y0 + 1 <= 2;
    const thinX = (c.x0 === 0 || c.x1 === w - 1) && c.x1 - c.x0 + 1 <= 2;
    // 흐린 것만 — 시트의 칸 경계에 남은 알파 1~40 대의 잔상이다(실측: 지워진 211개 전부 알파 42 이하). 불투명한 가는 줄은
    // 제 그림일 수 있으니 매니페스트에서 사람이 판단한다(isolate · inset).
    if ((thinY || thinX) && c.n <= total * 0.03 && c.amax <= 64) drop.add(c.id);
  }
  if (drop.size) for (let i = 0; i < n; i += 1) if (lab[i] !== -1 && drop.has(lab[i])) cv.d[i * 4 + 3] = 0;
  return drop.size;
}

export function importOffice3(root) {
  const T = OFFICE3_TILE;
  const out = [];
  const colorCount = new Map();
  for (const o of OFFICE3_OBJECTS) {
    const sheet = loadSheet(root, OFFICE3_SHEETS[o.sheet]);
    const cells = o.cells ?? [];
    if (!o.cells) for (let dy = 0; dy < o.h; dy += 1) for (let dx = 0; dx < o.w; dx += 1) cells.push([o.cx + dx, o.cy + dy]);
    // pad 는 상자 밖으로 더 잘라 오는 몫(오른쪽·위) — 스프라이트는 왼쪽 아래가 기준이라 그 두 방향은 늘어나도 자리가 그대로다
    const padR = o.pad?.r ?? 0, padT = o.pad?.t ?? 0;
    const cv = new Canvas(o.w * T + padR, o.h * T + padT);
    const put = (sx, sy, dx, dy) => {
      if (sx < 0 || sy < 0 || sx >= sheet.w || sy >= sheet.h) return 0;
      const s = (sy * sheet.w + sx) * 4, a = sheet.data[s + 3];
      if (!a) return 0;
      const d = (dy * cv.w + dx) * 4;
      cv.d[d] = sheet.data[s]; cv.d[d + 1] = sheet.data[s + 1]; cv.d[d + 2] = sheet.data[s + 2]; cv.d[d + 3] = a;
      return 1;
    };
    let opaque = 0;
    for (const [cx, cy] of cells) {
      if (cx < o.cx || cx >= o.cx + o.w || cy < o.cy || cy >= o.cy + o.h) throw new Error(`[office3] ${o.name}: 칸 (${cx},${cy}) 이 상자 밖이다`);
      if ((cx + 1) * T > sheet.w || (cy + 1) * T > sheet.h) throw new Error(`[office3] ${o.name}: 시트 밖이다`);
      for (let y = 0; y < T; y += 1) for (let x = 0; x < T; x += 1) opaque += put(cx * T + x, cy * T + y, (cx - o.cx) * T + x, padT + (cy - o.cy) * T + y);
    }
    if (padR) for (let y = 0; y < o.h * T; y += 1) for (let x = 0; x < padR; x += 1) put((o.cx + o.w) * T + x, (o.cy) * T + y, o.w * T + x, padT + y);
    if (padT) for (let y = 0; y < padT; y += 1) for (let x = 0; x < o.w * T; x += 1) put(o.cx * T + x, o.cy * T - padT + y, x, y);
    // inset 은 상자 안쪽에서 지우는 몫 — 옆 물건의 그림이 칸 경계를 넘어와 있을 때
    if (o.inset) {
      const clear = (x0, y0, x1, y1) => { for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) { const d = (y * cv.w + x) * 4; cv.d[d + 3] = 0; } };
      if (o.inset.l) clear(0, 0, o.inset.l, cv.h);
      if (o.inset.r) clear(cv.w - o.inset.r, 0, cv.w, cv.h);
      if (o.inset.t) clear(0, 0, cv.w, o.inset.t);
      if (o.inset.b) clear(0, cv.h - o.inset.b, cv.w, cv.h);
    }
    // 겹쳐 그려진 이웃 지우기 — 시트에서 잎이 소파 위에, 소파 밑단이 탁자 칸 안에 그려져 있다
    for (const r of o.clear ?? []) clearRect(cv, r);
    // 옆 물건의 그림 떼어 내기(2026-09-14 지적: 유리 탁자에 소파 밑단이 붙어 보였다)
    cleanBleed(cv, { isolate: !!o.isolate });
    if (opaque < 40) throw new Error(`[office3] ${o.name}: 그림이 비어 있다 (${o.sheet} ${o.cx},${o.cy} ${o.w}×${o.h})`);
    const img = { w: cv.w, h: cv.h, data: cv.d };
    let label = o.label;
    if (o.colorName) {
      const c = colorNameOf(img);
      const k = colorCount.get(c) ?? 0; colorCount.set(c, k + 1);
      label = `${o.label} (${c})${k ? ` ${k + 1}` : ""}`;
    }
    const footH = o.foot ?? o.h;
    out.push({ name: o.name, label, group: o.group, w: o.w, h: o.h, foot: { w: o.w, h: footH }, rise: o.h - footH, wall: !!o.wall, walk: !!o.walk, vis: visibleRows(img), img });
  }
  return out;
}

/** A4 벽 오토타일 → 스타일별 변형 시트.
 *
 *  블록(96×240): 위 2×3(96×144)이 벽 윗면 오토타일(RPG Maker A2 형식 — 맨 위 왼쪽 칸이 안쪽 모서리 넷, 그 오른쪽은 미리보기,
 *  아래 2×2 가 가장자리·가운데의 4×4 4분면), 아래 2×2(96×96)가 벽 앞면 오토타일(4×4 4분면). 칸 하나는 4분면(24px) 넷으로
 *  그리고, 어느 4분면을 쓸지는 이웃 벽에 달렸다 — 윗면은 8방향(안쪽 모서리는 대각선이 비었을 때), 앞면은 좌우(상하).
 *  256가지 8방향 마스크는 47가지 그림으로 줄어든다. 스타일마다 47 + 16 장을 한 줄 16칸 시트로 낸다. */
export function importA4Walls(root) {
  const T = 48, Q = 24, COLS = 16;
  const topQuad = (m) => {
    const n = !!(m & 1), ne = !!(m & 2), e = !!(m & 4), se = !!(m & 8), s = !!(m & 16), sw = !!(m & 32), w = !!(m & 64), nw = !!(m & 128);
    const TL = !n && !w ? [0, 2] : !n && w ? [2, 2] : n && !w ? [0, 4] : !nw ? [2, 0] : [2, 4];
    const TR = !n && !e ? [3, 2] : !n && e ? [1, 2] : n && !e ? [3, 4] : !ne ? [3, 0] : [1, 4];
    const BL = !s && !w ? [0, 5] : !s && w ? [2, 5] : s && !w ? [0, 3] : !sw ? [2, 1] : [2, 3];
    const BR = !s && !e ? [3, 5] : !s && e ? [1, 5] : s && !e ? [3, 3] : !se ? [3, 1] : [1, 3];
    return [TL, TR, BL, BR];
  };
  const faceQuad = (b) => { const l = !!(b & 1), u = !!(b & 2), r = !!(b & 4), d = !!(b & 8); return [[l ? 2 : 0, u ? 2 : 0], [r ? 1 : 3, u ? 2 : 0], [l ? 2 : 0, d ? 1 : 3], [r ? 1 : 3, d ? 1 : 3]]; };
  const keyOf = (q) => q.map((p) => p.join(",")).join("|");
  const topIndex = new Array(256), topVariants = [], seen = new Map();
  for (let m = 0; m < 256; m += 1) { const q = topQuad(m), k = keyOf(q); if (!seen.has(k)) { seen.set(k, topVariants.length); topVariants.push(q); } topIndex[m] = seen.get(k); }
  const faceVariants = []; for (let b = 0; b < 16; b += 1) faceVariants.push(faceQuad(b));
  const G = 1;
  const px = (cv, x, y, c) => { const o = (y * cv.w + x) * 4; if (c === undefined) return [cv.d[o], cv.d[o + 1], cv.d[o + 2], cv.d[o + 3]]; cv.d[o] = c[0]; cv.d[o + 1] = c[1]; cv.d[o + 2] = c[2]; cv.d[o + 3] = c[3]; return c; };
  const copy = (cv, img, sx, sy, dx, dy) => { for (let y = 0; y < Q; y += 1) for (let x = 0; x < Q; x += 1) { const s = ((sy + y) * img.w + sx + x) * 4, d = ((dy + y) * cv.w + dx + x) * 4; cv.d[d] = img.data[s]; cv.d[d + 1] = img.data[s + 1]; cv.d[d + 2] = img.data[s + 2]; cv.d[d + 3] = img.data[s + 3]; } };
  const styles = {};
  for (const st of OFFICE3_WALLS) {
    const img = loadSheet(root, st.sheet);
    const ox = st.bx * 96, oy = st.by * 240;
    if (ox + 96 > img.w || oy + 240 > img.h) throw new Error(`[office3] 벽 ${st.key}: 블록 (${st.bx},${st.by}) 이 시트 밖이다`);
    const tiles = [...topVariants.map((q) => ({ q, oy })), ...faceVariants.map((q) => ({ q, oy: oy + 144 }))];
    const rows = Math.ceil(tiles.length / COLS);
    // 칸 둘레 1px 여백을 가장자리 색으로 채운다 — 소수 배율의 최근접 샘플링이 이웃 칸을 집어 오지 않게
    const P = T + 2 * G;
    const cv = new Canvas(COLS * P, rows * P);
    tiles.forEach((t, i) => {
      const tx = (i % COLS) * P + G, ty = Math.floor(i / COLS) * P + G;
      const at = [[0, 0], [Q, 0], [0, Q], [Q, Q]];
      t.q.forEach(([qx, qy], k) => copy(cv, img, ox + qx * Q, t.oy + qy * Q, tx + at[k][0], ty + at[k][1]));
      for (let i2 = -1; i2 <= T; i2 += 1) { const sx = Math.max(0, Math.min(T - 1, i2)); px(cv, tx + i2, ty - 1, px(cv, tx + sx, ty)); px(cv, tx + i2, ty + T, px(cv, tx + sx, ty + T - 1)); }
      for (let j = 0; j < T; j += 1) { px(cv, tx - 1, ty + j, px(cv, tx, ty + j)); px(cv, tx + T, ty + j, px(cv, tx + T - 1, ty + j)); }
    });
    styles[st.key] = { img: { w: cv.w, h: cv.h, data: cv.d }, label: st.label, rows };
  }
  return { styles, topIndex, topCount: topVariants.length, faceCount: faceVariants.length, cols: COLS, tile: T, pitch: T + 2 * G, gutter: G };
}

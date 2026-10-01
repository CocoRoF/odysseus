#!/usr/bin/env node
/** 아틀라스(PNG) + 좌표표(TS)를 만든다. 산출물은 커밋한다 — README 참조.
 *
 *  소품·벽의 정본은 구입한 팩 Office-3(RPG Maker 규격 48px) 이다 — office3.mjs 가 모든 물건을 안다.
 *  구입 팩은 재배포할 수 없어 비공개 서브모듈 apps/web/public/office/licensed(odysseus-licensed-assets)에 산다 —
 *  원본은 그 안의 source/Office-3, 팩에서 만든 소품·벽 시트(atlas-*, wall-*)도 그 안에 쓴다(/office/licensed/…).
 *  바닥은 이전 팩(office_pixel_assets_128)의 열한 장 + 참고 그림의 회색 바닥(images/office_room_ref) — Office-3 에는 바닥이 없다.
 *  아틀라스 배율은 1 — 48px 가 월드 한 칸이다. 픽셀 아트를 다시 샘플링하지 않는다(화면은 image-rendering: pixelated).
 */
import { writeFileSync, mkdirSync, readdirSync, unlinkSync, existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { Canvas } from "./png.mjs";
import { decodePng, resize } from "./decode.mjs";
import { FLOORS } from "./pack.mjs";
import { hasRoomRef, importFloor, importRoomRef, importOffice3, importA4Walls, visibleRows } from "./pack-import.mjs";
import { officeDoor } from "./draw2.mjs";
import { GROUPS, LEGACY_NAMES, OFFICE3_TILE, WALL_STYLES } from "./office3.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const PUB = `${ROOT}/apps/web/public/office`;
mkdirSync(PUB, { recursive: true });
/** 구입 팩과 그 팩에서 만든 시트 — 비공개 서브모듈. 없으면 소품·벽을 만들 수 없다. */
const LIC = `${PUB}/licensed`;
if (!existsSync(`${LIC}/source/Office-3`)) {
  console.error("구입 에셋 서브모듈이 없습니다 — git submodule update --init apps/web/public/office/licensed (권한 필요)");
  process.exit(1);
}

/** 바꿔 끼우기 — assets/office/sprites/<이름>.png 또는 tiles/<이름>.png 가 있으면 그 그림을 같은 크기로 줄여 쓴다. */
const ASSETS = `${ROOT}/assets/office`;
let replaced = 0;
function replacement(kind, name) {
  const file = `${ASSETS}/${kind}/${name}.png`;
  if (!existsSync(file)) return null;
  try { return decodePng(readFileSync(file)); }
  catch (e) { console.warn(`  ⚠ ${file}: 읽지 못해 원래 그림을 씁니다 (${e.message})`); return null; }
}
function blit(dst, img, ox, oy) {
  for (let y = 0; y < img.h; y += 1) for (let x = 0; x < img.w; x += 1) {
    const o = (y * img.w + x) * 4;
    if (!img.data[o + 3]) continue;
    dst.px(ox + x, oy + y, [img.data[o], img.data[o + 1], img.data[o + 2]], img.data[o + 3]);
  }
}

/** 파일 이름에 내용 해시를 붙인다 — 그림과 좌표가 언제나 한 쌍이다(/office/*.png 는 4시간 캐시된다). 옛 파일은 지운다. */
const written = new Map(); // 논리 이름 → URL
function emit(name, bytes, licensed = false) {
  const hash = createHash("sha1").update(bytes).digest("hex").slice(0, 10);
  const file = `${name}.${hash}.png`;
  writeFileSync(`${licensed ? LIC : PUB}/${file}`, bytes);
  const url = `/office/${licensed ? "licensed/" : ""}${file}`;
  written.set(name, url);
  return url;
}

// ── 소품 아틀라스 — 묶음(group)마다 한 장 ─────────────────────────
// 팩 전체를 한 장에 넣으면 4MB 다(픽셀 아트가 촘촘해 잘 눌리지 않는다). 묶음마다 한 장으로 나누면 층이 쓰는 묶음만 받는다 —
// 브라우저는 화면에 놓인 요소의 background-image 만 가져온다.
const T = OFFICE3_TILE;
const objects = importOffice3(ROOT).map((o) => {
  const png = replacement("sprites", o.name);
  if (!png) return o;
  replaced += 1;
  return { ...o, img: resize(png, o.img.w, o.img.h) };
});
// 팩에 없는 것 — 사무실 출입문(닫힘·열림)은 draw2 가 팩의 결로 그린다. 벽걸이 묶음에 들어간다.
for (const d of [{ name: "door-office", label: "사무실 문 (양문)", open: false }, { name: "door-office-open", label: "사무실 문 (양문, 열림)", open: true }]) {
  const img = officeDoor(d.open);
  objects.push({ name: d.name, label: d.label, group: "wall", w: 2, h: 2, foot: { w: 2, h: 2 }, rise: 0, wall: true, walk: false, vis: visibleRows(img), img });
}
const COLS = 16;
/** 여백 — 스프라이트 둘레 1px 를 가장자리 색으로 늘려 둔다. 소수 배율의 최근접 샘플링은 상자 경계에서 이웃 스프라이트의 픽셀을
 *  집어 오는데(텍스처 블리딩), 그것이 화면의 실금이었다. 좌표표는 여백 안쪽의 진짜 상자를 가리킨다. */
const G = 1;
const extendEdges = (cv, x, y, w, h) => {
  const get = (px, py) => { const o = (py * cv.w + px) * 4; return [cv.d[o], cv.d[o + 1], cv.d[o + 2], cv.d[o + 3]]; };
  const set = (px, py, c) => { const o = (py * cv.w + px) * 4; cv.d[o] = c[0]; cv.d[o + 1] = c[1]; cv.d[o + 2] = c[2]; cv.d[o + 3] = c[3]; };
  for (let i = 0; i < w; i += 1) { set(x + i, y - 1, get(x + i, y)); set(x + i, y + h, get(x + i, y + h - 1)); }
  for (let j = 0; j < h; j += 1) { set(x - 1, y + j, get(x, y + j)); set(x + w, y + j, get(x + w - 1, y + j)); }
  set(x - 1, y - 1, get(x, y)); set(x + w, y - 1, get(x + w - 1, y)); set(x - 1, y + h, get(x, y + h - 1)); set(x + w, y + h, get(x + w - 1, y + h - 1));
};
const placed = [];
const sheets = {}; // group → { w, h, url }
const SHEET_W = COLS * (T + 2 * G);
for (const group of Object.keys(GROUPS)) {
  const mine = objects.filter((o) => o.group === group).sort((a, b) => b.h - a.h || b.w - a.w || a.name.localeCompare(b.name));
  if (!mine.length) continue;
  // 선반 채우기(px) — 키 큰 것부터, 줄이 차면 다음 선반
  let x = 0, y = 0, rowH = 0;
  const here = [];
  for (const s of mine) {
    const pw = s.img.w + 2 * G, ph = s.img.h + 2 * G;
    if (x + pw > SHEET_W) { x = 0; y += rowH; rowH = 0; }
    here.push({ ...s, px: x + G, py: y + G });
    x += pw; rowH = Math.max(rowH, ph);
  }
  const cv = new Canvas(SHEET_W, y + rowH);
  for (const s of here) { blit(cv, s.img, s.px, s.py); extendEdges(cv, s.px, s.py, s.img.w, s.img.h); }
  const url = emit(`atlas-${group}`, cv.png(), true); // 구입 팩에서 잘라 만든 시트
  sheets[group] = { w: cv.w, h: cv.h, url };
  placed.push(...here);
}
const unknown = objects.filter((o) => !GROUPS[o.group]);
if (unknown.length) throw new Error(`모르는 묶음: ${unknown.map((o) => `${o.name}(${o.group})`).join(", ")}`);

// ── 바닥 — 반복되는 면은 따로(CSS background-repeat). 128px 그림 = 2×2 칸(월드 96px) ──
const surface = (name, img, licensed = false) => {
  const png = replacement("tiles", name);
  const out = png ? resize(png, img.w, img.h) : img;
  if (png) replaced += 1;
  const cv = new Canvas(out.w, out.h); cv.d.set(out.data);
  return emit(name, cv.png(), licensed);
};
const floorKeys = Object.keys(FLOORS);
for (const key of floorKeys) surface(`floor-${key}`, importFloor(ROOT, key));
const ref = hasRoomRef(ROOT) ? importRoomRef(ROOT) : null;
if (ref) {
  floorKeys.push("slate");
  surface("floor-slate", ref.floor);
  surface("hall", ref.floor);
  surface("carpet", ref.floor);
} else {
  surface("hall", importFloor(ROOT, "concrete"));
  surface("carpet", importFloor(ROOT, "speckle"));
}

// ── 벽 — A4 오토타일을 스타일별 변형 시트로 ──
const walls = importA4Walls(ROOT);
for (const [key, st] of Object.entries(walls.styles)) surface(`wall-${key}`, st.img, true); // 구입 팩의 A4 오토타일

// 옛 이름·옛 해시의 파일은 지운다 (사람 시트 people.*.png 는 characters-import.mjs 의 몫)
const OURS = /^(atlas|atlas-[a-z]+|floor-[A-Za-z]+|hall|carpet|walls|wall-[a-z0-9]+|wall-h|wall-hb|wall-v|wall-vl|wall-vr|corner-[a-z]+|pillar-[lr])(\.[0-9a-f]+)?\.png$/;
for (const [dir, prefix] of [[PUB, "/office/"], [LIC, "/office/licensed/"]]) {
  const keep = new Set([...written.values()].filter((u) => u.startsWith(prefix) && !u.slice(prefix.length).includes("/")).map((u) => u.slice(prefix.length)));
  for (const f of readdirSync(dir)) if (OURS.test(f) && !keep.has(f)) unlinkSync(`${dir}/${f}`);
}

// ── 좌표표 ────────────────────────────────────────────────────
const floorSrcEntries = floorKeys.map((k) => `  ${k}: ${JSON.stringify(written.get(`floor-${k}`))},`).join("\n");
const entries = placed.map((s) => `  "${s.name}": { x: ${s.px}, y: ${s.py}, w: ${s.img.w}, h: ${s.img.h}, sheet: ${JSON.stringify(s.group)} },`).join("\n");
const sheetEntries = Object.entries(sheets).map(([g, sh]) => `  ${g}: { src: ${JSON.stringify(sh.url)}, w: ${sh.w}, h: ${sh.h} },`).join("\n");
const feet = placed.map((s) => `  "${s.name}": { w: ${s.foot.w}, h: ${s.foot.h}, rise: ${s.rise}, wall: ${s.wall}, walk: ${s.walk}, vis: ${s.vis} },`).join("\n");
const meta = placed.map((s) => `  "${s.name}": { label: ${JSON.stringify(s.label)}, group: ${JSON.stringify(s.group)} },`).join("\n");
const wallStyleEntries = WALL_STYLES.map((st) => `  ${st.key}: { src: ${JSON.stringify(written.get(`wall-${st.key}`))}, label: ${JSON.stringify(st.label)}, rows: ${walls.styles[st.key].rows}, w: ${walls.styles[st.key].img.w}, h: ${walls.styles[st.key].img.h} },`).join("\n");
const wallVars = WALL_STYLES.map((st) => `  "--office-wall-${st.key}": \`url(\${WALL_STYLES.${st.key}.src})\`,`).join("\n");
const ts = `// 생성됨 — node tools/tileset/build.mjs. 손으로 고치지 말 것.
/** 소품·벽 = 구입한 팩 Office-3(비공개 서브모듈 office/licensed, 48px 칸). 좌표는 **월드 px**(아틀라스 배율 1 — 48px 가 한 칸). 바닥은 128px 그림이 2×2 칸. */
/** 소품 시트 — 묶음마다 한 장. 스프라이트의 sheet 가 어느 장인지 말한다. */
export const ATLAS: Record<string, { src: string; w: number; h: number }> = {
${sheetEntries}
};
export const CARPET_SRC = ${JSON.stringify(written.get("carpet"))};
export const HALL_SRC = ${JSON.stringify(written.get("hall"))};
/** 바닥 종류 — 장면이 고른다. */
export const FLOOR_KEYS = ${JSON.stringify(floorKeys)} as const;
export type FloorKey = (typeof FLOOR_KEYS)[number];
export const FLOOR_SRC: Record<FloorKey, string> = {
${floorSrcEntries}
};
export const floorSrc = (key: FloorKey) => FLOOR_SRC[key];
export const MAT_SRC = FLOOR_SRC.mat;
/** 바닥 한 장이 덮는 월드 px — 2×2 칸 */
export const FLOOR_PATCH = ${2 * T};
/** 벽 — 스타일별 오토타일 변형 시트(48px 칸 + 1px 여백, 한 줄 ${walls.cols}칸). 앞 ${walls.topCount}장이 윗면(8방향 마스크 → WALL_TOP_VARIANT), 그 다음 ${walls.faceCount}장이 앞면
 *  (좌·상·우·하 이웃 비트 1·2·4·8 → WALL_FACE_VARIANT). 첫 스타일이 기본. */
export const WALL_STYLES = {
${wallStyleEntries}
} as const;
export type WallStyleKey = keyof typeof WALL_STYLES;
export const WALL_STYLE_KEYS = Object.keys(WALL_STYLES) as WallStyleKey[];
export const WALL_DEFAULT: WallStyleKey = ${JSON.stringify(WALL_STYLES[0].key)};
export const WALL_TILE = ${walls.tile};
export const WALL_SHEET_COLS = ${walls.cols};
/** 시트에서 칸 사이 간격과 여백(px) — 칸 둘레 1px 는 가장자리를 늘린 것(텍스처 블리딩 막이). 칸 n 은 (n % cols) * pitch + gutter 에 있다. */
export const WALL_PITCH = ${walls.pitch};
export const WALL_GUTTER = ${walls.gutter};
export const WALL_TOP_VARIANT: readonly number[] = ${JSON.stringify(walls.topIndex)};
export const WALL_TOP_COUNT = ${walls.topCount};
export const WALL_FACE_VARIANT: readonly number[] = ${JSON.stringify(Array.from({ length: walls.faceCount }, (_, i) => walls.topCount + i))};
/** CSS 가 쓰는 그림 주소 — 사무실·편집기의 뿌리 요소에 인라인 변수로 얹는다. globals.css 는 이 변수만 안다. */
export const OFFICE_ASSET_VARS = {
  "--office-carpet": \`url(\${CARPET_SRC})\`,
  "--office-hall": \`url(\${HALL_SRC})\`,
  "--office-mat": \`url(\${MAT_SRC})\`,
${wallVars}
} as Record<string, string>;
export interface Sprite { x: number; y: number; w: number; h: number; sheet: string }

export const S = {
${entries}
} as const;

export type SpriteName = keyof typeof S;

/** 발자국(칸) — w×h 가 바닥을 차지하고 rise 칸만큼 위로 솟는다. wall 은 벽 앞면에 거는 것, walk 는 밟고 다니는 것. vis 는 그림의 보이는 높이(px). */
export const FOOT: Record<SpriteName, { w: number; h: number; rise: number; wall: boolean; walk: boolean; vis: number }> = {
${feet}
};

/** 이름·묶음 — 편집기 팔레트가 쓴다. */
export const PROP_META: Record<SpriteName, { label: string; group: string }> = {
${meta}
};
export const PROP_GROUP_LABELS: Record<string, string> = ${JSON.stringify(GROUPS)};
/** 옛 팩의 이름 → 이 팩의 이름 (관리자 프리셋 이전용) */
export const LEGACY_PROP_NAMES: Record<string, string> = ${JSON.stringify(LEGACY_NAMES)};
`;
writeFileSync(`${ROOT}/apps/web/components/office/atlas.ts`, ts);
console.log(`소품 시트 ${Object.keys(sheets).length}장(${Object.entries(sheets).map(([g, sh]) => `${g} ${sh.h / T}줄`).join(" · ")}), 소품 ${placed.length}개 · 바닥 ${floorKeys.length}장 · 벽 ${WALL_STYLES.length}스타일(윗면 ${walls.topCount}·앞면 ${walls.faceCount}변형)${replaced ? ` · 바꿔 끼움 ${replaced}` : ""}`);

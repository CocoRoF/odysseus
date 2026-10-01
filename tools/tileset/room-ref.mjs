#!/usr/bin/env node
/** 방 참고 그림 한 장 → 벽·바닥 타일 열 장. 그리고 그 열 장으로 원본을 **다시 조립해 대조**한다.
 *
 *   node tools/tileset/room-ref.mjs images/office_room_ref.png [outDir]
 *
 * 참고 그림은 "빈 방 하나" — 바깥 어두운 배경, 사방 벽(레일), 위 벽에는 앞면(판) 띠, 안에 격자 바닥.
 * 사람이 좌표를 적지 않는다. 그림에서 직접 잰다:
 *   1. 배경색과 다른 픽셀의 상자 = 방의 바깥 테두리.
 *   2. 위·아래·왼쪽·오른쪽에서 안쪽으로 들어가며 색이 바뀌는 자리(띠 경계)를 찾는다 → 벽 두께.
 *   3. 바닥 영역의 밝기 프로파일을 자기상관해 격자 주기(타일 한 칸)를 찾는다.
 *   4. 위 벽 앞면 띠의 판 주기(세로 이음새)도 같은 방법으로 찾는다.
 * 그러고 나서 조각들을 타일링해 원본 크기로 다시 조립하고, 원본과 픽셀 차이를 잰다. 차이가 크면 자른 것이
 * 틀린 것이다 — 이 대조가 "강력한 타일 만들기"의 뜻이다.
 *
 * 산출(outDir): wall-top.png(캡+앞면+밑선, 판 한 주기 폭) · wall-top-cap.png · wall-face.png(=벽에 붙는 타일) ·
 *   wall-top-left/right.png · wall-left/right.png(레일, 세로 한 주기) · wall-bottom.png · wall-bottom-left/right.png ·
 *   pillar-left/right.png(기둥 발 — 아래 모서리 조각에서 상자만; 옆 벽이 곧게 지나가는 벽에 닿는 T자 자리에 얹는다) ·
 *   tile-floor.png(한 칸) · tile-floor-2x2.png · tile-wall.png(벽 바로 아래 바닥 줄이 다르면) · recomposed.png · diff.png ·
 *   pieces.json(좌표·주기·오차)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { decodePng } from "./decode.mjs";
import { Canvas } from "./png.mjs";

// ── 픽셀 도구 ──────────────────────────────────────────────────
const at = (img, x, y) => { const o = (y * img.w + x) * 4; return [img.data[o], img.data[o + 1], img.data[o + 2]]; };
const dist = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
const lum = (c) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
function crop(img, x0, y0, w, h) {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y += 1) data.set(img.data.subarray(((y0 + y) * img.w + x0) * 4, ((y0 + y) * img.w + x0 + w) * 4), y * w * 4);
  return { w, h, data };
}
function meanColor(img, x0, y0, w, h) {
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = y0; y < y0 + h; y += 1) for (let x = x0; x < x0 + w; x += 1) { const c = at(img, x, y); r += c[0]; g += c[1]; b += c[2]; n += 1; }
  return [r / n, g / n, b / n];
}
function savePng(path, img) { const cv = new Canvas(img.w, img.h); cv.d.set(img.data); writeFileSync(path, cv.png()); }

// ── 1. 바깥 테두리 ──────────────────────────────────────────────
export function outerBox(img, tol = 40) {
  // 배경색 = 네 귀퉁이 2px 의 평균
  const bg = meanColor(img, 0, 0, 2, 2).map((v, i) => (v + meanColor(img, img.w - 2, img.h - 2, 2, 2)[i]) / 2);
  let x0 = img.w, y0 = img.h, x1 = -1, y1 = -1;
  for (let y = 0; y < img.h; y += 1) for (let x = 0; x < img.w; x += 1) {
    if (dist(at(img, x, y), bg) <= tol) continue;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return { x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1, bg };
}

// ── 2. 띠 경계 ──────────────────────────────────────────────────
/** 한 축을 따라 평균색이 바뀌는 자리들. `profile[i]` 는 i 번째 줄(또는 열)의 평균색.
 *  격자선처럼 **얇은 선**(minLen 미만)은 띠를 끊지 않는다 — 앞을 보아 곧 제 색으로 돌아오면 같은 띠다.
 *  그래도 남는 짧은 띠는 색이 더 가까운 이웃에 붙인다. */
function bands(profile, tol = 12, minLen = 4) {
  const n = profile.length;
  const out = [];
  let start = 0, ref = profile[0];
  let i = 1;
  while (i < n) {
    if (dist(profile[i], ref) > tol) {
      let back = -1;
      for (let j = i + 1; j <= Math.min(n - 1, i + minLen); j += 1) if (dist(profile[j], ref) <= tol) { back = j; break; }
      if (back >= 0) { i = back; continue; }
      out.push({ from: start, to: i - 1 });
      start = i; ref = profile[i];
    }
    i += 1;
  }
  out.push({ from: start, to: n - 1 });
  // 짧은 띠는 이웃에 붙인다
  const color = (b) => meanOf(profile.slice(b.from, b.to + 1));
  for (let k = 0; k < out.length; k += 1) {
    const b = out[k];
    if (b.to - b.from + 1 >= minLen || out.length === 1) continue;
    const prev = out[k - 1], next = out[k + 1];
    const c = color(b);
    const toPrev = prev ? dist(c, color(prev)) : Infinity, toNext = next ? dist(c, color(next)) : Infinity;
    if (toPrev <= toNext && prev) { prev.to = b.to; out.splice(k, 1); k -= 1; }
    else if (next) { next.from = b.from; out.splice(k, 1); k -= 1; }
  }
  return out.map((b) => ({ ...b, len: b.to - b.from + 1, color: color(b) }));
}
function meanOf(cols) {
  const s = [0, 0, 0];
  for (const c of cols) { s[0] += c[0]; s[1] += c[1]; s[2] += c[2]; }
  return s.map((v) => v / (cols.length || 1));
}
function rowProfile(img, box, x0, x1) {
  const out = [];
  for (let y = box.y0; y <= box.y1; y += 1) out.push(meanColor(img, x0, y, x1 - x0 + 1, 1));
  return out;
}
function colProfile(img, box, y0, y1) {
  const out = [];
  for (let x = box.x0; x <= box.x1; x += 1) out.push(meanColor(img, x, y0, 1, y1 - y0 + 1));
  return out;
}

// ── 3. 주기 ─────────────────────────────────────────────────────
/** 밝기 프로파일의 주기(격자 한 칸). 격자선은 어두운 골이므로 **골의 간격**으로 잰다 — 자기상관은 골이 드문
 *  프로파일에서 짧은 지연에도 점수가 높아 틀린다. 골이 셋보다 적으면 자기상관으로 물러선다. 없으면 null. */
export function period(values, minLag = 8, maxLag = null) {
  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const std = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / n) || 1;
  const dips = [];
  for (let i = 1; i < n - 1; i += 1) {
    if (values[i] > mean - 0.8 * std) continue;
    if (values[i] <= values[i - 1] && values[i] < values[i + 1]) {
      if (dips.length && i - dips[dips.length - 1] < minLag) continue; // 두꺼운 선은 한 골로
      dips.push(i);
    }
  }
  if (dips.length >= 3) {
    const gaps = dips.slice(1).map((d, i) => d - dips[i]).sort((a, b) => a - b);
    const med = gaps[Math.floor(gaps.length / 2)];
    const agree = gaps.filter((g) => Math.abs(g - med) <= 2).length / gaps.length;
    if (med >= minLag && agree >= 0.6) return med;
  }
  maxLag = Math.min(maxLag ?? Math.floor(n / 3), Math.floor(n / 2));
  const v = values.map((x) => x - mean);
  const denom = v.reduce((a, b) => a + b * b, 0) || 1;
  let best = null, bestScore = 0;
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let s = 0;
    for (let i = 0; i + lag < n; i += 1) s += v[i] * v[i + lag];
    const score = s / denom;
    if (score > bestScore) { bestScore = score; best = lag; }
  }
  return best !== null && bestScore >= 0.3 ? best : null;
}

// ── 본체 ────────────────────────────────────────────────────────
/** 프로파일이 기준값에서 벗어난 구간의 길이(앞에서부터) — 모서리 그림자가 얼마나 뻗는가 */
function fadeLen(values, ref, tol) {
  let n = 0;
  for (let i = 0; i < values.length; i += 1) { if (Math.abs(values[i] - ref) > tol) n = i + 1; else if (i > n + 8) break; }
  return n;
}
const median = (arr) => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

/** 모서리 조각의 이음 쪽 끝 몇 px 를 이웃 반복 조각의 평평한 값(줄별 중앙값)으로 서서히 맞춘다.
 *  그림자 꼬리는 허용치 안에서 끝나지만 그 몇 단계가 이음새에서 세로 줄로 보인다 — 반복 조각은 원본에서 그대로 떼므로 여기서만 손본다. */
function feather(piece, neighbor, side, len) {
  const n = Math.min(len, piece.w);
  if (n <= 0 || !neighbor || neighbor.h !== piece.h) return piece;
  const target = [];
  for (let y = 0; y < piece.h; y += 1) {
    const ch = [[], [], []];
    for (let x = 0; x < neighbor.w; x += 1) { const o = (y * neighbor.w + x) * 4; ch[0].push(neighbor.data[o]); ch[1].push(neighbor.data[o + 1]); ch[2].push(neighbor.data[o + 2]); }
    target.push(ch.map(median));
  }
  const out = { w: piece.w, h: piece.h, data: piece.data.slice() };
  for (let i = 0; i < n; i += 1) {
    const t = (i + 1) / (n + 1);
    const x = side === "right" ? piece.w - n + i : n - 1 - i;
    for (let y = 0; y < piece.h; y += 1) { const o = (y * piece.w + x) * 4; for (let c = 0; c < 3; c += 1) out.data[o + c] = Math.round(piece.data[o + c] + (target[y][c] - piece.data[o + c]) * t); }
  }
  return out;
}
const FEATHER = 32;

export function analyze(img) {
  const box = outerBox(img);
  const midX0 = box.x0 + Math.floor(box.w * 0.3), midX1 = box.x0 + Math.floor(box.w * 0.7);
  const midY0 = box.y0 + Math.floor(box.h * 0.3), midY1 = box.y0 + Math.floor(box.h * 0.7);
  const rows = bands(rowProfile(img, box, midX0, midX1));
  const cols = bands(colProfile(img, box, midY0, midY1));
  // 바닥 = 가장 긴 띠. 그 위의 띠들이 위 벽, 아래가 아래 벽.
  const floorRow = rows.reduce((a, b) => (b.len > a.len ? b : a));
  const floorCol = cols.reduce((a, b) => (b.len > a.len ? b : a));
  const floor = { x0: box.x0 + floorCol.from, x1: box.x0 + floorCol.to, y0: box.y0 + floorRow.from, y1: box.y0 + floorRow.to };
  // 바닥 가장자리 다듬기 — 벽에 붙은 한두 줄은 벽의 그림자라 벽 조각에 넣는다(바닥 색과 다르면 벽 쪽으로).
  const floorColor = meanColor(img, floor.x0 + Math.floor((floor.x1 - floor.x0) * 0.4), floor.y0 + Math.floor((floor.y1 - floor.y0) * 0.4), 16, 16);
  const edgeIs = (x0, y0, w, h) => dist(meanColor(img, x0, y0, w, h), floorColor) > 6;
  // 한 줄짜리 격자선은 바닥이다 — 두 줄이 이어서 다를 때만 벽 쪽으로 넘긴다
  while (floor.x1 - floor.x0 > 64 && edgeIs(floor.x0, midY0, 1, midY1 - midY0) && edgeIs(floor.x0 + 1, midY0, 1, midY1 - midY0)) floor.x0 += 1;
  while (floor.x1 - floor.x0 > 64 && edgeIs(floor.x1, midY0, 1, midY1 - midY0) && edgeIs(floor.x1 - 1, midY0, 1, midY1 - midY0)) floor.x1 -= 1;
  while (floor.y1 - floor.y0 > 64 && edgeIs(midX0, floor.y0, midX1 - midX0, 1) && edgeIs(midX0, floor.y0 + 1, midX1 - midX0, 1)) floor.y0 += 1;
  while (floor.y1 - floor.y0 > 64 && edgeIs(midX0, floor.y1, midX1 - midX0, 1) && edgeIs(midX0, floor.y1 - 1, midX1 - midX0, 1)) floor.y1 -= 1;
  const topBands = rows.filter((b) => b.to < floorRow.from).map((b) => ({ y0: box.y0 + b.from, y1: box.y0 + b.to, color: b.color.map(Math.round) }));
  const bottomBands = rows.filter((b) => b.from > floorRow.to).map((b) => ({ y0: box.y0 + b.from, y1: box.y0 + b.to, color: b.color.map(Math.round) }));
  const leftBands = cols.filter((b) => b.to < floorCol.from).map((b) => ({ x0: box.x0 + b.from, x1: box.x0 + b.to, color: b.color.map(Math.round) }));
  const rightBands = cols.filter((b) => b.from > floorCol.to).map((b) => ({ x0: box.x0 + b.from, x1: box.x0 + b.to, color: b.color.map(Math.round) }));

  // 바닥 격자 주기 — 바닥 안쪽 프로파일. 평평한 바닥이면 null (그때는 타일 크기를 정해 자른다).
  const fx0 = floor.x0 + 8, fx1 = floor.x1 - 8, fy0 = floor.y0 + 8, fy1 = floor.y1 - 8;
  const colLum = []; for (let x = fx0; x <= fx1; x += 1) colLum.push(lum(meanColor(img, x, fy0, 1, fy1 - fy0 + 1)));
  const rowLum = []; for (let y = fy0; y <= fy1; y += 1) rowLum.push(lum(meanColor(img, fx0, y, fx1 - fx0 + 1, 1)));
  const spread = Math.max(...colLum) - Math.min(...colLum);
  const px = spread > 4 ? period(colLum) : null, py = spread > 4 ? period(rowLum) : null;
  const tile = px && py ? Math.round((px + py) / 2) : px || py || null;
  let phaseX = 0, phaseY = 0;
  if (tile) {
    let dark = Infinity; for (let i = 0; i < tile; i += 1) if (colLum[i] < dark) { dark = colLum[i]; phaseX = i; }
    dark = Infinity; for (let i = 0; i < tile; i += 1) if (rowLum[i] < dark) { dark = rowLum[i]; phaseY = i; }
    phaseX = (phaseX + 8) % tile; phaseY = (phaseY + 8) % tile;
  }
  // 위 벽 앞면 — 위 띠 가운데 가장 두꺼운 것. 판 이음새 주기와 양 끝 그림자 길이.
  const face = topBands.length ? topBands.reduce((a, b) => (b.y1 - b.y0 > a.y1 - a.y0 ? b : a)) : null;
  let panel = null, fadeTL = 0, fadeTR = 0;
  if (face) {
    const fl = []; for (let x = floor.x0; x <= floor.x1; x += 1) fl.push(lum(meanColor(img, x, face.y0, 1, face.y1 - face.y0 + 1)));
    const mid = median(fl.slice(Math.floor(fl.length * 0.3), Math.floor(fl.length * 0.7)));
    // 그림자가 거의 끝난 자리까지 모서리 조각에 넣는다 — 여기서 끊으면 이어 붙인 자리에 세로 단이 보인다
    fadeTL = fadeLen(fl, mid, 2.5);
    fadeTR = fadeLen([...fl].reverse(), mid, 2.5);
    const inner = fl.slice(fadeTL, fl.length - fadeTR);
    panel = inner.length > 64 ? period(inner, 24) : null;
  }
  // 옆 벽 — 안쪽 띠(바닥에 붙은 것)의 세로 프로파일에서 위·아래 그림자 길이
  const sideFade = (x0, x1) => {
    const pr = []; for (let y = floor.y0; y <= floor.y1; y += 1) pr.push(lum(meanColor(img, x0, y, x1 - x0 + 1, 1)));
    const mid = median(pr.slice(Math.floor(pr.length * 0.3), Math.floor(pr.length * 0.7)));
    return { top: fadeLen(pr, mid, 6), bottom: fadeLen([...pr].reverse(), mid, 6) };
  };
  const leftFade = sideFade(box.x0, floor.x0 - 1), rightFade = sideFade(floor.x1 + 1, box.x1);
  // 아래 벽 — 바닥 쪽 첫 띠(걸레받이/킥 밴드)의 눈금 주기와 양 끝 그림자
  let kick = null;
  if (bottomBands.length) {
    const b = bottomBands[0];
    const kl = []; for (let x = floor.x0; x <= floor.x1; x += 1) kl.push(lum(meanColor(img, x, b.y0, 1, b.y1 - b.y0 + 1)));
    const mid = median(kl.slice(Math.floor(kl.length * 0.3), Math.floor(kl.length * 0.7)));
    const fl = fadeLen(kl, mid, 6), fr = fadeLen([...kl].reverse(), mid, 6);
    const inner = kl.slice(fl, kl.length - fr);
    const per = inner.length > 64 ? period(inner, 16) : null;
    // 눈금 위상 — 안쪽 구간의 첫 골
    let phase = 0;
    if (per) { const mean = inner.reduce((a, c) => a + c, 0) / inner.length; for (let i = 0; i < inner.length; i += 1) if (inner[i] < mean - 3) { phase = i; break; } }
    kick = { y0: b.y0, y1: b.y1, fadeL: fl, fadeR: fr, period: per, phase };
  }
  // 바닥 쪽 벽 아래 첫 줄이 다른가 (벽에 붙는 타일)
  let wallRow = null;
  if (tile) {
    const a = meanColor(img, fx0, floor.y0, fx1 - fx0 + 1, Math.min(tile, 8));
    const b = meanColor(img, fx0, floor.y0 + tile * 2, fx1 - fx0 + 1, Math.min(tile, 8));
    if (dist(a, b) > 12) wallRow = { y0: floor.y0, y1: floor.y0 + tile - 1 };
  }
  return { box, floor, topBands, bottomBands, leftBands, rightBands, tile, phaseX, phaseY, face, panel, fadeTL, fadeTR, leftFade, rightFade, kick, wallRow };
}

/** 자른다. 벽 조각은 그림자가 끝난 **평평한 구간**에서 떼고, 모서리 조각은 그림자까지 품는다 — 그래야 이어 붙일 때 이음새가 없다. */
export function slice(img, a) {
  const { box, floor, tile } = a;
  const topH = floor.y0 - box.y0, bottomH = box.y1 - floor.y1, leftW = floor.x0 - box.x0, rightW = box.x1 - floor.x1;
  const flatW = floor.x1 - floor.x0 + 1 - a.fadeTL - a.fadeTR;
  const panelW = a.panel ?? Math.min(128, flatW);
  const pieces = {};
  const tx = floor.x0 + a.fadeTL;
  pieces["wall-top"] = crop(img, tx, box.y0, Math.min(panelW, flatW), topH);
  if (a.face) {
    pieces["wall-top-cap"] = crop(img, tx, box.y0, Math.min(panelW, flatW), a.face.y0 - box.y0);
    pieces["wall-face"] = crop(img, tx, a.face.y0, Math.min(panelW, flatW), floor.y0 - a.face.y0);
  }
  pieces["wall-top-left"] = feather(crop(img, box.x0, box.y0, leftW + a.fadeTL, topH), pieces["wall-top"], "right", Math.min(FEATHER, a.fadeTL));
  pieces["wall-top-right"] = feather(crop(img, floor.x1 + 1 - a.fadeTR, box.y0, rightW + a.fadeTR, topH), pieces["wall-top"], "left", Math.min(FEATHER, a.fadeTR));
  const railPeriod = tile ?? 64;
  const sy = floor.y0 + Math.max(a.leftFade.top, a.rightFade.top);
  pieces["wall-left"] = crop(img, box.x0, sy, leftW, Math.min(railPeriod, floor.y1 - sy + 1));
  pieces["wall-right"] = crop(img, floor.x1 + 1, sy, rightW, Math.min(railPeriod, floor.y1 - sy + 1));
  const kf = a.kick ? { l: a.kick.fadeL, r: a.kick.fadeR } : { l: 0, r: 0 };
  const bw = a.kick?.period ? a.kick.period * 2 : Math.min(128, floor.x1 - floor.x0 + 1 - kf.l - kf.r);
  pieces["wall-bottom"] = crop(img, floor.x0 + kf.l + (a.kick?.phase ?? 0), floor.y1 + 1, Math.min(bw, floor.x1 - floor.x0 + 1 - kf.l - kf.r), bottomH);
  pieces["wall-bottom-left"] = feather(crop(img, box.x0, floor.y1 + 1, leftW + kf.l, bottomH), pieces["wall-bottom"], "right", Math.min(FEATHER, kf.l));
  pieces["wall-bottom-right"] = feather(crop(img, floor.x1 + 1 - kf.r, floor.y1 + 1, rightW + kf.r, bottomH), pieces["wall-bottom"], "left", Math.min(FEATHER, kf.r));
  // 기둥 발 — 아래 모서리 조각에서 상자(어두운 테두리까지)만 잘라 낸다. 옆 벽이 곧게 지나가는 벽(북쪽 방의 문 벽)에
  // 닿는 T자 자리에는 모서리 조각(캡 상자+아래로 뻗는 띠)이 아니라 이 상자만 얹는다.
  const pillar = (piece, bw, right) => {
    const lum = (x, y) => { const o = (y * piece.w + x) * 4; return piece.data[o] * 0.3 + piece.data[o + 1] * 0.59 + piece.data[o + 2] * 0.11; };
    const cx = right ? piece.w - Math.ceil(bw / 2) : Math.floor(bw / 2);
    let h = piece.h;
    for (let y = 5; y < piece.h; y += 1) if (lum(cx, y) < 120) { h = Math.min(piece.h, y + 2); break; }
    // 상자 가운데에서 벽 쪽으로 나가다 어두운 테두리를 만나는 자리가 상자의 끝 — 그 너머 킥 밴드의 밝은 꼬리에 속지 않는다
    const cy = Math.floor(h / 2);
    if (right) {
      let x0 = piece.w - bw;
      for (let x = cx; x >= piece.w - bw; x -= 1) if (lum(x, cy) < 120) { x0 = Math.max(piece.w - bw, x - 1); break; }
      return crop(piece, x0, 0, piece.w - x0, h);
    }
    let w = bw;
    for (let x = cx; x < bw; x += 1) if (lum(x, cy) < 120) { w = Math.min(bw, x + 2); break; }
    return crop(piece, 0, 0, w, h);
  };
  pieces["pillar-left"] = pillar(pieces["wall-bottom-left"], leftW, false);
  pieces["pillar-right"] = pillar(pieces["wall-bottom-right"], rightW, true);
  // 옆 벽의 위·아래 그림자는 모서리 조각의 세로 확장으로 품는다
  pieces["wall-left-top"] = crop(img, box.x0, floor.y0, leftW, Math.max(a.leftFade.top, 1));
  pieces["wall-right-top"] = crop(img, floor.x1 + 1, floor.y0, rightW, Math.max(a.rightFade.top, 1));
  pieces["wall-left-bottom"] = crop(img, box.x0, floor.y1 + 1 - Math.max(a.leftFade.bottom, 1), leftW, Math.max(a.leftFade.bottom, 1));
  pieces["wall-right-bottom"] = crop(img, floor.x1 + 1, floor.y1 + 1 - Math.max(a.rightFade.bottom, 1), rightW, Math.max(a.rightFade.bottom, 1));
  const t = tile ?? 64;
  const cx = tile ? floor.x0 + a.phaseX : floor.x0 + Math.floor((floor.x1 - floor.x0 + 1 - t * 2) / 2);
  const cy = tile ? floor.y0 + a.phaseY : floor.y0 + Math.floor((floor.y1 - floor.y0 + 1 - t * 2) / 2);
  pieces["tile-floor"] = crop(img, cx, cy, t, t);
  pieces["tile-floor-2x2"] = crop(img, cx, cy, t * 2, t * 2);
  if (a.wallRow) pieces["tile-wall"] = crop(img, cx, floor.y0, t, t);
  if (a.kick) pieces["tile-kick"] = crop(img, floor.x0 + kf.l + (a.kick.phase ?? 0), a.kick.y0, Math.min(bw, floor.x1 - floor.x0 + 1 - kf.l - kf.r), a.kick.y1 - a.kick.y0 + 1);
  return pieces;
}

/** 조각을 타일링해 원본 크기로 다시 조립한다 */
export function recompose(a, pieces, W, H) {
  const { box, floor } = a;
  const cv = new Canvas(W, H);
  cv.rect(0, 0, W, H, box.bg.map(Math.round));
  const blit = (img, x0, y0) => { for (let y = 0; y < img.h; y += 1) for (let x = 0; x < img.w; x += 1) { const o = (y * img.w + x) * 4; const px = x0 + x, py = y0 + y; if (px < 0 || py < 0 || px >= W || py >= H) continue; cv.px(px, py, [img.data[o], img.data[o + 1], img.data[o + 2]], 255); } };
  const tileX = (img, x0, x1, y) => { for (let x = x0; x <= x1; x += img.w) blit(crop(img, 0, 0, Math.min(img.w, x1 - x + 1), img.h), x, y); };
  const tileY = (img, y0, y1, x) => { for (let y = y0; y <= y1; y += img.h) blit(crop(img, 0, 0, img.w, Math.min(img.h, y1 - y + 1)), x, y); };
  // 바닥
  if (pieces["tile-floor"]) {
    const t = pieces["tile-floor"];
    const ox = a.tile ? floor.x0 - t.w + a.phaseX : floor.x0, oy = a.tile ? floor.y0 - t.h + a.phaseY : floor.y0;
    for (let y = oy; y <= floor.y1; y += t.h) for (let x = ox; x <= floor.x1; x += t.w) {
      const cx0 = Math.max(x, floor.x0), cy0 = Math.max(y, floor.y0), cx1 = Math.min(x + t.w - 1, floor.x1), cy1 = Math.min(y + t.h - 1, floor.y1);
      if (cx1 < cx0 || cy1 < cy0) continue;
      blit(crop(t, cx0 - x, cy0 - y, cx1 - cx0 + 1, cy1 - cy0 + 1), cx0, cy0);
    }
    if (pieces["tile-wall"]) tileX(pieces["tile-wall"], floor.x0, floor.x1, floor.y0);
  }
  const kf = a.kick ? { l: a.kick.fadeL, r: a.kick.fadeR, ph: a.kick.phase ?? 0 } : { l: 0, r: 0, ph: 0 };
  tileX(pieces["wall-top"], floor.x0 + a.fadeTL, floor.x1 - a.fadeTR, box.y0);
  // 아래 벽: 위상만큼 앞을 조각의 끝부분으로 채운다
  const bp = pieces["wall-bottom"];
  if (kf.ph > 0) blit(crop(bp, bp.w - kf.ph, 0, kf.ph, bp.h), floor.x0 + kf.l, floor.y1 + 1);
  tileX(bp, floor.x0 + kf.l + kf.ph, floor.x1 - kf.r, floor.y1 + 1);
  tileY(pieces["wall-left"], floor.y0, floor.y1, box.x0);
  tileY(pieces["wall-right"], floor.y0, floor.y1, floor.x1 + 1);
  blit(pieces["wall-left-top"], box.x0, floor.y0);
  blit(pieces["wall-right-top"], floor.x1 + 1, floor.y0);
  blit(pieces["wall-left-bottom"], box.x0, floor.y1 + 1 - pieces["wall-left-bottom"].h);
  blit(pieces["wall-right-bottom"], floor.x1 + 1, floor.y1 + 1 - pieces["wall-right-bottom"].h);
  blit(pieces["wall-top-left"], box.x0, box.y0);
  blit(pieces["wall-top-right"], floor.x1 + 1 - a.fadeTR, box.y0);
  blit(pieces["wall-bottom-left"], box.x0, floor.y1 + 1);
  blit(pieces["wall-bottom-right"], floor.x1 + 1 - kf.r, floor.y1 + 1);
  return { w: W, h: H, data: cv.d };
}

/** 원본과 조립본의 차이 — 방 상자 안에서만 */
export function compare(orig, rebuilt, box, tol = 20) {
  let off = 0, sum = 0, n = 0;
  const heat = new Canvas(orig.w, orig.h);
  for (let y = box.y0; y <= box.y1; y += 1) for (let x = box.x0; x <= box.x1; x += 1) {
    const d = dist(at(orig, x, y), at(rebuilt, x, y));
    sum += d; n += 1;
    if (d > tol) { off += 1; heat.px(x, y, [255, Math.max(0, 255 - d * 2), 0], 255); } else heat.px(x, y, [20, 20, 24], 255);
  }
  return { offRatio: off / n, meanDiff: sum / n, heat: { w: heat.w, h: heat.h, data: heat.d } };
}

export function run(src, outDir) {
  const img = decodePng(readFileSync(src));
  const a = analyze(img);
  const pieces = slice(img, a);
  const rebuilt = recompose(a, pieces, img.w, img.h);
  const cmp = compare(img, rebuilt, a.box);
  mkdirSync(outDir, { recursive: true });
  for (const [name, p] of Object.entries(pieces)) savePng(join(outDir, `${name}.png`), p);
  savePng(join(outDir, "recomposed.png"), rebuilt);
  savePng(join(outDir, "diff.png"), cmp.heat);
  const report = {
    source: basename(src), size: { w: img.w, h: img.h },
    box: { x0: a.box.x0, y0: a.box.y0, x1: a.box.x1, y1: a.box.y1 }, floor: a.floor,
    topBands: a.topBands, bottomBands: a.bottomBands, leftBands: a.leftBands, rightBands: a.rightBands,
    tile: a.tile, gridPhase: { x: a.phaseX, y: a.phaseY }, face: a.face, panel: a.panel, fade: { topLeft: a.fadeTL, topRight: a.fadeTR, left: a.leftFade, right: a.rightFade }, kick: a.kick, wallRow: a.wallRow,
    pieces: Object.fromEntries(Object.entries(pieces).map(([k, p]) => [k, { w: p.w, h: p.h }])),
    recompose: { offRatio: +cmp.offRatio.toFixed(5), meanDiff: +cmp.meanDiff.toFixed(2) },
  };
  writeFileSync(join(outDir, "pieces.json"), JSON.stringify(report, null, 2));
  return report;
}

if (process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]))) {
  const [src, outDir = "images/office_room_ref"] = process.argv.slice(2);
  if (!src || !existsSync(src)) { console.error("사용법: node tools/tileset/room-ref.mjs <참고 그림.png> [outDir]"); process.exit(2); }
  const r = run(src, outDir);
  console.log(`방 ${r.box.x1 - r.box.x0 + 1}×${r.box.y1 - r.box.y0 + 1} · 바닥 ${r.floor.x1 - r.floor.x0 + 1}×${r.floor.y1 - r.floor.y0 + 1} · 타일 ${r.tile}px · 판 주기 ${r.panel}px`);
  console.log(`위 벽 띠 ${r.topBands.length}개 (${r.topBands.map((b) => b.y1 - b.y0 + 1).join("+")}px) · 아래 ${r.bottomBands.map((b) => b.y1 - b.y0 + 1).join("+")}px · 왼쪽 ${r.leftBands.map((b) => b.x1 - b.x0 + 1).join("+")}px · 오른쪽 ${r.rightBands.map((b) => b.x1 - b.x0 + 1).join("+")}px`);
  console.log(`그림자: 위 왼 ${r.fade.topLeft} 오른 ${r.fade.topRight} · 옆 위 ${r.fade.left.top}/${r.fade.right.top} 아래 ${r.fade.left.bottom}/${r.fade.right.bottom} · 킥 밴드 ${r.kick ? `${r.kick.y1 - r.kick.y0 + 1}px 주기 ${r.kick.period} 위상 ${r.kick.phase}` : "없음"}`);
  console.log(`조각 ${Object.keys(r.pieces).length}개 → ${outDir}/ · 다시 조립 오차: 픽셀 ${(r.recompose.offRatio * 100).toFixed(2)}% 어긋남, 평균 ${r.recompose.meanDiff}`);
}

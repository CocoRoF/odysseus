/**
 * 캐릭터 시트의 계약 — 여덟 장이 제 칸에, 제 크기로, 발을 바닥에 딛고 있는가.
 *
 *   node --test tools/tileset/
 *
 * 브라우저를 띄우지 않고 검사한다. 매니페스트(people.ts)가 말하는 칸 크기로 시트를
 * 실제로 잘라 보고, 칸마다 불투명 픽셀의 상자를 잰다. 스크린샷으로 돌아왔던 결함이
 * 전부 여기서 걸린다:
 *   - 칸이 비어 있다(방향을 바꾸면 사람이 사라진다)
 *   - 발이 칸 바닥에 안 닿는다(앉거나 설 때 떠 있다)
 *   - 프레임마다 몸의 가운데가 다르다(걸을 때 좌우로 흔들린다)
 *   - 매니페스트가 가리키는 파일이 없거나, 옛 시트가 함께 남아 있다
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { decodePng } from "./decode.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const PUB = join(ROOT, "apps/web/public/office");

/** 생성된 매니페스트에서 숫자와 목록만 읽는다 — TS 를 실행하지 않는다. */
function manifest() {
  const src = readFileSync(join(ROOT, "apps/web/lib/people.ts"), "utf8");
  const grab = (re) => {
    const m = re.exec(src);
    assert.ok(m, `people.ts 에서 ${re} 를 찾지 못했다`);
    return m[1];
  };
  const scale = Number(grab(/export const PEOPLE_SCALE = ([\d.]+)/));
  return {
    sheet: grab(/export const PEOPLE_SRC = "\/office\/([^"]+)"/),
    scale,
    footRows: Number(grab(/export const FOOT_ROWS = (\d+)/)),
    resampled: JSON.parse(grab(/export const RESAMPLED: string\[\] = (\[[^\]]*\])/)),
    // 시트 한 칸(시트 px, 정수) — 매니페스트가 직접 말한다. 월드 칸(PERSON_W/H)과는 배율 한 번 차이다.
    cellW: Number(grab(/export const PERSON_SHEET_W = (\d+)/)),
    cellH: Number(grab(/export const PERSON_SHEET_H = (\d+)/)),
    worldW: Number(grab(/export const PERSON_W = ([\d.]+)/)),
    worldH: Number(grab(/export const PERSON_H = ([\d.]+)/)),
    dirs: JSON.parse(grab(/export const DIRS: Dir\[\] = (\[[^\]]*\])/)),
    poses: JSON.parse(grab(/export const POSES: Pose\[\] = (\[[^\]]*\])/)),
    rows: [...src.matchAll(/\{ id: "([^"]+)", name: "[^"]*", gender: "[^"]*", row: (\d+)/g)].map((m) => ({
      id: m[1],
      row: Number(m[2]),
    })),
  };
}

function box(img, x0, y0, w, h, alpha = 8, feetRows = 6) {
  let l = w, t = h, r = -1, b = -1, feetSum = 0, feetN = 0;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (img.data[((y0 + y) * img.w + (x0 + x)) * 4 + 3] <= alpha) continue;
      if (x < l) l = x;
      if (x > r) r = x;
      if (y < t) t = y;
      if (y > b) b = y;
      if (y >= h - feetRows) { feetSum += x; feetN += 1; }
    }
  }
  return r < 0 ? null : { l, t, r, b, w: r - l + 1, h: b - t + 1, cx: (l + r) / 2, feet: feetN ? feetSum / feetN : null };
}

test("people sheet: 매니페스트가 가리키는 시트 하나만 있고 크기가 맞는다", () => {
  const m = manifest();
  assert.ok(existsSync(join(PUB, m.sheet)), `${m.sheet} 이 없다 — characters-import.mjs 를 다시 돌려라`);
  const sheets = readdirSync(PUB).filter((f) => /^people(\.[0-9a-f]+)?\.png$/.test(f));
  assert.deepEqual(sheets, [m.sheet], `옛 시트가 남아 있다: ${sheets.join(", ")}`);
  assert.match(m.sheet, /^people\.[0-9a-f]{10}\.png$/, "시트 이름에 내용 해시가 없다 — 캐시된 옛 그림과 섞인다");

  const img = decodePng(readFileSync(join(PUB, m.sheet)));
  assert.equal(img.w, m.dirs.length * m.poses.length * m.cellW, "시트 너비 ≠ 칸 수 × 칸 너비");
  assert.equal(img.h, m.rows.length * m.cellH, "시트 높이 ≠ 프리셋 수 × 칸 높이");
  // 원본을 그대로 담는다 — 48px 로 줄여 담던 시절로 돌아가면 여기서 멈춘다
  assert.ok(m.cellH >= 96, `칸 높이 ${m.cellH}px — 원본(128px)을 살리려면 96px 이상이어야 한다`);
  // 월드 칸이 정수이고 시트 칸과 배율 하나로 맞물린다(월드 px 가 소수면 화면에서 반 픽셀에 걸린다)
  assert.ok(Number.isInteger(m.worldW) && Number.isInteger(m.worldH), `월드 칸 ${m.worldW}×${m.worldH} 이 정수가 아니다`);
  assert.ok(Math.abs(m.worldW * m.scale - m.cellW) < 1e-6 && Math.abs(m.worldH * m.scale - m.cellH) < 1e-6, "시트 칸 ≠ 월드 칸 × 배율");
  assert.deepEqual(m.dirs, ["down", "left", "right", "up"], "방향 순서는 파일 이름 그대로다");
  assert.deepEqual(m.poses, ["idle", "move"]);
});

test("people sheet: 여덟 칸 전부에 사람이 있고, 발이 바닥에 닿고, 몸이 흔들리지 않는다", () => {
  const m = manifest();
  const img = decodePng(readFileSync(join(PUB, m.sheet)));
  for (const { id, row } of m.rows) {
    const cells = [];
    m.dirs.forEach((d, di) => {
      m.poses.forEach((p, pi) => {
        const col = di * m.poses.length + pi;
        // 발 = 아래 FOOT_ROWS 줄(시트 px). 임포터가 발 가운데를 맞출 때 쓴 자와 **같은 자**다.
        const b = box(img, col * m.cellW, row * m.cellH, m.cellW, m.cellH, 8, m.footRows);
        const where = `${id} ${p}-${d}`;
        assert.ok(b, `${where}: 칸이 비어 있다`);
        // 발은 칸 바닥에. 1px 은 안티에일리어싱 몫이다.
        assert.ok(b.b >= m.cellH - 1 - Math.ceil(m.scale), `${where}: 발이 바닥에서 ${m.cellH - 1 - b.b}px 떠 있다`);
        // 사람이 칸을 거의 채운다 — 반만 차면 잘못 잘린 것이다.
        assert.ok(b.h >= m.cellH * 0.85, `${where}: 키가 ${b.h}px 뿐이다 (칸 ${m.cellH})`);
        // 옆 칸으로 새지 않는다
        assert.ok(b.l >= 0 && b.r < m.cellW, `${where}: 칸 밖으로 나갔다`);
        cells.push({ where, ...b });
      });
    });
    // 너비는 **같은 줄·같은 자세의 가장 넓은 프레임**에 견준다. 칸 너비에 견주면 안 된다 — 칸은
    // 모든 프리셋 중 발에서 가장 멀리 뻗는 프레임(긴 포니테일, 큰 보폭)이 정하므로,
    // 날씬한 프리셋의 정면 프레임이 멀쩡한데도 "얇다"고 잘못 잡는다. 자세도 나눈다 — 옆모습으로 선 날씬한 정장(27번
    // idle-left 24px)을 보폭을 벌린 걷는 프레임(66px)에 견주면 멀쩡한 그림을 틀렸다고 한다(2026-09-14).
    for (const pose of m.poses) {
      const same = cells.filter((c) => c.where.endsWith(` ${pose}-${c.where.split("-").pop()}`) && c.where.includes(` ${pose}-`));
      const widest = Math.max(...same.map((c) => c.w));
      for (const c of same) {
        assert.ok(c.w >= 10 && c.w >= widest * 0.4, `${c.where}: 너비가 ${c.w}px 뿐이다 (같은 줄 ${pose} 최대 ${widest})`);
      }
    }
    // 여덟 장 모두 **발 가운데**가 칸 가운데에 있다. 팔·가방·머리카락으로 상자는
    // 달라져도 서 있는 자리는 같아야 방향을 바꾸거나 걸을 때 옆으로 뛰지 않는다.
    const mid = (m.cellW - 1) / 2;
    for (const c of cells) {
      assert.ok(c.feet !== null, `${c.where}: 아래 여섯 줄에 발이 없다`);
      // 2px(시트) = 1.6 월드 px. 임포터는 정수 픽셀로 옮기므로 0.5px 은 반올림 몫이고, 나머지는 원작자가 그린 보폭 차이다.
      assert.ok(Math.abs(c.feet - mid) <= 2, `${c.where}: 발 가운데가 칸 가운데에서 ${(c.feet - mid).toFixed(1)}px(시트) 벗어났다`);
    }
    // 자세가 실제로 다르다 — idle 과 move 가 같은 그림이면 걷는 것처럼 보이지 않는다.
    m.dirs.forEach((d, di) => {
      const a = cellPixels(img, (di * 2) * m.cellW, row * m.cellH, m.cellW, m.cellH);
      const b = cellPixels(img, (di * 2 + 1) * m.cellW, row * m.cellH, m.cellW, m.cellH);
      assert.notEqual(a, b, `${id} ${d}: idle 과 move 가 같은 그림이다`);
    });
  }
});

function cellPixels(img, x0, y0, w, h) {
  const out = [];
  for (let y = 0; y < h; y += 1) out.push(img.data.subarray(((y0 + y) * img.w + x0) * 4, ((y0 + y) * img.w + x0 + w) * 4).join(","));
  return out.join("|");
}

/** 원본 한 장의 불투명 상자 */
function srcBox(img) {
  let x0 = img.w, y0 = img.h, x1 = -1, y1 = -1;
  for (let y = 0; y < img.h; y += 1) for (let x = 0; x < img.w; x += 1) {
    if (img.data[(y * img.w + x) * 4 + 3] <= 8) continue;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return { x0, y0, x1, y1 };
}

test("people sheet: 원본 픽셀을 그대로 담는다 — 한 픽셀도 다시 샘플하지 않는다", () => {
  // 시트 칸의 그림은 원본 128×128 한 장을 **정수만큼 옮긴 것**이어야 한다. 예전에는 몸을 120px 로 다시 샘플해 담아
  // 도트의 눈·귀걸이가 번졌고, 그 번진 그림이 선택창·사무실 어디서나 뭉개져 보였다(2026-09-13).
  const m = manifest();
  const img = decodePng(readFileSync(join(PUB, m.sheet)));
  const folders = readdirSync(join(ROOT, "images")).filter((d) => /^charactor_\d+/.test(d));
  const folderOf = (id) => folders.find((f) => f.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") === id);
  let checked = 0;
  for (const { id, row } of m.rows) {
    if (m.resampled.includes(id)) continue; // 크기를 보정한 프리셋은 원본과 픽셀이 같을 수 없다
    const folder = folderOf(id);
    assert.ok(folder, `${id} 의 원본 폴더가 없다`);
    m.dirs.forEach((d, di) => {
      m.poses.forEach((p, pi) => {
        const file = join(ROOT, "images", folder, `${p}-${d}.png`);
        if (!existsSync(file)) return; // 이름이 다른 원본(정면·좌·우·뒤 …)은 임포터가 분류한다 — 여기서는 규칙대로 된 것만 본다
        const src = decodePng(readFileSync(file));
        const sb = srcBox(src);
        const cx = (di * m.poses.length + pi) * m.cellW, cy = row * m.cellH;
        const cb = box(img, cx, cy, m.cellW, m.cellH, 8, m.footRows);
        const dx = cx + cb.l - sb.x0, dy = cy + cb.t - sb.y0;
        let bad = 0;
        for (let y = sb.y0; y <= sb.y1; y += 1) for (let x = sb.x0; x <= sb.x1; x += 1) {
          const so = (y * src.w + x) * 4;
          if (src.data[so + 3] <= 8) continue; // 보이지 않는 번짐은 임포터가 칸 밖이면 버린다
          const to = ((y + dy) * img.w + (x + dx)) * 4;
          if (src.data[so] !== img.data[to] || src.data[so + 1] !== img.data[to + 1] || src.data[so + 2] !== img.data[to + 2] || src.data[so + 3] !== img.data[to + 3]) bad += 1;
        }
        assert.equal(bad, 0, `${id} ${p}-${d}: 원본과 다른 픽셀 ${bad}개 — 시트가 원본을 다시 샘플했다`);
        checked += 1;
      });
    });
  }
  assert.ok(checked >= (m.rows.length - m.resampled.length) * 8 * 0.9, `원본과 대조한 칸이 ${checked}개뿐이다`);
});

test("people sheet: 프리셋끼리 몸 크기가 고르다 — 한 사람만 크거나 작지 않다", () => {
  // 원작자마다 캔버스 안에서 사람을 그린 크기가 다를 수 있다. 임포터는 중앙값에서 SIZE_TOLERANCE 넘게 벗어나면 다시
  // 샘플해 맞춘다. 시트에 담긴 결과를 재서, 새 프리셋이 들어와도 한 사람만 거인이나 아이가 되지 않는지 본다.
  const m = manifest();
  const img = decodePng(readFileSync(join(PUB, m.sheet)));
  const heights = m.rows.map(({ id, row }) => {
    let top = Infinity, bottom = -1;
    for (let col = 0; col < m.dirs.length * m.poses.length; col += 1) {
      const b = box(img, col * m.cellW, row * m.cellH, m.cellW, m.cellH, 8, m.footRows);
      if (!b) continue;
      top = Math.min(top, b.t);
      bottom = Math.max(bottom, b.b);
    }
    return { id, h: bottom - top + 1 };
  });
  const sorted = heights.map((x) => x.h).sort((a, b) => a - b);
  const median = sorted[Math.floor((sorted.length - 1) / 2)];
  for (const { id, h } of heights) {
    assert.ok(Math.abs(h / median - 1) <= 0.07, `${id}: 키 ${h}px — 중앙값 ${median}px 과 ${(100 * (h / median - 1)).toFixed(1)}% 다르다`);
  }
});

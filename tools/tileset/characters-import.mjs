#!/usr/bin/env node
/** 사용자가 넣어 둔 캐릭터 프리셋을 게임 자산으로 들인다.
 *
 *   node tools/tileset/characters-import.mjs
 *   node --test tools/tileset/          ← 만든 시트가 계약을 지키는지 검사
 *
 * ## 폴더 규칙 (images/ 아래)
 *
 *   charactor_01/
 *     idle-down.png  idle-left.png  idle-right.png  idle-up.png
 *     move-down.png  move-left.png  move-right.png  move-up.png
 *     portrait.png                ← 대화창에 뜨는 전신 일러스트
 *     preset.json                 ← { "name": "정장 여성", "gender": "female" }
 *
 * **이름이 곧 계약이다.** `<자세>-<방향>.png` 여덟 장이 다 있어야 하고, 없으면 무엇이
 * 빠졌는지 이름을 대며 멈춘다. 정렬 순서로 방향을 추측하지 않는다 — 폴더마다 순서가
 * 달라서(01 은 정면·좌·우·뒤, 02 는 정면·좌·뒤·우) 조용히 좌우가 뒤집힌 적이 있다.
 *
 * ## 여덟 장을 자르는 규칙
 *
 * 프레임마다 따로 여백을 자르지 않는다. 그렇게 하면 프레임마다 상자가 달라져, 팔을
 * 뻗은 프레임에서 몸이 옆으로 밀리고 방향을 바꿀 때 키가 달라진다. 대신 **여덟 장의
 * 합집합 상자 하나**로 전부 자르고 같은 배율로 줄인다. 원작자가 128×128 안에 맞춰 둔
 * 발 위치와 좌우 정렬이 그대로 보존된다.
 *
 * ## 크기와 위치를 맞추는 규칙 (프리셋마다 원작자의 캔버스 안 위치가 다르다)
 *
 *  - **위치** — 프레임마다 발 가운데(아래 FOOT_ROWS 줄의 불투명 픽셀 평균 x)를 칸 가운데에 두고, 가장 아래 불투명 줄을
 *    칸 바닥에 붙인다. 원본 캔버스에서 사람이 옆으로 치우쳐 있거나(실측: 14번 정면 발 50px, 15번 오른쪽 79px — 가운데는
 *    64) 걷는 프레임만 떠 있어도 칸 안에서는 같은 자리에 선다. 옮기기는 전부 정수 픽셀이다.
 *  - **크기** — 프리셋마다 여덟 장 합집합 상자의 키를 재고 전체의 중앙값과 견준다. SIZE_TOLERANCE 안이면 **원본 픽셀
 *    그대로** 담는다(재샘플하면 도트가 번진다 — 2026-09-13 지적). 벗어나면(다른 크기의 캔버스로 그렸거나 사람이 작게
 *    그려졌으면) 중앙값 키로 면적 평균 재샘플한다. 어느 프리셋을 보정했는지는 매니페스트의 RESAMPLED 에 남는다.
 *  - **칸 너비** — 발 가운데에서 **보이는 픽셀**이 가장 멀리 뻗은 거리로 정한다(상자의 빈 여백이 아니라).
 *
 * ## 파일 이름에 내용 해시가 붙는 이유
 *
 * 시트의 칸 크기가 바뀌었는데 브라우저가 옛 시트를 캐시(4시간)에서 꺼내 쓰면, 새 JS 가
 * 옛 그림을 엉뚱한 자리에서 잘라 낸다 — 위·왼쪽 칸이 빈 곳을 가리키고 사람이 반쯤
 * 잘려 보였다. 이름에 해시가 있으면 그림과 좌표가 언제나 한 쌍이다.
 *
 * 이 파일에서 쓰는 방향·자세 이름은 사용자가 붙인 파일 이름 그대로다: down · left ·
 * right · up, idle · move. 시트·매니페스트·걷기·렌더가 전부 이 여섯 단어만 쓴다.
 * 산출물은 전부 커밋한다 — 원본(수 MB)은 저장소에 남기고, 앱은 줄인 것만 받는다.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync, mkdirSync, statSync, existsSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { decodePng, trim, resize } from "./decode.mjs";
import { Canvas } from "./png.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const SRC = join(ROOT, "images");
const OUT_PUB = join(ROOT, "apps/web/public/office");

/** 게임 안에서의 칸 높이(월드 px). 한 칸이 48px(구입 팩 Office-3) 이고 사람은 **두 칸**이다 — 한 칸이면 캐비닛보다
 *  작아 사람으로 읽히지 않는다(2026-09-13 지적). 책상 2×1 은 사람 허리 높이, 액자 한 칸은 사람 반 키가 된다. */
export const SPRITE_H = 96;
/** 시트 칸 높이(px) — **원본 픽셀 그대로**다. 원본은 전부 128×128 캔버스이고 몸은 109–112px(12명 실측)라, 합집합 상자를
 *  잘라 바닥에 맞춰 담기만 한다. 예전에는 몸을 120px 로 **다시 샘플링**해 담아(비정수 1.07배) 도트의 눈·귀걸이가 번졌고,
 *  그걸 화면에서 또 줄였다 늘렸다 해 선택창의 도트가 뭉개졌다(2026-09-13 지적). 시트에서는 한 번도 재샘플하지 않는다. */
const CELL_H = 112;
/** 시트 px ÷ 월드 px = 112/96 = 7/6. 칸 너비를 7 의 배수로 두어 월드 px 가 정수로 떨어지게 한다. */
export const PEOPLE_SCALE = CELL_H / SPRITE_H;
/** 대화창 초상 높이. 더 키우면 파일이 커지고, 더 줄이면 얼굴이 뭉개진다. */
const PORTRAIT_H = 420;
/** 발로 보는 아래 줄 수(시트 px) — 발 가운데를 칸 가운데에 맞추는 자. 그림의 성질이라 월드 배율과 무관하다.
 *  임포터와 검사(people-sheet.test.mjs)가 **같은 자**를 써야 한다 — 다른 자로 재면 멀쩡한 시트를 틀렸다고 한다. */
const FOOT_ROWS = 13;
const BUST_H = 260;
/** 몸 키 허용 오차 — 중앙값에서 이만큼 안이면 원본 픽셀 그대로, 넘으면 중앙값 키로 다시 샘플한다.
 *  원작 25명(128×128 캔버스)은 합집합 키 110–112px 로 전부 2% 안이다. 6% 는 한 사람이 눈에 띄게 크거나 작아지기 전의 선이다. */
export const SIZE_TOLERANCE = 0.06;

/** 시트의 칸 순서. 사용자 파일 이름과 한 글자도 다르지 않다. */
export const DIRS = ["down", "left", "right", "up"];
export const POSES = ["idle", "move"];

/** 다른 말로 부른 파일도 받아 준다 — 다만 **정본은 위의 단어**다. */
const DIR_ALIAS = {
  down: ["down", "s", "south", "front", "정면", "앞", "아래"],
  left: ["left", "w", "west", "좌", "왼쪽"],
  right: ["right", "e", "east", "우", "오른쪽"],
  up: ["up", "n", "north", "back", "뒤", "뒷모습", "위"],
};
const POSE_ALIAS = {
  idle: ["idle", "stand", "정지", "대기"],
  move: ["move", "walk", "이동", "걷기"],
};

function loadFolders() {
  // `_` 로 시작하는 폴더는 건너뛴다 — 지우지 않고 잠시 빼 두는 길.
  return readdirSync(SRC)
    .filter((n) => !n.startsWith("_"))
    .filter((n) => /^(charactor|character)[_-]?\d+/i.test(n))
    .filter((n) => statSync(join(SRC, n)).isDirectory())
    .filter((n) => {
      // 아직 아무것도 안 넣은 폴더(자리만 잡아 둔 것)는 건너뛴다.
      const files = readdirSync(join(SRC, n));
      if (files.length === 0) {
        console.warn(`  ⚠ ${n}: 비어 있어 건너뜁니다`);
        return false;
      }
      // 초상만 먼저 들어온 폴더(도트 프레임은 아직 그리는 중)도 건너뛴다 — 2026-09-14 남성 28~35 가 이렇게 들어왔다.
      // 프레임이 **한 장이라도** 있으면 여덟 장 계약을 검사한다 — 절반만 넣은 것은 실수이므로 멈춘다.
      const frames = files.filter((f) => /\.png$/i.test(f) && tagOf(f.replace(/\.png$/i, "").toLowerCase()));
      if (frames.length === 0) {
        console.warn(`  ⚠ ${n}: 도트 프레임이 아직 없어 건너뜁니다 (${files.join(", ")})`);
        return false;
      }
      return true;
    })
    .sort();
}

/** `idle-down.png` → { pose: "idle", dir: "down" }. 순서를 바꿔 적어도(`down-idle`) 받는다. */
function tagOf(stem) {
  const parts = stem.split(/[-_ ]+/).filter(Boolean);
  if (parts.length < 2) return null;
  const find = (table, word) => Object.keys(table).find((k) => table[k].includes(word));
  for (const [a, b] of [[parts[0], parts[1]], [parts[1], parts[0]]]) {
    const pose = find(POSE_ALIAS, a);
    const dir = find(DIR_ALIAS, b);
    if (pose && dir) return { pose, dir };
  }
  return null;
}

function classify(folder) {
  const dir = join(SRC, folder);
  const cfgPath = join(dir, "preset.json");
  const cfg = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, "utf8")) : {};
  const files = readdirSync(dir).filter((f) => /\.png$/i.test(f)).sort();
  const cache = new Map();
  const read = (f) => {
    if (!cache.has(f)) cache.set(f, decodePng(readFileSync(join(dir, f))));
    return cache.get(f);
  };
  const stem = (f) => f.replace(/\.png$/i, "").toLowerCase();

  const picked = {};
  const missing = [];
  for (const pose of POSES) {
    for (const d of DIRS) {
      const key = `${pose}-${d}`;
      const hit = cfg.frames?.[key] ?? files.find((f) => {
        const t = tagOf(stem(f));
        return t && t.pose === pose && t.dir === d;
      });
      if (hit) picked[key] = hit;
      else missing.push(`${key}.png`);
    }
  }
  if (missing.length) {
    throw new Error(
      `${folder}: 다음 파일이 없습니다 — ${missing.join(", ")}\n` +
      `  여덟 장(${POSES.join("·")} × ${DIRS.join("·")})이 모두 있어야 방향과 걸음이 맞습니다.\n` +
      `  이미 다른 이름으로 넣어 두었다면 preset.json 에 { "frames": { "idle-down": "앞.png", … } } 로 적어 주세요.`,
    );
  }

  const frames = Object.fromEntries(Object.entries(picked).map(([k, f]) => [k, read(f)]));
  // 여덟 장은 같은 캔버스여야 한다 — 원작자가 그 안에서 발 위치를 맞췄기 때문이다.
  const sizes = new Set(Object.values(frames).map((i) => `${i.w}x${i.h}`));
  if (sizes.size !== 1) {
    throw new Error(
      `${folder}: 여덟 장의 크기가 다릅니다 (${[...sizes].join(", ")}). 같은 캔버스에 그려 주세요.`,
    );
  }

  const portraitFile =
    cfg.portrait ??
    files.find((f) => ["portrait", "초상", "illust"].includes(stem(f))) ??
    files.find((f) => read(f).h / read(f).w > 1.3);

  return { name: cfg.name, gender: cfg.gender, portrait: portraitFile ? read(portraitFile) : null, frames };
}

/** 여덟 장의 불투명 픽셀을 모두 담는 상자 하나 */
function unionBox(frames, alphaThreshold = 8) {
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  for (const img of Object.values(frames)) {
    for (let y = 0; y < img.h; y += 1) {
      for (let x = 0; x < img.w; x += 1) {
        if (img.data[(y * img.w + x) * 4 + 3] <= alphaThreshold) continue;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) throw new Error("여덟 장이 전부 투명합니다");
  return { x0, y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** 발의 가로 가운데 — 아래 여섯 줄에 있는 불투명 픽셀의 평균 x.
 *  상자 가운데가 아니라 발을 쓰는 이유: 팔을 뻗거나 가방을 들면 상자는 옆으로 자라지만
 *  서 있는 자리는 그대로다. 사람이 어디에 '서 있는지'는 발이 말한다. */
function feetCenter(img, rows = 6, alphaThreshold = 8, lift = 0) {
  // lift: 칸에 앉힐 때 이만큼 내려간다 — 칸 바닥에 오는 줄(아래 lift 줄은 비어 있다)에서 발을 잰다
  let sum = 0, n = 0;
  for (let y = Math.max(0, img.h - lift - rows); y < img.h - lift; y += 1) {
    for (let x = 0; x < img.w; x += 1) {
      if (img.data[(y * img.w + x) * 4 + 3] <= alphaThreshold) continue;
      sum += x; n += 1;
    }
  }
  return n ? sum / n : (img.w - 1) / 2;
}

/** 가장 아래 불투명 줄과 칸 바닥 사이의 빈 줄 수 — 이만큼 내려야 발이 바닥에 닿는다 */
function floorGap(img, alphaThreshold = 8) {
  for (let y = img.h - 1; y >= 0; y -= 1) {
    for (let x = 0; x < img.w; x += 1) {
      if (img.data[(y * img.w + x) * 4 + 3] > alphaThreshold) return img.h - 1 - y;
    }
  }
  return 0;
}

/** 보이는 픽셀(알파 8 초과)의 가로 범위 — 칸 너비를 정하는 자 */
function visibleSpan(img, alphaThreshold = 8) {
  let x0 = img.w, x1 = -1;
  for (let y = 0; y < img.h; y += 1) for (let x = 0; x < img.w; x += 1) {
    if (img.data[(y * img.w + x) * 4 + 3] <= alphaThreshold) continue;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
  }
  return x1 < 0 ? { x0: 0, x1: 0 } : { x0, x1 };
}

function cropTo(img, box) {
  const data = new Uint8Array(box.w * box.h * 4);
  for (let y = 0; y < box.h; y += 1) {
    const from = ((y + box.y0) * img.w + box.x0) * 4;
    data.set(img.data.subarray(from, from + box.w * 4), y * box.w * 4);
  }
  return { w: box.w, h: box.h, data };
}

export function main() {
  const folders = loadFolders();
  if (!folders.length) throw new Error(`${SRC} 에 charactor_NN 폴더가 없습니다`);

  const loaded = folders.map((folder) => {
    const c = classify(folder);
    return { folder, ...c, box: unionBox(c.frames) };
  });
  // 크기의 기준 — 모든 프리셋 합집합 키의 중앙값(칸보다 크면 칸 높이). 한두 명이 다르게 그려져도 기준이 끌려가지 않는다.
  const heights = loaded.map((l) => l.box.h).sort((a, b) => a - b);
  const refH = Math.min(CELL_H, heights[Math.floor((heights.length - 1) / 2)]);

  const prepared = loaded.map(({ folder, name, gender, portrait, frames: raw, box: rawBox }) => {
    const id = folder.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    let frames = raw, box = rawBox, scale = 1;
    if (Math.abs(rawBox.h / refH - 1) > SIZE_TOLERANCE || rawBox.h > CELL_H) {
      // 크기 보정 — 여덟 장을 **같은 배율**로(프레임마다 다르면 방향을 바꿀 때 키가 변한다)
      scale = refH / rawBox.h;
      frames = Object.fromEntries(
        Object.entries(raw).map(([k, img]) => [k, resize(img, Math.max(1, Math.round(img.w * scale)), Math.max(1, Math.round(img.h * scale)))]),
      );
      box = unionBox(frames);
    }
    if (box.h > CELL_H) throw new Error(`${folder}: 몸 높이 ${box.h}px 가 시트 칸(${CELL_H}px)보다 크다 — CELL_H 를 늘려라`);
    // 합집합 상자로 자른다(보정이 없으면 재샘플 없음). 여덟 장의 서로 위치는 원작자가 그린 그대로 남는다.
    const sprites = Object.fromEntries(
      Object.entries(frames).map(([k, img]) => {
        const s = cropTo(img, box);
        const lift = floorGap(s);
        return [k, { ...s, feet: feetCenter(s, FOOT_ROWS, 8, lift), lift, ...visibleSpan(s) }];
      }),
    );
    return { id, folder, sprites, w: box.w, h: box.h, scale, portrait, name: name || `캐릭터 ${folder.replace(/\D+/g, "")}`, gender: gender || "" };
  });

  // 칸 안에서 프레임을 **발 가운데**로 맞춘다.
  //
  // 합집합 상자로 자르면 원작자의 배치가 보존되지만, 원작자가 뒷모습을 몇 픽셀 옆에
  // 그려 두었으면 그 어긋남도 같이 보존된다(실측: 남성 프리셋의 up 두 장이 3.5px 오른쪽).
  // 화면에서는 방향을 바꿀 때 사람이 옆으로 폴짝 뛰는 것으로 보인다. 발은 바닥에 닿는
  // 자리라 눈이 가장 먼저 기준으로 삼는 곳이므로, 발 가운데를 칸 가운데에 둔다.
  // 발 가운데에서 **보이는 픽셀**이 가장 멀리 뻗은 거리. 합집합 상자의 빈 여백까지 세면 칸이 쓸데없이 넓어진다.
  const reach = Math.max(
    ...prepared.flatMap((p) => Object.values(p.sprites).map((s) => Math.max(s.feet - s.x0, s.x1 - s.feet))),
  );
  // 칸 너비는 배율의 배수(월드 px 로 나눠 떨어지게)이고 홀수 픽셀 가운데에 발을 둔다. 발을 정수 픽셀로 옮기며 생기는
  // 반 픽셀까지 담아야 보이는 픽셀이 칸 밖으로 나가지 않는다(나가면 아래 복사가 멈춘다).
  const unit = 7; // 칸 너비는 7px 배수 — 월드 px(× 6/7)로 나눠 떨어진다
  const cellW = Math.ceil((2 * Math.ceil(reach + 0.5) + 1) / unit) * unit;
  const COLS = DIRS.length * POSES.length;
  const sheet = new Canvas(COLS * cellW, prepared.length * CELL_H);
  prepared.forEach((p, row) => {
    DIRS.forEach((d, di) => {
      POSES.forEach((pose, pi) => {
        const s = p.sprites[`${pose}-${d}`];
        const ox = (di * POSES.length + pi) * cellW + Math.round((cellW - 1) / 2 - s.feet);
        // 세로도 발이 기준이다. 합집합 상자는 가장 깊이 내딛는 프레임이 바닥을 정하므로,
        // 발을 덜 내린 프레임은 그만큼 떠 있게 된다(실측: 조끼 남성 move-right 2px).
        // 그 프레임만 제 발이 바닥에 닿도록 내린다 — 키(배율)는 그대로다.
        // 칸 바닥에 맞춘다 — 몸(합집합 상자)이 칸보다 낮으면 그만큼 위를 비운다. 옮기기는 전부 정수 픽셀이다.
        const oy = row * CELL_H + (CELL_H - s.h) + s.lift;
        // **바이트 그대로** 복사한다 — 빈 캔버스에 알파 합성(px)을 거치면 반투명 픽셀이 부동소수점 절사로 1씩 틀어진다.
        // 칸 밖으로 나가는 픽셀은 없어야 한다(칸 너비는 가장 멀리 뻗는 프레임이 정했다) — 나가면 멈춘다.
        const cellX0 = (di * POSES.length + pi) * cellW, cellY0 = row * CELL_H;
        for (let y = 0; y < s.h; y += 1) {
          for (let x = 0; x < s.w; x += 1) {
            const o = (y * s.w + x) * 4;
            if (!s.data[o + 3]) continue;
            const tx = ox + x, ty = oy + y;
            if (tx < cellX0 || tx >= cellX0 + cellW || ty < cellY0 || ty >= cellY0 + CELL_H) {
              // 알파 8 이하(보이지 않는 번짐)는 발 위치 계산에서도 뺀 픽셀이다 — 칸 밖이면 버린다. 보이는 픽셀이 나가면 멈춘다.
              if (s.data[o + 3] <= 8) continue;
              throw new Error(`${p.id} ${pose}-${d}: 픽셀 (${x},${y}) 이 칸 밖(${tx},${ty})으로 나간다`);
            }
            const t = (ty * sheet.w + tx) * 4;
            sheet.d[t] = s.data[o]; sheet.d[t + 1] = s.data[o + 1]; sheet.d[t + 2] = s.data[o + 2]; sheet.d[t + 3] = s.data[o + 3];
          }
        }
      });
    });
  });

  mkdirSync(OUT_PUB, { recursive: true });
  const png = sheet.png();
  const hash = createHash("sha1").update(png).digest("hex").slice(0, 10);
  const sheetName = `people.${hash}.png`;
  // 옛 시트는 지운다 — 남겨 두면 어느 것이 진짜인지 다음 사람이 알 수 없다.
  for (const f of readdirSync(OUT_PUB)) if (/^people(\.[0-9a-f]+)?\.png$/.test(f) && f !== sheetName) unlinkSync(join(OUT_PUB, f));
  writeFileSync(join(OUT_PUB, sheetName), png);

  // ── 초상은 낱장으로 (대화할 때만 받는다) ──
  // 전신과 **상반신** 두 벌. 대화창에서 중요한 것은 얼굴인데 전신을 넣으면 머리가
  // 말풍선에 가리거나, 안 가리게 두면 얼굴이 너무 작아진다. 채팅에는 상반신이 맞다.
  mkdirSync(join(OUT_PUB, "portraits"), { recursive: true });
  const crop = (img, frac) => {
    const h = Math.max(1, Math.round(img.h * frac));
    return { w: img.w, h, data: img.data.slice(0, img.w * h * 4) };
  };
  const write = (name, img) => {
    const c = new Canvas(img.w, img.h);
    c.d.set(img.data);
    const bytes = c.png();
    writeFileSync(join(OUT_PUB, "portraits", name), bytes);
    return bytes.length;
  };
  let portraitBytes = 0;
  for (const p of prepared) {
    if (!p.portrait) continue;
    const t = trim(p.portrait);
    portraitBytes += write(`${p.id}.png`, resize(t, Math.max(1, Math.round((t.w * PORTRAIT_H) / t.h)), PORTRAIT_H));
    const bust = trim(crop(t, 0.42));
    portraitBytes += write(`${p.id}-bust.png`, resize(bust, Math.max(1, Math.round((bust.w * BUST_H) / bust.h)), BUST_H));
  }

  // ── 매니페스트 ──
  const entries = prepared
    .map((p, i) =>
      `  { id: ${JSON.stringify(p.id)}, name: ${JSON.stringify(p.name)}, ` +
      `gender: ${JSON.stringify(p.gender)}, row: ${i}, ` +
      `portrait: ${p.portrait ? JSON.stringify(`/office/portraits/${p.id}.png`) : "null"}, ` +
      `bust: ${p.portrait ? JSON.stringify(`/office/portraits/${p.id}-bust.png`) : "null"} },`,
    )
    .join("\n");

  writeFileSync(
    join(ROOT, "apps/web/lib/people.ts"),
    `// 생성 파일 — 직접 고치지 말 것. \`node tools/tileset/characters-import.mjs\` 가 만든다.
// 원본은 images/charactor_*/ 에 있다. 새 프리셋은 그 규칙대로 폴더를 하나 더 두면 된다.
// 사무실·메신저·시나리오 편집기가 모두 이 목록을 쓴다.
// 시트가 계약대로 잘렸는지는 \`node --test tools/tileset/\` 가 검사한다.
import type { CSSProperties } from "react";

/** 방향 — **원본 파일 이름 그대로**다 (idle-down.png … move-up.png).
 *
 *  코드가 따로 약어(s/w/e/n, north/south/…)를 두지 않는다. 그림 파일에서 화면까지
 *  가는 길에 번역이 한 번이라도 끼면 그 자리에서 방향이 어긋나고, 실제로 어긋났다. */
export type Dir = "down" | "left" | "right" | "up";
/** 자세 — 서 있는 자세와 내딛는 자세. 걸을 때 번갈아 쓴다. */
export type Pose = "idle" | "move";

export const DIRS: Dir[] = ${JSON.stringify(DIRS)};
export const POSES: Pose[] = ${JSON.stringify(POSES)};

/** 파일 이름의 해시는 내용에서 온다 — 시트가 바뀌면 이름도 바뀌어, 캐시된 옛 그림이
 *  새 좌표와 짝지어지는 일이 없다. */
export const PEOPLE_SRC = ${JSON.stringify(`/office/${sheetName}`)};
/** 시트 배율 — 시트 px ÷ 월드 px (= ${CELL_H}/${SPRITE_H}). 시트는 **원본 픽셀 그대로**라 화면보다 촘촘하다. */
export const PEOPLE_SCALE = ${PEOPLE_SCALE};
/** 시트 한 칸·시트 전체 크기(시트 px, 정수) — 원본 픽셀을 다룰 때(캔버스에 굽기, 크게 보여 주기)는 이것을 쓴다 */
export const PERSON_SHEET_W = ${cellW};
export const PERSON_SHEET_H = ${CELL_H};
export const SHEET_PX_W = ${COLS * cellW};
export const SHEET_PX_H = ${prepared.length * CELL_H};
/** 발로 보는 아래 줄 수(시트 px) — 시트를 검사할 때 임포터와 같은 자를 쓰라고 내보낸다 */
export const FOOT_ROWS = ${FOOT_ROWS};
/** 크기를 보정하느라 **다시 샘플한** 프리셋 — 몸 키가 중앙값(${refH}px)과 ${SIZE_TOLERANCE * 100}% 넘게 달랐다. 나머지는 원본 픽셀 그대로다. */
export const RESAMPLED: string[] = ${JSON.stringify(prepared.filter((p) => p.scale !== 1).map((p) => p.id))};
/** 시트 전체 크기(월드 px) — background-size 에 그대로 쓴다 */
export const SHEET_W = ${(COLS * cellW * SPRITE_H) / CELL_H};
export const SHEET_H = ${prepared.length * SPRITE_H};
/** 한 칸 크기(월드 px) — 세로는 타일(32) 한 칸 반이다. 사람이 책상보다 커야 사람으로 보인다. */
export const PERSON_W = ${(cellW * SPRITE_H) / CELL_H};
export const PERSON_H = ${SPRITE_H};

/** 움직인 방향 → 볼 방향. 가로가 더 크면 좌우, 아니면 위아래다.
 *  (0,0) 이 오면 바꾸지 않는다는 뜻이라 \`fallback\` 을 돌려준다. */
export function dirOf(dx: number, dy: number, fallback: Dir = "down"): Dir {
  if (dx === 0 && dy === 0) return fallback;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? "right" : "left";
  return dy >= 0 ? "down" : "up";
}

/** a 에서 b 를 바라보는 방향. 사람이 다가오면 고개를 돌리는 데 쓴다. */
export function dirTo(
  from: { x: number; y: number },
  to: { x: number; y: number },
  fallback: Dir = "down",
): Dir {
  return dirOf(to.x - from.x, to.y - from.y, fallback);
}

export interface Person {
  id: string;
  name: string;
  /** 이 프리셋이 어느 성별로 보이는가. 인물에 성별이 지정되면 맞는 것끼리만 고른다. */
  gender: string;
  /** 시트에서의 줄 번호 */
  row: number;
  /** 전신 초상. */
  portrait: string | null;
  /** 대화창에 띄우는 상반신 — 얼굴이 커야 말을 걸게 된다. */
  bust: string | null;
}

export const PEOPLE: Person[] = [
${entries}
];

/** 이 프리셋·방향·자세가 시트의 어디인가 — **월드 px** (background-size 를 SHEET_W×SHEET_H 로 두고
 *  background-position 에 그대로 쓴다). 시트 px 가 필요하면 PEOPLE_SCALE 을 곱한다. */
export function personCell(row: number, dir: Dir, pose: Pose = "idle"): { x: number; y: number } {
  const di = Math.max(0, DIRS.indexOf(dir));
  const pi = Math.max(0, POSES.indexOf(pose));
  return { x: (di * POSES.length + pi) * PERSON_W, y: row * PERSON_H };
}

/** 이 프리셋·방향·자세가 시트의 어디인가 — **시트 px(정수)**. 원본 픽셀을 그대로 꺼낼 때 쓴다. */
export function personSheetCell(row: number, dir: Dir, pose: Pose = "idle"): { x: number; y: number } {
  const di = Math.max(0, DIRS.indexOf(dir));
  const pi = Math.max(0, POSES.indexOf(pose));
  return { x: (di * POSES.length + pi) * PERSON_SHEET_W, y: row * PERSON_SHEET_H };
}

/** 원하는 **CSS 높이**로 한 칸을 꺼내는 CSS — transform 으로 키우지 않는다.
 *
 *  transform: scale 로 키우면 브라우저가 작은 크기로 먼저 그린 뒤 늘려(합성 레이어면 더 그렇다) 도트가 두 번 뭉개진다.
 *  여기서는 background-size 를 목표 크기로 바로 잡아 원본에서 **한 번만** 옮겨 그린다. 늘릴 때는 도트가 도트로 남도록
 *  pixelated, 줄일 때는 부드럽게. 도트가 고르게 보이려면 늘리는 배율(높이 ÷ ${CELL_H})을 정수로 고르는 것이 좋다. */
export function personSpriteAt(row: number, dir: Dir, pose: Pose, height: number): CSSProperties {
  const s = height / PERSON_SHEET_H;
  const cell = personSheetCell(row, dir, pose);
  return {
    width: PERSON_SHEET_W * s,
    height,
    backgroundImage: \`url(\${PEOPLE_SRC})\`,
    backgroundSize: \`\${SHEET_PX_W * s}px \${SHEET_PX_H * s}px\`,
    backgroundPosition: \`-\${cell.x * s}px -\${cell.y * s}px\`,
    backgroundRepeat: "no-repeat",
    imageRendering: s >= 1 ? "pixelated" : "auto",
  };
}

/** 시트에서 한 칸을 **월드 크기**로 꺼내는 CSS — 크기·위치·배율이 한 쌍이어야 하므로 여기서만 만든다 */
export function personSpriteStyle(row: number, dir: Dir, pose: Pose = "idle"): CSSProperties {
  const cell = personCell(row, dir, pose);
  return {
    width: PERSON_W,
    height: PERSON_H,
    backgroundImage: \`url(\${PEOPLE_SRC})\`,
    backgroundSize: \`\${SHEET_W}px \${SHEET_H}px\`,
    backgroundPosition: \`-\${cell.x}px -\${cell.y}px\`,
    backgroundRepeat: "no-repeat",
  };
}
`,
  );

  // ── 서버용 프리셋 목록 ──
  // 서버는 그림이 필요 없지만 **어떤 프리셋이 있고 성별이 무엇인지**는 알아야 한다:
  // 빈 자리를 겹치지 않게 채우는 할당기와, 게스트가 고른 프리셋의 검증이 이 목록을 쓴다.
  // 웹 매니페스트와 같은 원천에서 같은 순간에 나오므로 어긋날 수 없다
  // (tests/unit/test_avatar_alloc.py 가 둘을 맞대 본다).
  writeFileSync(
    join(ROOT, "apps/api/odysseus_api/people_presets.py"),
    `"""생성 파일 — 직접 고치지 말 것. \`node tools/tileset/characters-import.mjs\` 가 만든다.

apps/web/lib/people.ts 와 같은 목록이다. 서버는 그림을 모르지만 프리셋의 id 와 성별은
알아야 한다 — 빈 자리를 겹치지 않게 채우는 할당기(avatar_alloc)와 게스트가 고른
프리셋의 검증이 여기서 본다.
"""

PRESETS: tuple[dict, ...] = (
${prepared.map((p) => `    {"id": ${JSON.stringify(p.id)}, "name": ${JSON.stringify(p.name)}, "gender": ${JSON.stringify(p.gender)}},`).join("\n")}
)

PRESET_IDS: frozenset[str] = frozenset(p["id"] for p in PRESETS)
`,
  );

  return { prepared, cellW, sheetName, sheetBytes: png.length, portraitBytes, cols: COLS };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = main();
  console.log(
    `프리셋 ${r.prepared.length}개 · ${r.sheetName} ${r.cols * r.cellW}×${r.prepared.length * SPRITE_H} ` +
    `(${(r.sheetBytes / 1024).toFixed(1)}KB) · 초상 ${(r.portraitBytes / 1024).toFixed(0)}KB`,
  );
  console.log(`  칸 순서: ${DIRS.flatMap((d) => POSES.map((p) => `${p}-${d}`)).join(" | ")}`);
  for (const p of r.prepared) {
    const size = p.scale === 1 ? "원본 그대로" : `크기 보정 ×${p.scale.toFixed(3)}`;
    console.log(`  ${p.id}  ${p.gender || "성별 없음"}  ${p.name}  몸 ${p.w}×${p.h}px · ${size}${p.portrait ? "" : "  (초상 없음)"}`);
  }
}

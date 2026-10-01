/** 사무실 한 층 — 좌표와 배치에 관한 유일한 진실.
 *
 * 규칙 하나로 요약된다: **사람이 물건의 좌표를 타이핑하지 않는다.** 장면(scenes.ts)이 칸 단위로
 * 무엇이 어디 있는지를 말하고, 이 파일이 그것을 월드 픽셀로 옮긴다. 방을 칸으로 나누고 먼저 쓴
 * 쪽이 칸을 차지하므로 겹침은 표현할 수가 없다.
 *
 * 투영은 **정직한 탑다운**이다. 아이소메트릭으로 기울이지 않는다.
 *  - 마름모로 자른 버튼은 안에 들어가는 정사각형이 작아진다 — 같은 배율에서 28.5px 대
 *    39px 이라, 누를 수 있는 크기를 투영에 쓰는 셈이 된다.
 *  - 3D 변환된 요소의 히트 테스트는 명세에 정의가 없다(w3c/csswg-drafts#3997).
 *    Firefox 는 Chrome 이 받아 주는 클릭을 거부한다. 모든 자리가 진짜 버튼이어야 하는
 *    화면에서 감당할 수 없는 위험이다.
 *  - Gather·WorkAdventure·SkyOffice 도 전부 정사각 격자 탑다운이다. 그 제품들의 입체감은
 *    기울기가 아니라 **바닥은 정사각으로 두고 수직면만 윗면 + 어두운 앞면으로 그리는 데서** 온다.
 *
 * 벽은 RPG Maker 식이다(구입한 팩 Office-3, 한 칸 48px). 방 둘레 **한 칸**이 벽 윗면(검은 천장 + 밝은 테두리)이고
 * 옆방과 그 칸을 나눠 쓴다. 위 벽의 **앞면**(남쪽에서 보이는 벽면)은 그 아래 한 줄을 더 차지한다 — 방은 위 고리 아래
 * 한 줄, 복도는 북쪽 방 문 벽 아래 한 줄. 벽걸이는 그 앞면에 걸린다. 벽은 손으로 놓지 않는다 — 고리·컷 칸을 층 전체
 * 한 격자에서 분류하고 8방향 이웃으로 오토타일 변형을 고르므로 방 사이·복도 벽의 테두리가 저절로 이어지고 도려낸
 * 모서리의 벽도 따라간다.
 */

import type { Dir } from "@/lib/people";
import { SCENES, SCENE_LIMITS, WALKABLE_PROPS, assignScenes, doorColsOf, footprintOf, migrateScene, type PropKind, type SceneId, type SceneSpec } from "./scenes.ts";
import { S, WALL_DEFAULT, WALL_FACE_VARIANT, WALL_TOP_VARIANT, type FloorKey, type SpriteName, type WallStyleKey } from "./atlas.ts";

export type { PropKind, SceneId, SceneSpec };
export type DecorKind = PropKind;

/** 한 칸. 모든 치수가 이 배수다. 팩(Office-3)의 칸 크기 그대로 — 그림을 다시 샘플링하지 않는다. */
export const TILE = 48;

/** 벽 두께 = 한 칸. 옆방과 나눠 쓴다. */
export const WALL = TILE;
/** 위 벽의 앞면이 차지하는 한 줄 — 방 안쪽 첫 줄 위, 복도 첫 줄 */
export const FACE = TILE;

/** 방의 바깥 치수 — 안쪽 칸 수(cols×rows)에 벽 한 칸씩, 위에는 앞면 한 줄 더. */
export const roomW = (cols: number) => (cols + 2) * TILE;
export const roomH = (rows: number) => (rows + 3) * TILE;

/** 문 폭 = 두 칸. 복도 쪽 벽 한가운데가 뚫려 있다. */
export const DOOR_WIDTH = 2 * TILE;

/** 장면이 정하는 안쪽 칸 수의 상한 — 층이 화면보다 크면 카메라가 아바타를 따라간다 */
export const MAX_COLS = SCENE_LIMITS.maxCols;
export const MAX_ROWS = SCENE_LIMITS.maxRows;

/** 이 배율보다 작아지면 층을 줄이는 대신 카메라가 아바타를 따라간다. */
export const MIN_SPATIAL_FIT = 0.42;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Room {
  /** 방 키 = 시험 id */
  id: string;
  label: string;
  x: number;
  y: number;
  /** 바깥 치수(벽 포함) */
  w: number;
  h: number;
  /** 안쪽 칸 수 */
  cols: number;
  rows: number;
  side: "north" | "south";
  /** 문패·문턱·불 켜진 화면에만 쓰는 색. 바닥을 이 색으로 칠하지 않는다. */
  accent: string;
  /** 이 방의 장면 id — 기본 아홉 중 하나거나 관리자 프리셋의 uuid */
  scene: SceneId;
  /** 장면 자체 — 크기·모양·바닥·소품·서는 자리·문은 여기서 온다 */
  spec: SceneSpec;
  floorKey: FloorKey;
  /** 문의 왼쪽 칸(아래 줄) */
  doorC: number;
  /** 시험의 분야 키. 장면과 색이 여기서 온다. */
  category: string;
  /** 같은 장면이 한 층에 두 번 서면 두 번째는 좌우를 뒤집는다 — 옆방과 똑같이 생기지 않게 */
  mirror: boolean;
}

/** 한 층에 놓을 수 있는 방의 수 — 열여섯을 넘으면 한 화면에서 방 이름이 읽히지 않는다. */
export const MAX_ROOMS = 16;

/** 벽 칸 하나 — 윗면(top: 검은 천장 + 테두리) 또는 앞면(face: 남쪽에서 보이는 벽면).
 *  variant 는 스타일 시트 안의 칸 번호(오토타일 변형 — 이웃을 보고 정한다), style 은 벽 스타일(장면이 고른다). */
export interface WallPiece extends Rect {
  kind: "top" | "face";
  variant: number;
  style: WallStyleKey;
}

/** 벽 칸의 깊이(y 정렬층) — 칸 아래선 */
export const wallZOf = (rowY: number) => rowY + TILE;
/** 벽걸이의 깊이 — 앞면 칸보다 위 */
export const decorZOf = (faceY: number) => faceY + TILE + 1;

export interface Floor {
  rooms: Room[];
  world: { width: number; height: number };
  corridor: { top: number; bottom: number; left: number; right: number };
  corridorY: number;
  /** 엘리베이터 앞 복도 — 출근하면 여기 선다 */
  spawn: { x: number; y: number };
  /** 출입구 — 복도 왼쪽 끝. 출근 연출의 카메라가 여기를 보고, 아바타는 왼쪽 밖에서 걸어 들어온다 */
  gate: { x: number; y: number };
  /** 층의 벽 전부 — 복도와 방의 벽이 한 그래프다(방 사이·복도와 방 사이의 접합이 여기서 정해진다) */
  walls: WallPiece[];
  /** 복도 벽에 걸린 것(엘리베이터 문 …) */
  decor: WallDecor[];
  /** 복도 바닥의 소품 — 지금은 없다(걷는 띠가 좁다). 두면 blocked 에 발자국을 같이 넣는다. */
  props: PlacedProp[];
  /** 복도에서 서지 못하는 자리(소품 발자국) */
  blocked: Rect[];
}

/** 방 줄 양옆의 여백. 방은 이 안쪽에서 시작한다. 복도는 그보다 더 왼쪽까지 뻗어 출입문 앞이 된다. */
const MARGIN_X = 4 * TILE;
/** 건물 위아래 여백 */
const MARGIN_Y = TILE;
/** 복도 높이 — 위 벽 앞면 한 줄 + 걷는 세 줄 */
const CORRIDOR_H = FACE + 3 * TILE;
/** 복도가 방 줄보다 왼쪽·오른쪽으로 더 뻗는 길이. 왼쪽 끝이 출입문 앞이다. */
const CORRIDOR_OVERHANG = 3 * TILE;

/** 시험 목록 → 층 하나.
 *
 *  위 줄에 앞의 절반, 아래 줄에 나머지. 방마다 크기가 다르고, 옆방과 벽 한 칸을 나눠 쓴다.
 *  북쪽 줄은 복도에 **아래를** 맞추고 남쪽 줄은 위를 맞춰, 높이가 달라도 문이 복도에 닿는다. */
export function buildFloor(
  specs: { slug: string; label: string; accent: string; category?: string; scene?: SceneSpec | null }[],
  /** 관리자가 고친 템플릿(builtin-scenes.ts) — 자동으로 고른 방도 고친 모양으로 선다. 없으면 코드의 기본값. */
  builtins?: Partial<Record<string, SceneSpec>>,
): Floor {
  const list = specs.slice(0, MAX_ROOMS);
  // 장면이 정해진 방(관리자 프리셋)은 그대로, 나머지는 분야에서 고르되 층 안에서 최대한 겹치지 않게.
  const auto = assignScenes(list.map((d) => (d.scene ? null : d.category ?? "")));
  const specOf: SceneSpec[] = list.map((d, i) => (d.scene ? migrateScene(d.scene) : builtins?.[auto[i] as string] ?? SCENES[auto[i] as keyof typeof SCENES]));
  const seen = new Map<SceneId, number>();
  const mirrorOf = specOf.map((sp) => {
    const n = seen.get(sp.id) ?? 0;
    seen.set(sp.id, n + 1);
    return n % 2 === 1;
  });
  const dims = specOf.map((sp) => ({ w: roomW(sp.cols), h: roomH(sp.rows) }));
  const topCount = Math.ceil(list.length / 2);
  const northIdx = list.map((_, i) => i).filter((i) => i < topCount);
  const southIdx = list.map((_, i) => i).filter((i) => i >= topCount);
  // 옆방과 벽을 나눠 쓰므로 줄 폭은 방 폭의 합에서 겹치는 벽만큼 준다.
  const rowWidth = (idx: number[]) => (idx.length ? idx.reduce((a, i) => a + dims[i].w, 0) - (idx.length - 1) * WALL : 0);
  const rowHeight = (idx: number[]) => idx.reduce((a, i) => Math.max(a, dims[i].h), 0);
  const northW = rowWidth(northIdx), southW = rowWidth(southIdx);
  const northH = rowHeight(northIdx), southH = rowHeight(southIdx);

  const width = Math.max(Math.max(northW, southW) + MARGIN_X * 2, 640);
  const corridorTop = MARGIN_Y + northH;
  const corridor = {
    top: corridorTop,
    bottom: corridorTop + CORRIDOR_H,
    left: MARGIN_X - CORRIDOR_OVERHANG,
    right: width - (MARGIN_X - CORRIDOR_OVERHANG),
  };
  const height = corridor.bottom + southH + MARGIN_Y;
  const corridorY = (corridor.top + FACE + corridor.bottom) / 2;

  const rooms: Room[] = [];
  for (const [idx, north] of [[northIdx, true], [southIdx, false]] as [number[], boolean][]) {
    // 줄마다 가운데로 모은다 — 한쪽으로 쏠려 있으면 층이 미완성으로 보인다.
    let x = Math.round((width - rowWidth(idx)) / 2 / TILE) * TILE; // 칸에 맞춘다 — 벽 그래프가 복도와 방을 한 격자에서 잇는다
    for (const i of idx) {
      const d = list[i];
      const spec = specOf[i];
      const { w, h } = dims[i];
      const [doorC] = doorColsOf(spec);
      rooms[i] = {
        id: d.slug,
        label: d.label,
        x,
        y: north ? corridor.top - h : corridor.bottom,
        w,
        h,
        cols: spec.cols,
        rows: spec.rows,
        side: north ? "north" : "south",
        accent: d.accent,
        scene: spec.id,
        spec,
        floorKey: spec.floor,
        // 거울 방은 문도 거울 — 장면이 문을 왼쪽에 뒀으면 거울에서는 오른쪽이다
        doorC: mirrorOf[i] ? spec.cols - doorC - 2 : doorC,
        category: d.category ?? "",
        mirror: mirrorOf[i],
      };
      x += w - WALL;
    }
  }

  // ── 복도의 벽·매트·소품 ──
  // 벽은 층 전체를 한 격자에서 분류한다 — 방 사이·복도 벽의 테두리가 이어진다(floorWalls).
  const x0 = corridor.left - WALL, x1 = corridor.right + WALL;
  const walls = floorWalls(rooms, corridor, x0, x1);
  // 방이 덮지 않는 복도 위 가장자리 — 벽걸이를 거는 자리
  const topRuns: [number, number][] = [];
  {
    let x = x0 + WALL;
    for (const r of rooms.filter((r) => r.side === "north").sort((a, b) => a.x - b.x)) {
      if (r.x > x) topRuns.push([x, r.x]);
      x = Math.max(x, r.x + r.w);
    }
    if (x < x1 - WALL) topRuns.push([x, x1 - WALL]);
  }

  // 복도 위 벽 앞면의 벽걸이. 왼쪽 끝(출근 자리)은 비워 둔다.
  const decor: WallDecor[] = [];
  // 남는 위 벽 토막마다 하나씩 건다 — 빈 벽이 길면 복도가 아니라 여백으로 보인다
  const hangs: DecorKind[] = ["board-cork", "clock-blue", "picture-abstract-1"];
  let k = 0;
  for (const [a, b] of topRuns) {
    const from = Math.max(a, corridor.left + 2 * TILE + TILE); // 엘리베이터와 그 옆 화분은 비운다
    const to = Math.min(b, corridor.right - TILE);
    if (to - from < 2 * TILE) continue;
    const kind = hangs[k % hangs.length];
    k += 1;
    const w = footprintOf(kind).w * TILE;
    const cx = Math.floor((from + to) / 2 / TILE) * TILE - (w > TILE ? TILE : 0);
    if (cx >= from && cx + w <= to) decor.push(hang(kind, cx, corridor.top));
  }

  // 복도 바닥에는 소품을 두지 않는다 — 걷는 띠가 세 칸뿐이라 화분 하나가 길을 막는다.
  // 복도의 장식은 벽에 건다(엘리베이터·코르크보드·시계·소화기).
  const props: PlacedProp[] = [];
  const blocked: Rect[] = [];
  return {
    rooms,
    world: { width, height },
    corridor,
    corridorY,
    spawn: { x: corridor.left + 2 * TILE, y: corridorY },
    gate: { x: corridor.left + TILE, y: corridorY },
    walls,
    decor,
    props,
    blocked,
  };
}

/** 벽걸이 하나를 벽 앞면에 건다 — 그림 아래를 앞면 칸 아래선에 맞춘다(키 큰 것은 윗면 줄까지 솟는다). z 는 벽 칸보다 위. */
export function hang(kind: DecorKind, x: number, faceY: number): WallDecor {
  const f = footprintOf(kind);
  if (!f.wall) throw new Error(`[office] ${kind} 은 바닥 소품이라 벽에 걸 수 없다`);
  const cell = S[kind as SpriteName];
  return { kind, x, y: faceY + TILE - cell.h, w: f.w * TILE, h: cell.h, z: decorZOf(faceY) };
}

/** 방 안쪽 바닥의 왼쪽 위 모서리 */
export function innerOrigin(room: Room): { x: number; y: number } {
  return { x: room.x + WALL, y: room.y + WALL + FACE };
}

/** 방의 문 칸 두 개 (안쪽 칸 좌표) */
export function roomDoorCols(room: Pick<Room, "doorC">): [number, number] {
  return [room.doorC, room.doorC + 1];
}

/** 문 한가운데 — 복도 쪽 벽면 위의 점. 걷기 경로의 마지막 꺾임이다. */
export function doorOf(room: Room): { x: number; y: number } {
  return {
    x: room.x + WALL + (room.doorC + 1) * TILE,
    y: room.side === "north" ? room.y + room.h + FACE : room.y,
  };
}

/** 방에 들어가 서는 자리 — 문에서 두 칸 안쪽, 통로 한가운데. */
export function standingSpotOf(room: Room): { x: number; y: number } {
  const inner = innerOrigin(room);
  return {
    x: doorOf(room).x,
    y: room.side === "north" ? inner.y + (room.rows - 1.5) * TILE : inner.y + 1.5 * TILE,
  };
}

/** 문 통로 — 고리 칸 + 그 너머 앞면 칸(북쪽 방은 복도 앞면 줄, 남쪽 방은 방 안 앞면 줄). 둘 다 뚫려 있고 걷는다. */
export function doorGapOf(room: Room): Rect {
  const x = room.x + WALL + room.doorC * TILE;
  return { x, y: room.side === "north" ? room.y + room.h - WALL : room.y, w: DOOR_WIDTH, h: WALL + FACE };
}

// ── 방 안 배치 ──────────────────────────────────────────────────
//
// 칸 상태. 먼저 쓴 쪽이 임자다.
export const EMPTY = 0;
/** 도려낸 칸 — 벽이다 */
export const SOLID = 1;
export const PROP = 5;

/** 응시자의 업무 시작 지점 — 노트북이 놓인 스탠딩 데스크(2×1). 앉지 않는다. */
export interface StartSlot {
  /** 버튼(=책상)의 왼쪽 위 월드 좌표 */
  x: number;
  y: number;
  /** 책상 앞에 서는 자리(발끝 월드 좌표) — 여기 서면 시작할 수 있다 */
  stand: { x: number; y: number };
  cell: { c: number; r: number };
}

export interface StandSpot {
  /** 발끝 월드 좌표 */
  x: number;
  y: number;
  /** 가만히 있을 때 보는 방향 */
  face: Dir;
  cell: { c: number; r: number };
}

export interface PlacedProp {
  kind: PropKind;
  /** 바닥 발자국의 왼쪽 위 월드 좌표. 그림이 더 크면 위로 솟는다(아래를 맞춘다). */
  x: number;
  y: number;
  /** 발자국 크기(칸) */
  w: number;
  h: number;
  /** React key 를 안정시키기 위한 칸 번호 */
  cell: number;
}

export interface WallDecor {
  kind: DecorKind;
  /** 스프라이트의 왼쪽 위 월드 좌표 (그림의 보이는 부분이 벽 앞면에 오도록 계산됨) */
  x: number;
  y: number;
  w: number;
  h: number;
  /** y 정렬층에서의 깊이 — 벽 아래선 */
  z: number;
}

export interface FloorRun extends Rect {
  floor: FloorKey;
}

export interface RoomLayout {
  room: Room;
  scene: SceneId;
  start: StartSlot;
  props: PlacedProp[];
  decor: WallDecor[];
  /** 사람이 서는 자리 — 장면의 자리 + 모자라면 곁에 더 세운 자리. 앞의 것부터 채운다. */
  standing: StandSpot[];
  /** 이 방의 벽 — 마스크에서 계산됨 */
  walls: WallPiece[];
  /** 도려낸 칸(월드 사각형) — 바닥을 깔지 않는다 */
  cuts: Rect[];
  /** 바닥 칸 줄 전부(기본 바닥 포함) — 도려낸 칸은 비운다. 같은 줄에서 이어지면 한 사각형. */
  floors: FloorRun[];
  grid: Uint8Array;
}

function asciiDump(grid: Uint8Array, cols: number, rows: number): string {
  const glyph = [".", "#", "D", "H", "-", "P"];
  const lines: string[] = [];
  for (let r = 0; r < rows; r += 1) {
    let line = "";
    for (let c = 0; c < cols; c += 1) line += `${glyph[grid[r * cols + c]]} `;
    lines.push(line);
  }
  return lines.join("\n");
}

const flipV = (d: Dir): Dir => (d === "up" ? "down" : d === "down" ? "up" : d);
const flipH = (d: Dir): Dir => (d === "left" ? "right" : d === "right" ? "left" : d);

/**
 * 방 하나를 배치한다 — 장면을 방에 깐다.
 *
 *  0. 장면은 북쪽 방 기준(문이 아래)이다. 남쪽 방은 위아래를 뒤집고, 거울 방은 좌우를 뒤집는다.
 *  1. 도려낸 모서리(cuts)가 벽이 된다.
 *  2. 장면의 소품이 칸을 차지한다(러그는 밟고 다니므로 예외).
 *  3. 업무 시작 지점(스탠딩 데스크)이 두 칸을 차지하고, 그 앞 칸이 서는 자리가 된다.
 *  4. 벽걸이는 **위쪽 벽의 앞면**에 건다(탑다운에서 앞면은 위쪽 벽에만 있다). 남쪽 방에서는 그 벽이
 *     문이 있는 벽이라 문 칸을 피해 옆으로 민다. 아래에 위로 솟는 소품이 서 있는 칸도 피한다.
 *  5. 문에서 모든 서는 자리와 시작 지점에 닿는지 훑어서 증명한다.
 *  6. 사람이 장면의 자리보다 많으면, 이미 서 있는 사람 곁의 빈 칸에 더 세운다.
 *  7. 벽을 마스크에서 계산한다.
 *
 * 난수를 쓰지 않는다 — 서버가 그린 것과 브라우저가 그린 것이 한 픽셀도 달라지면 안 된다.
 */
export function layoutRoom(room: Room, crewCount: number): RoomLayout {
  const spec = room.spec;
  const cols = room.cols, rows = room.rows;
  const cellIndex = (c: number, r: number) => r * cols + c;
  const grid = new Uint8Array(cols * rows);
  const north = room.side === "north";
  const inner = innerOrigin(room);
  const apronRow = north ? rows - 1 : 0; // 문 쪽 줄
  const [d0, d1] = roomDoorCols(room);
  const doorCells = [{ c: d0, r: apronRow }, { c: d1, r: apronRow }];
  // 장면은 북쪽 방 기준으로 적혀 있다. 남쪽 방은 줄을 뒤집고, 거울 방은 칸을 뒤집는다.
  const R = (r: number, h = 1) => (north ? r : rows - r - h);
  const C = (c: number, w = 1) => (room.mirror ? cols - c - w : c);
  const F = (d: Dir) => {
    let out = north ? d : flipV(d);
    if (room.mirror) out = flipH(out);
    return out;
  };
  const dump = () => asciiDump(grid, cols, rows);

  const put = (c: number, r: number, v: number) => {
    if (c < 0 || c >= cols || r < 0 || r >= rows) throw new Error(`[office] ${room.id}/${room.scene} 칸 (${c},${r}) 이 방 밖이다`);
    const i = cellIndex(c, r);
    if (process.env.NODE_ENV !== "production" && grid[i] !== EMPTY && grid[i] !== v) {
      throw new Error(`[office] ${room.id}/${room.scene} 칸 (${c},${r}) 이 두 번 쓰였다\n${dump()}`);
    }
    grid[i] = v;
  };

  // 1. 도려낸 모서리
  const cuts: Rect[] = [];
  for (const cut of spec.cuts ?? []) {
    const c0 = C(cut.c, cut.w), r0 = R(cut.r, cut.h);
    for (let dr = 0; dr < cut.h; dr += 1) for (let dc = 0; dc < cut.w; dc += 1) put(c0 + dc, r0 + dr, SOLID);
    cuts.push({ x: inner.x + c0 * TILE, y: inner.y + r0 * TILE, w: cut.w * TILE, h: cut.h * TILE });
  }
  if (process.env.NODE_ENV !== "production") {
    for (const d of doorCells) if (grid[cellIndex(d.c, d.r)] === SOLID) throw new Error(`[office] ${room.scene}: 문 칸 (${d.c},${d.r}) 이 도려내졌다`);
  }

  // 2. 소품
  const props: PlacedProp[] = [];
  for (const p of spec.props) {
    const size = footprintOf(p.kind);
    if (size.wall) throw new Error(`[office] ${room.scene}: ${p.kind} 은 벽걸이라 바닥에 놓을 수 없다`);
    const r0 = R(p.r, size.h);
    const c0 = C(p.c, size.w);
    if (!WALKABLE_PROPS.has(p.kind)) {
      for (let dr = 0; dr < size.h; dr += 1) for (let dc = 0; dc < size.w; dc += 1) put(c0 + dc, r0 + dr, PROP);
    }
    props.push({ kind: p.kind, x: inner.x + c0 * TILE, y: inner.y + r0 * TILE, w: size.w, h: size.h, cell: cellIndex(c0, r0) });
  }
  // 소품은 뒤에 있는 것(위쪽)이 먼저 그려져야 앞의 것이 덮는다
  props.sort((a, b) => a.y + a.h * TILE - (b.y + b.h * TILE) || a.x - b.x);

  // 3. 업무 시작 지점 — 스탠딩 데스크 두 칸 + 앞 칸이 서는 자리
  const sr = R(spec.start.r);
  const sc = C(spec.start.c, 2);
  put(sc, sr, PROP);
  put(sc + 1, sr, PROP);
  const frontRow = north ? sr + 1 : sr - 1;
  const start: StartSlot = {
    x: inner.x + sc * TILE,
    y: inner.y + sr * TILE,
    stand: { x: inner.x + sc * TILE + TILE, y: inner.y + frontRow * TILE + TILE * 0.9 },
    cell: { c: sc, r: sr },
  };

  // 4. 벽걸이 — 위쪽 벽의 앞면. 그 아래 줄(월드 0번 줄)에 컷이나 솟는 소품이 있으면 옆으로 민다.
  const risingAt = new Set<number>();
  for (const p of props) {
    const size = footprintOf(p.kind);
    const r0 = Math.round((p.y - inner.y) / TILE);
    const c0 = Math.round((p.x - inner.x) / TILE);
    if (r0 === 0 && size.rise > 0) for (let dc = 0; dc < size.w; dc += 1) risingAt.add(c0 + dc);
  }
  if (sr === 0) { risingAt.add(sc); risingAt.add(sc + 1); }
  const faceY = room.y + WALL;
  const doorOnTop = !north;
  const decorTaken = new Set<number>();
  const decorOk = (c: number, w: number) => {
    for (let dc = 0; dc < w; dc += 1) {
      const cc = c + dc;
      if (cc < 0 || cc >= cols) return false;
      if (grid[cellIndex(cc, 0)] === SOLID) return false;
      if (risingAt.has(cc)) return false;
      if (doorOnTop && (cc === d0 || cc === d1)) return false;
      if (decorTaken.has(cc)) return false;
    }
    return true;
  };
  const decor: WallDecor[] = [];
  for (const d of spec.decor) {
    const f = footprintOf(d.kind);
    if (!f.wall) throw new Error(`[office] ${room.scene}: ${d.kind} 은 바닥 소품이라 벽에 걸 수 없다`);
    const want = C(d.c, f.w);
    let at: number | null = null;
    for (const off of [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 6, -6]) {
      if (decorOk(want + off, f.w)) { at = want + off; break; }
    }
    if (at === null) continue; // 걸 자리가 없으면 걸지 않는다 — 겹쳐 거는 것보다 낫다
    for (let dc = 0; dc < f.w; dc += 1) decorTaken.add(at + dc);
    decor.push(hang(d.kind, inner.x + at * TILE, faceY));
  }

  // 5. 문에서 닿는가 — 가정하지 않고 훑어서 확인한다
  const walkable = (c: number, r: number) =>
    c >= 0 && c < cols && r >= 0 && r < rows && grid[cellIndex(c, r)] === EMPTY;
  const reached = new Set<number>();
  const frontier: number[] = [];
  for (const d of doorCells) if (walkable(d.c, d.r)) { reached.add(cellIndex(d.c, d.r)); frontier.push(cellIndex(d.c, d.r)); }
  while (frontier.length) {
    const cur = frontier.shift() as number;
    const cc = cur % cols;
    const rr = (cur - cc) / cols;
    for (const [a, b] of [[cc - 1, rr], [cc + 1, rr], [cc, rr - 1], [cc, rr + 1]]) {
      if (!walkable(a, b)) continue;
      const n = cellIndex(a, b);
      if (reached.has(n)) continue;
      reached.add(n);
      frontier.push(n);
    }
  }
  const spotOk = (c: number, r: number) => walkable(c, r) && reached.has(cellIndex(c, r));
  if (process.env.NODE_ENV !== "production") {
    // 책상 앞 두 칸이 다 비어야 한다 — 사람은 책상 한가운데 앞에 서고, 그 발은 두 칸에 걸친다.
    if (!spotOk(sc, frontRow) || !spotOk(sc + 1, frontRow)) {
      throw new Error(`[office] ${room.id}/${room.scene} 시작 지점 앞이 막혔다\n${dump()}`);
    }
    for (const sp of spec.spots) {
      if (!spotOk(C(sp.c), R(sp.r))) throw new Error(`[office] ${room.id}/${room.scene} 서는 자리 (${sp.c},${sp.r}) 가 막혔다\n${dump()}`);
    }
  }

  // 6. 서는 자리 — 장면의 자리, 그리고 모자라면 무리 곁에
  const taken = new Set<number>();
  taken.add(cellIndex(sc, frontRow));
  taken.add(cellIndex(sc + 1, frontRow));
  const standing: StandSpot[] = [];
  const at = (c: number, r: number, face: Dir): StandSpot => ({
    x: inner.x + c * TILE + TILE / 2,
    y: inner.y + r * TILE + TILE * 0.9,
    face,
    cell: { c, r },
  });
  for (const sp of spec.spots) {
    const r = R(sp.r);
    const c = C(sp.c);
    if (!spotOk(c, r) || taken.has(cellIndex(c, r))) continue;
    taken.add(cellIndex(c, r));
    standing.push(at(c, r, F(sp.face)));
  }
  // 넉넉히 — 서 있는 사람이 오갈 곳도 있어야 한다
  const want = Math.max(crewCount + 2, standing.length);
  while (standing.length < want) {
    let best: { c: number; r: number; d: number } | null = null;
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        if (!spotOk(c, r) || taken.has(cellIndex(c, r))) continue;
        if (doorCells.some((d) => Math.abs(d.c - c) + Math.abs(d.r - r) < 2)) continue; // 문 앞은 비운다
        // 이미 선 사람 가운데 가장 가까운 이와의 거리 — 가까울수록 좋되 붙지는 않는다
        let near = Infinity;
        for (const s of standing) near = Math.min(near, Math.max(Math.abs(s.cell.c - c), Math.abs(s.cell.r - r)));
        const d = near < 1 ? Infinity : near;
        if (!best || d < best.d || (d === best.d && (r < best.r || (r === best.r && c < best.c)))) best = { c, r, d };
      }
    }
    if (!best || best.d === Infinity) break;
    taken.add(cellIndex(best.c, best.r));
    // 곁에 선 사람 쪽을 본다
    let nearest = standing[0];
    let nd = Infinity;
    for (const s of standing) {
      const d = Math.hypot(s.cell.c - best.c, s.cell.r - best.r);
      if (d < nd) { nd = d; nearest = s; }
    }
    const dx = nearest ? nearest.cell.c - best.c : 0;
    const dy = nearest ? nearest.cell.r - best.r : 1;
    const face: Dir = Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? "right" : "left") : dy >= 0 ? "down" : "up";
    standing.push(at(best.c, best.r, face));
  }

  // 7. 벽
  const walls = wallPieces(room, grid);

  // 8. 바닥 — 칸마다 다른 바닥을 반영해 줄로 깐다(칸마다 div 를 두지 않는다). 벽 선까지 이어지고 컷은 비운다.
  const tileAt = new Map<number, FloorKey>();
  for (const t of spec.tiles ?? []) {
    const c = C(t.c), r = R(t.r);
    if (c < 0 || c >= cols || r < 0 || r >= rows || t.floor === spec.floor) continue;
    if (grid[cellIndex(c, r)] === SOLID) continue;
    tileAt.set(cellIndex(c, r), t.floor);
  }
  const floors = floorRuns(cols, rows, grid, inner, spec.floor, tileAt);
  return { room, scene: room.scene, start, props, decor, standing, walls, cuts, floors, grid };
}

// ── 벽 — 윗면·앞면 칸 분류와 오토타일 ─────────────────────────────
//
// RPG Maker 식. 벽 칸은 두 종류다: 윗면(top, 검은 천장에 밝은 테두리)과 앞면(face, 남쪽에서 보이는 벽면).
//  - 고리 칸(방 둘레 한 칸, 복도 둘레)은 윗면. 문 칸은 뚫려 있다.
//  - 위 벽의 앞면은 그 아래 한 줄(앞면 줄)에 선다: 방은 위 고리 아래, 복도는 위 고리(북쪽 방 문 벽) 아래.
//    문 아래 앞면 칸은 뚫려 있다(문 통로 = 고리 칸 + 앞면 칸).
//  - 도려낸 칸(컷)은 윗면이되 바로 아래가 바닥이면 앞면(두꺼운 벽의 남쪽 면). 앞면 줄 칸 아래가 컷이면 그 칸은 윗면.
//  - 그림은 이웃으로 정한다: 윗면은 8방향 이웃 윗면 마스크(N1·NE2·E4·SE8·S16·SW32·W64·NW128) → WALL_TOP_VARIANT,
//    앞면은 좌·상·우·하 이웃 앞면 비트(1·2·4·8) → WALL_FACE_VARIANT.
//  - 층 전체를 한 격자에서 분류하므로 방 사이 벽·복도 벽의 테두리가 저절로 이어진다. 칸의 스타일은 먼저 차지한 방의 것.

interface WallCells {
  top: Map<string, WallStyleKey>;
  face: Map<string, WallStyleKey>;
}
const ck = (cx: number, cy: number) => `${cx},${cy}`;

/** 방 하나의 고리·앞면 줄·컷을 분류해 넣는다. 이미 차지된 칸(옆방과 나눠 쓰는 것)은 두 번 넣지 않는다. */
function addRoomWalls(cells: WallCells, room: Pick<Room, "x" | "y" | "cols" | "rows" | "side" | "doorC">, grid: Uint8Array, style: WallStyleKey) {
  const { cols, rows } = room;
  const [d0, d1] = roomDoorCols(room);
  const north = room.side === "north";
  const ox = room.x / TILE, oy = room.y / TILE;
  const solid = (c: number, r: number) => c >= 0 && c < cols && r >= 0 && r < rows && grid[r * cols + c] === SOLID;
  const floorAt = (c: number, r: number) => c >= 0 && c < cols && r >= 0 && r < rows && grid[r * cols + c] !== SOLID;
  const claim = (map: Map<string, WallStyleKey>, key: string) => { if (!cells.top.has(key) && !cells.face.has(key)) map.set(key, style); };
  const W = cols + 2, H = rows + 3; // 위 고리 · 앞면 줄 · 안쪽 rows 줄 · 아래 고리
  for (let R = 0; R < H; R += 1) {
    for (let Cc = 0; Cc < W; Cc += 1) {
      const c = Cc - 1, r = R - 2, key = ck(ox + Cc, oy + R);
      const doorCol = c === d0 || c === d1;
      if (R === 0) { if (!(!north && doorCol)) claim(cells.top, key); continue; }
      if (R === H - 1) { if (!(north && doorCol)) claim(cells.top, key); continue; }
      if (Cc === 0 || Cc === W - 1) { claim(cells.top, key); continue; }
      if (R === 1) { if (!north && doorCol) continue; claim(solid(c, 0) ? cells.top : cells.face, key); continue; }
      if (solid(c, r)) claim(floorAt(c, r + 1) ? cells.face : cells.top, key);
    }
  }
}

/** 분류된 칸 → 벽 조각(오토타일 변형까지) */
function wallPiecesOf(cells: WallCells): WallPiece[] {
  const parse = (k: string) => k.split(",").map(Number) as [number, number];
  const out: WallPiece[] = [];
  for (const [k, style] of cells.top) {
    const [cx, cy] = parse(k);
    const has = (dx: number, dy: number) => cells.top.has(ck(cx + dx, cy + dy));
    const mask = (has(0, -1) ? 1 : 0) | (has(1, -1) ? 2 : 0) | (has(1, 0) ? 4 : 0) | (has(1, 1) ? 8 : 0) | (has(0, 1) ? 16 : 0) | (has(-1, 1) ? 32 : 0) | (has(-1, 0) ? 64 : 0) | (has(-1, -1) ? 128 : 0);
    out.push({ x: cx * TILE, y: cy * TILE, w: TILE, h: TILE, kind: "top", variant: WALL_TOP_VARIANT[mask], style });
  }
  for (const [k, style] of cells.face) {
    const [cx, cy] = parse(k);
    const has = (dx: number, dy: number) => cells.face.has(ck(cx + dx, cy + dy));
    const bits = (has(-1, 0) ? 1 : 0) | (has(0, -1) ? 2 : 0) | (has(1, 0) ? 4 : 0) | (has(0, 1) ? 8 : 0);
    out.push({ x: cx * TILE, y: cy * TILE, w: TILE, h: TILE, kind: "face", variant: WALL_FACE_VARIANT[bits], style });
  }
  out.sort((a, b) => a.y - b.y || a.x - b.x || a.kind.localeCompare(b.kind));
  return out;
}

/** 방 하나의 벽 — 편집기가 방을 혼자 그릴 때. 사무실에서는 층 전체(buildFloor → floorWalls)가 이것을 대신한다. */
export function wallPieces(room: Pick<Room, "x" | "y" | "cols" | "rows" | "side" | "doorC">, grid: Uint8Array, style: WallStyleKey = WALL_DEFAULT): WallPiece[] {
  const cells: WallCells = { top: new Map(), face: new Map() };
  addRoomWalls(cells, room, grid, style);
  return wallPiecesOf(cells);
}

/** 컷만 반영한 칸 그리드 — 벽 분류에는 이것으로 충분하다(소품은 벽과 무관). layoutRoom 과 같은 뒤집기 규칙. */
export function roomSolidGrid(room: Pick<Room, "cols" | "rows" | "side" | "mirror" | "spec">): Uint8Array {
  const { cols, rows } = room;
  const grid = new Uint8Array(cols * rows);
  const north = room.side === "north";
  for (const cut of room.spec.cuts ?? []) {
    const c0 = room.mirror ? cols - cut.c - cut.w : cut.c, r0 = north ? cut.r : rows - cut.r - cut.h;
    for (let dr = 0; dr < cut.h; dr += 1) for (let dc = 0; dc < cut.w; dc += 1) {
      const c = c0 + dc, r = r0 + dr;
      if (c >= 0 && c < cols && r >= 0 && r < rows) grid[r * cols + c] = SOLID;
    }
  }
  return grid;
}

/** 방의 벽 스타일 — 장면이 고른 것, 없으면 기본 */
export function wallStyleOf(spec: Pick<SceneSpec, "wall">): WallStyleKey {
  return (spec.wall as WallStyleKey | undefined) ?? WALL_DEFAULT;
}

/** 층 전체의 벽 — 모든 방의 고리·앞면·컷과 복도 고리·앞면 줄을 한 격자에서 분류한다 */
function floorWalls(rooms: Room[], corridor: Floor["corridor"], x0: number, x1: number): WallPiece[] {
  const cells: WallCells = { top: new Map(), face: new Map() };
  const open = new Set<string>();
  for (const r of rooms) { const g = doorGapOf(r); for (let i = 0; i < 2; i += 1) { open.add(ck(g.x / TILE + i, g.y / TILE)); open.add(ck(g.x / TILE + i, g.y / TILE + 1)); } }
  for (const room of rooms) addRoomWalls(cells, room, roomSolidGrid(room), wallStyleOf(room.spec));
  const cyTop = corridor.top / TILE - 1, cyFace = corridor.top / TILE, cyBot = corridor.bottom / TILE;
  const cx0 = x0 / TILE, cx1 = x1 / TILE;
  const claim = (map: Map<string, WallStyleKey>, key: string, style: WallStyleKey) => { if (!open.has(key) && !cells.top.has(key) && !cells.face.has(key)) map.set(key, style); };
  for (let cx = cx0; cx < cx1; cx += 1) { claim(cells.top, ck(cx, cyTop), WALL_DEFAULT); claim(cells.top, ck(cx, cyBot), WALL_DEFAULT); }
  for (let cy = cyTop; cy <= cyBot; cy += 1) { claim(cells.top, ck(cx0, cy), WALL_DEFAULT); claim(cells.top, ck(cx1 - 1, cy), WALL_DEFAULT); }
  // 복도 앞면 줄 — 위 칸(방의 문 벽이든 복도 벽이든)의 스타일을 따른다
  for (let cx = cx0 + 1; cx < cx1 - 1; cx += 1) claim(cells.face, ck(cx, cyFace), cells.top.get(ck(cx, cyTop)) ?? WALL_DEFAULT);
  return wallPiecesOf(cells);
}

/** 바닥 칸 줄 — 도려낸 칸은 비우고, 같은 줄에서 바닥이 같은 칸은 한 사각형으로 잇는다. */
export function floorRuns(cols: number, rows: number, grid: Uint8Array, inner: { x: number; y: number }, base: FloorKey, tileAt: Map<number, FloorKey> = new Map()): FloorRun[] {
  const solid = (c: number, r: number) => grid[r * cols + c] === SOLID;
  const keyAt = (c: number, r: number) => tileAt.get(r * cols + c) ?? base;
  const out: FloorRun[] = [];
  for (let r = 0; r < rows; r += 1) {
    let c = 0;
    while (c < cols) {
      if (solid(c, r)) { c += 1; continue; }
      const f = keyAt(c, r);
      let end = c;
      while (end + 1 < cols && !solid(end + 1, r) && keyAt(end + 1, r) === f) end += 1;
      out.push({ x: inner.x + c * TILE, y: inner.y + r * TILE, w: (end - c + 1) * TILE, h: TILE, floor: f });
      c = end + 1;
    }
  }
  return out;
}

/** 걸어 다닐 수 있는 자리 (월드 좌표 사각형들의 합집합).
 *
 *  복도, 방 안쪽의 빈 칸, 그리고 그 둘을 잇는 문 칸. 벽 위는 걸을 수 없다. */
export function walkableRects(floor: Floor, layouts: Map<string, RoomLayout>): Rect[] {
  // 복도 — 위 벽의 앞면 한 줄은 못 걷는다(문 아래는 문 통로가 잇는다)
  const out: Rect[] = [
    { x: floor.corridor.left, y: floor.corridor.top + FACE, w: floor.corridor.right - floor.corridor.left, h: floor.corridor.bottom - floor.corridor.top - FACE },
  ];
  for (const room of floor.rooms) {
    const inner = innerOrigin(room);
    // 방 안은 **가구도 벽도 없는 칸만** 걷는다. 배치할 때 판 통로가 그대로 다니는 길이 된다.
    const grid = layouts.get(room.id)?.grid;
    for (let r = 0; r < room.rows; r += 1) {
      for (let c = 0; c < room.cols; c += 1) {
        const v = grid ? grid[r * room.cols + c] : EMPTY;
        if (v !== EMPTY) continue;
        out.push({ x: inner.x + c * TILE, y: inner.y + r * TILE, w: TILE, h: TILE });
      }
    }
    out.push(doorGapOf(room));
  }
  return out;
}

/** 아바타가 이 자리에 설 수 있는가.
 *
 *  가운데 점 하나가 아니라 몸 상자의 네 귀퉁이를 본다. 점만 보면 벽 모서리를 스치듯
 *  통과해 버리고, 각 사각형을 반지름만큼 줄여서 보면 사각형이 맞닿는 자리(복도와 문틈
 *  사이)에 걸을 수 없는 틈이 생긴다. 복도의 화분(blocked)은 밟지 못한다. */
export function canStand(x: number, y: number, rects: Rect[], radius = 11, blocked: Rect[] = []): boolean {
  const inside = (px: number, py: number) =>
    rects.some((r) => px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h);
  const corners: [number, number][] = [
    [x - radius, y - radius],
    [x + radius, y - radius],
    [x - radius, y + radius],
    [x + radius, y + radius],
  ];
  if (!corners.every(([px, py]) => inside(px, py))) return false;
  return !blocked.some((b) => x + radius > b.x && x - radius < b.x + b.w && y + radius > b.y && y - radius < b.y + b.h);
}

/** 격자 길찾기 — 걷는 사각형(칸 단위)을 칸 집합으로 보고 너비 우선 탐색한다.
 *
 *  결과는 꺾이는 칸의 가운데 점들과 목적지. 첫 칸(지금 자리)은 빼서 지금 있는 자리에서 곧장 출발한다. 출발·도착 칸이 걷는 칸이
 *  아니거나 길이 없으면 null. 아바타의 자리 걷기와 동료의 자리 옮기기가 둘 다 이것을 쓴다 — 직선으로 가면 책상·소파·도려낸
 *  모서리를 뚫고 지나간다. 같은 rects 배열로는 칸 집합을 다시 만들지 않는다. */
const cellSetOf = new WeakMap<Rect[], Set<string>>();
function walkCells(rects: Rect[]): Set<string> {
  let set = cellSetOf.get(rects);
  if (set) return set;
  set = new Set<string>();
  for (const r of rects) {
    const c0 = Math.round(r.x / TILE), c1 = Math.round((r.x + r.w) / TILE), r0 = Math.round(r.y / TILE), r1 = Math.round((r.y + r.h) / TILE);
    for (let cy = r0; cy < r1; cy += 1) for (let cx = c0; cx < c1; cx += 1) set.add(`${cx},${cy}`);
  }
  cellSetOf.set(rects, set);
  return set;
}
export function findPath(rects: Rect[], from: { x: number; y: number }, to: { x: number; y: number }): { x: number; y: number }[] | null {
  const cells = walkCells(rects);
  const sx = Math.floor(from.x / TILE), sy = Math.floor(from.y / TILE), tx = Math.floor(to.x / TILE), ty = Math.floor(to.y / TILE);
  const goal = `${tx},${ty}`, startKey = `${sx},${sy}`;
  if (!cells.has(goal) || !cells.has(startKey)) return null;
  if (startKey === goal) return [to];
  const prev = new Map<string, string>([[startKey, ""]]);
  const queue = [startKey];
  for (let i = 0; i < queue.length; i += 1) {
    const k = queue[i];
    if (k === goal) break;
    const [cx, cy] = k.split(",").map(Number);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const n = `${cx + dx},${cy + dy}`;
      if (!cells.has(n) || prev.has(n)) continue;
      prev.set(n, k);
      queue.push(n);
    }
  }
  if (!prev.has(goal)) return null;
  const chain: [number, number][] = [];
  for (let k = goal; k; k = prev.get(k) ?? "") chain.push(k.split(",").map(Number) as [number, number]);
  chain.reverse();
  const out: { x: number; y: number }[] = [];
  for (let i = 1; i < chain.length - 1; i += 1) {
    const [ax, ay] = chain[i - 1], [bx, by] = chain[i], [cx, cy] = chain[i + 1];
    if (bx - ax !== cx - bx || by - ay !== cy - by) out.push({ x: bx * TILE + TILE / 2, y: by * TILE + TILE / 2 });
  }
  out.push(to);
  return out;
}

/** 이 점이 어느 방 안인가. 복도면 null. */
export function roomAt(x: number, y: number, floor: Floor): Room | null {
  for (const room of floor.rooms) {
    const inner = innerOrigin(room);
    if (
      x >= inner.x &&
      x <= inner.x + room.cols * TILE &&
      y >= inner.y &&
      y <= inner.y + room.rows * TILE
    ) {
      return room;
    }
  }
  return null;
}

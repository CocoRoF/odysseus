/** 편집기의 상태 — 장면 하나와 되돌리기 이력. 순수 함수뿐이라 노드 테스트로 돈다.
 *
 *  장면(SceneSpec)은 불변으로 다룬다: 모든 조작이 새 장면을 돌려주고, 리듀서가 이력에 쌓는다.
 *  붓으로 끌며 칠하는 것은 한 획이 한 번의 되돌리기여야 하므로 `coalesce` 키가 같은 연속 커밋은
 *  이력에 한 칸만 차지한다.
 */
import type { Dir } from "@/lib/people";
import { WALL_DEFAULT, type FloorKey, type WallStyleKey } from "../atlas.ts";
import { SCENE_LIMITS, doorColsOf, migrateScene, type SceneSpec } from "../scenes.ts";
import { footOf } from "./catalog.ts";

export interface EditorState {
  spec: SceneSpec;
  past: SceneSpec[];
  future: SceneSpec[];
  /** 마지막 커밋의 합치기 키 — 같은 키가 이어지면 이력에 새 칸을 만들지 않는다 */
  lastKey: string | null;
  /** 마지막으로 저장(또는 불러온) 장면 — 되돌리기로 여기까지 돌아오면 다시 깨끗하다 */
  saved: SceneSpec;
  /** 저장된 것과 다른가 */
  dirty: boolean;
}

export type EditorAction =
  | { type: "load"; spec: SceneSpec }
  | { type: "commit"; spec: SceneSpec; coalesce?: string }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "saved" };

const HISTORY_MAX = 200;

export function initialState(spec: SceneSpec): EditorState {
  const n = normalize(spec);
  return { spec: n, past: [], future: [], lastKey: null, saved: n, dirty: false };
}

export function reduce(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case "load":
      return initialState(action.spec);
    case "commit": {
      if (action.spec === state.spec) return state;
      const merge = action.coalesce !== undefined && action.coalesce === state.lastKey;
      const past = merge ? state.past : [...state.past, state.spec].slice(-HISTORY_MAX);
      return { ...state, spec: action.spec, past, future: [], lastKey: action.coalesce ?? null, dirty: action.spec !== state.saved };
    }
    case "undo": {
      if (!state.past.length) return state;
      const prev = state.past[state.past.length - 1];
      // 이력의 장면은 같은 객체다 — 저장했던 그 객체로 돌아오면 다시 깨끗하다
      return { ...state, spec: prev, past: state.past.slice(0, -1), future: [state.spec, ...state.future], lastKey: null, dirty: prev !== state.saved };
    }
    case "redo": {
      if (!state.future.length) return state;
      const [next, ...rest] = state.future;
      return { ...state, spec: next, past: [...state.past, state.spec], future: rest, lastKey: null, dirty: next !== state.saved };
    }
    case "saved":
      return { ...state, saved: state.spec, dirty: false, lastKey: null };
  }
}

// ── 장면 조작 (전부 새 장면을 돌려준다) ─────────────────────────────

export interface Cell {
  c: number;
  r: number;
}

/** 저장된 장면을 편집할 모양으로 — 컷은 1×1 칸으로 풀고, 없는 배열은 채운다. */
export function normalize(spec: SceneSpec): SceneSpec {
  const cuts: { c: number; r: number; w: number; h: number }[] = [];
  const seen = new Set<string>();
  for (const cut of spec.cuts ?? []) {
    for (let dr = 0; dr < cut.h; dr += 1) for (let dc = 0; dc < cut.w; dc += 1) {
      const k = `${cut.c + dc},${cut.r + dr}`;
      if (seen.has(k)) continue;
      seen.add(k);
      cuts.push({ c: cut.c + dc, r: cut.r + dr, w: 1, h: 1 });
    }
  }
  return {
    ...spec,
    // API 는 문 위치를 null 로 돌려줄 수 있다 — 편집기 안에서는 "없음" 하나뿐이다
    door: typeof spec.door === "number" ? spec.door : undefined,
    tiles: [...(spec.tiles ?? [])],
    cuts,
    props: [...migrateScene(spec).props],
    decor: [...migrateScene(spec).decor],
    spots: [...spec.spots],
    start: { ...spec.start },
  };
}

/** 저장할 모양으로 — 기본 바닥과 같은 타일, 방 밖의 것은 뺀다. 컷은 1×1 그대로(배치기가 안다). */
export function compact(spec: SceneSpec): SceneSpec {
  const inside = (c: number, r: number) => c >= 0 && c < spec.cols && r >= 0 && r < spec.rows;
  return {
    ...spec,
    tiles: (spec.tiles ?? []).filter((t) => inside(t.c, t.r) && t.floor !== spec.floor),
    cuts: (spec.cuts ?? []).filter((k) => inside(k.c, k.r)),
    door: typeof spec.door !== "number" || spec.door === doorColsOf({ cols: spec.cols })[0] ? undefined : spec.door,
  };
}

export const isCut = (spec: SceneSpec, c: number, r: number) => (spec.cuts ?? []).some((k) => k.c === c && k.r === r);
export const tileAt = (spec: SceneSpec, c: number, r: number): FloorKey | undefined => (spec.tiles ?? []).find((t) => t.c === c && t.r === r)?.floor;
export const inBounds = (spec: SceneSpec, c: number, r: number) => Number.isInteger(c) && Number.isInteger(r) && c >= 0 && c < spec.cols && r >= 0 && r < spec.rows;

/** 칸에 바닥을 칠한다. null 이면 기본 바닥으로 되돌린다. */
export function paintTile(spec: SceneSpec, c: number, r: number, floor: FloorKey | null): SceneSpec {
  if (!inBounds(spec, c, r)) return spec;
  const rest = (spec.tiles ?? []).filter((t) => !(t.c === c && t.r === r));
  const same = tileAt(spec, c, r) === (floor ?? undefined) || (floor === spec.floor && tileAt(spec, c, r) === undefined);
  if (same) return spec;
  return { ...spec, tiles: floor && floor !== spec.floor ? [...rest, { c, r, floor }] : rest };
}

/** 칸을 벽으로(on) 또는 바닥으로(off). 문 칸은 벽이 되지 않는다. */
export function setWall(spec: SceneSpec, c: number, r: number, on: boolean): SceneSpec {
  if (!inBounds(spec, c, r)) return spec;
  const [d0, d1] = doorColsOf(spec);
  if (on && r === spec.rows - 1 && (c === d0 || c === d1)) return spec;
  const has = isCut(spec, c, r);
  if (has === on) return spec;
  const cuts = on ? [...(spec.cuts ?? []), { c, r, w: 1, h: 1 }] : (spec.cuts ?? []).filter((k) => !(k.c === c && k.r === r));
  // 벽이 된 칸의 바닥 타일은 뜻이 없다
  const tiles = on ? (spec.tiles ?? []).filter((t) => !(t.c === c && t.r === r)) : spec.tiles;
  return { ...spec, cuts, tiles };
}

export type Edge = "top" | "left" | "right" | "bottom";

/** 둘레 벽 한 칸을 허문다 — 방이 그쪽으로 한 줄(한 칸) 넓어지고, 새 줄에서는 **누른 칸만** 바닥이 된다. 나머지는 벽 칸으로
 *  남으므로 겉모습은 그 칸만 뚫린 것과 같다. 위·왼쪽으로 넓어지면 안의 것이 모두 한 칸씩 밀린다.
 *
 *  문은 제자리에 박아 둔다 — 가운데 문이던 방도 너비가 바뀌면 가운데가 옮겨 가기 때문이다. 아래로 넓어지면 문 칸은 새 아래
 *  줄에서도 열어 둔다(문은 언제나 마지막 줄이다). 더 넓힐 수 없거나(최대 크기) 누른 칸이 벽 길이 밖이면 null. */
export function openEdge(spec: SceneSpec, edge: Edge, at: number): { spec: SceneSpec; cell: Cell } | null {
  const { cols, rows } = spec;
  const alongCols = edge === "top" || edge === "bottom";
  if (!Number.isInteger(at) || at < 0 || at >= (alongCols ? cols : rows)) return null;
  if (alongCols ? rows >= SCENE_LIMITS.maxRows : cols >= SCENE_LIMITS.maxCols) return null;
  const dc = edge === "left" ? 1 : 0, dr = edge === "top" ? 1 : 0;
  const nc = alongCols ? cols : cols + 1, nr = alongCols ? rows + 1 : rows;
  const door = doorColsOf(spec)[0] + dc;
  const shift = <T extends { c: number; r: number }>(x: T): T => (dc || dr ? { ...x, c: x.c + dc, r: x.r + dr } : x);
  const cell: Cell = edge === "top" ? { c: at, r: 0 } : edge === "bottom" ? { c: at, r: rows } : edge === "left" ? { c: 0, r: at } : { c: cols, r: at };
  const fresh: { c: number; r: number; w: number; h: number }[] = [];
  if (alongCols) {
    for (let c = 0; c < nc; c += 1) {
      if (c === at || (edge === "bottom" && (c === door || c === door + 1))) continue;
      fresh.push({ c, r: cell.r, w: 1, h: 1 });
    }
  } else {
    for (let r = 0; r < nr; r += 1) if (r !== at) fresh.push({ c: cell.c, r, w: 1, h: 1 });
  }
  return {
    cell,
    spec: {
      ...spec,
      cols: nc,
      rows: nr,
      door,
      tiles: (spec.tiles ?? []).map(shift),
      cuts: [...(spec.cuts ?? []).map(shift), ...fresh],
      props: spec.props.map(shift),
      decor: dc ? spec.decor.map((d) => ({ ...d, c: d.c + dc })) : spec.decor,
      spots: spec.spots.map(shift),
      start: shift(spec.start),
    },
  };
}

/** 사각형 안의 모든 칸에 같은 조작 */
export function fillRect(spec: SceneSpec, a: Cell, b: Cell, op: (s: SceneSpec, c: number, r: number) => SceneSpec): SceneSpec {
  let out = spec;
  for (let r = Math.min(a.r, b.r); r <= Math.max(a.r, b.r); r += 1) {
    for (let c = Math.min(a.c, b.c); c <= Math.max(a.c, b.c); c += 1) out = op(out, c, r);
  }
  return out;
}

/** 벽 스타일 — 기본이면 필드를 비운다(저장 모양이 짧다) */
export function setWallStyle(spec: SceneSpec, wall: WallStyleKey): SceneSpec {
  if ((spec.wall ?? WALL_DEFAULT) === wall) return spec;
  const { wall: _old, ...rest } = spec;
  return wall === WALL_DEFAULT ? rest : { ...rest, wall };
}

export function setBaseFloor(spec: SceneSpec, floor: FloorKey): SceneSpec {
  if (floor === spec.floor) return spec;
  // 새 기본과 같은 타일은 빠지고, 옛 기본을 그대로 두고 싶은 칸은 없다 — 기본을 바꾸면 온 방이 바뀐다
  return { ...spec, floor, tiles: (spec.tiles ?? []).filter((t) => t.floor !== floor) };
}

export function setLabel(spec: SceneSpec, label: string): SceneSpec {
  return label === spec.label ? spec : { ...spec, label };
}

/** 크기를 바꾼다. 방 밖으로 나가는 것은 버리고, 시작 지점·문은 안으로 끌어온다. */
export function resize(spec: SceneSpec, cols: number, rows: number): SceneSpec {
  cols = Math.max(SCENE_LIMITS.minCols, Math.min(SCENE_LIMITS.maxCols, Math.round(cols)));
  rows = Math.max(SCENE_LIMITS.minRows, Math.min(SCENE_LIMITS.maxRows, Math.round(rows)));
  if (cols === spec.cols && rows === spec.rows) return spec;
  const inside = (c: number, r: number) => c >= 0 && c < cols && r >= 0 && r < rows;
  const fits = (p: { kind: string; c: number; r: number }) => {
    const f = footOf(p.kind);
    return f ? inside(p.c, p.r) && inside(p.c + f.w - 1, p.r + f.h - 1) : inside(p.c, p.r);
  };
  const start = { c: Math.min(spec.start.c, cols - 2), r: Math.min(spec.start.r, rows - 2) };
  const door = typeof spec.door === "number" ? Math.min(spec.door, cols - 2) : undefined;
  return {
    ...spec,
    cols,
    rows,
    tiles: (spec.tiles ?? []).filter((t) => inside(t.c, t.r)),
    cuts: (spec.cuts ?? []).filter((k) => inside(k.c, k.r)),
    props: spec.props.filter(fits),
    decor: spec.decor.filter((d) => {
      const f = footOf(d.kind);
      return d.c >= 0 && d.c + (f?.w ?? 1) <= cols;
    }),
    spots: spec.spots.filter((s) => inside(s.c, s.r)),
    start,
    door,
  };
}

export function placeProp(spec: SceneSpec, kind: string, c: number, r: number): SceneSpec {
  const f = footOf(kind);
  if (!f || f.wall) return spec;
  if (!inBounds(spec, c, r) || !inBounds(spec, c + f.w - 1, r + f.h - 1)) return spec;
  return { ...spec, props: [...spec.props, { kind: kind as SceneSpec["props"][number]["kind"], c, r }] };
}

export function moveProp(spec: SceneSpec, index: number, c: number, r: number): SceneSpec {
  const p = spec.props[index];
  if (!p) return spec;
  const f = footOf(p.kind);
  const w = f?.w ?? 1, h = f?.h ?? 1;
  if (!inBounds(spec, c, r) || !inBounds(spec, c + w - 1, r + h - 1)) return spec;
  if (p.c === c && p.r === r) return spec;
  return { ...spec, props: spec.props.map((x, i) => (i === index ? { ...x, c, r } : x)) };
}

export function removeProp(spec: SceneSpec, index: number): SceneSpec {
  if (!spec.props[index]) return spec;
  return { ...spec, props: spec.props.filter((_, i) => i !== index) };
}

export function placeDecor(spec: SceneSpec, kind: string, c: number): SceneSpec {
  const f = footOf(kind);
  if (!f || !f.wall) return spec;
  if (!Number.isInteger(c) || c < 0 || c + f.w > spec.cols) return spec;
  return { ...spec, decor: [...spec.decor, { kind: kind as SceneSpec["decor"][number]["kind"], c }] };
}

export function moveDecor(spec: SceneSpec, index: number, c: number): SceneSpec {
  const d = spec.decor[index];
  if (!d) return spec;
  const f = footOf(d.kind);
  if (!Number.isInteger(c) || c < 0 || c + (f?.w ?? 1) > spec.cols || d.c === c) return spec;
  return { ...spec, decor: spec.decor.map((x, i) => (i === index ? { ...x, c } : x)) };
}

export function removeDecor(spec: SceneSpec, index: number): SceneSpec {
  if (!spec.decor[index]) return spec;
  return { ...spec, decor: spec.decor.filter((_, i) => i !== index) };
}

export function addSpot(spec: SceneSpec, c: number, r: number, face: Dir = "down"): SceneSpec {
  if (!inBounds(spec, c, r)) return spec;
  return { ...spec, spots: [...spec.spots, { c, r, face }] };
}

export function moveSpot(spec: SceneSpec, index: number, c: number, r: number): SceneSpec {
  const s = spec.spots[index];
  if (!s || !inBounds(spec, c, r) || (s.c === c && s.r === r)) return spec;
  return { ...spec, spots: spec.spots.map((x, i) => (i === index ? { ...x, c, r } : x)) };
}

export function faceSpot(spec: SceneSpec, index: number, face: Dir): SceneSpec {
  const s = spec.spots[index];
  if (!s || s.face === face) return spec;
  return { ...spec, spots: spec.spots.map((x, i) => (i === index ? { ...x, face } : x)) };
}

export function removeSpot(spec: SceneSpec, index: number): SceneSpec {
  if (!spec.spots[index]) return spec;
  return { ...spec, spots: spec.spots.filter((_, i) => i !== index) };
}

/** 스탠딩 데스크(2×1)의 왼쪽 칸 — 앞 줄이 있어야 하므로 마지막 줄에는 두지 않는다 */
export function setStart(spec: SceneSpec, c: number, r: number): SceneSpec {
  if (!inBounds(spec, c, r) || !inBounds(spec, c + 1, r)) return spec;
  if (r >= spec.rows - 1) return spec;
  if (spec.start.c === c && spec.start.r === r) return spec;
  return { ...spec, start: { c, r } };
}

/** 문의 왼쪽 칸(아래 줄, 두 칸). 벽 칸 위로는 옮길 수 없다. */
export function setDoor(spec: SceneSpec, c: number): SceneSpec {
  c = Math.max(0, Math.min(spec.cols - 2, Math.round(c)));
  if (isCut(spec, c, spec.rows - 1) || isCut(spec, c + 1, spec.rows - 1)) return spec;
  if (doorColsOf(spec)[0] === c) return spec;
  return { ...spec, door: c };
}

export const DIRS_CYCLE: Dir[] = ["down", "left", "up", "right"];
export function nextDir(d: Dir): Dir {
  return DIRS_CYCLE[(DIRS_CYCLE.indexOf(d) + 1) % DIRS_CYCLE.length];
}

/** 빈 방 — 새 프리셋의 출발점 */
export function blankScene(id: string, label: string): SceneSpec {
  return {
    id,
    label,
    cols: 8,
    rows: 6,
    floor: "slate",
    tiles: [],
    cuts: [],
    props: [],
    decor: [],
    spots: [],
    start: { c: 3, r: 3 },
  };
}

/** 이 칸을 차지한 것 — 위에 그려지는 것(발끝 y 가 큰 것)이 먼저다 */
export type Hit =
  | { kind: "prop"; index: number }
  | { kind: "decor"; index: number }
  | { kind: "spot"; index: number }
  | { kind: "start" }
  | null;

export function hitTest(spec: SceneSpec, c: number, r: number): Hit {
  // 사람이 소품 위에 겹쳐 보이면 사람이 먼저 잡힌다
  for (let i = spec.spots.length - 1; i >= 0; i -= 1) if (spec.spots[i].c === c && spec.spots[i].r === r) return { kind: "spot", index: i };
  if (spec.start.r === r && (spec.start.c === c || spec.start.c + 1 === c)) return { kind: "start" };
  let best: { index: number; foot: number } | null = null;
  spec.props.forEach((p, index) => {
    const f = footOf(p.kind);
    const w = f?.w ?? 1, h = f?.h ?? 1;
    // 그림이 위로 솟는 소품은 그 위 칸을 눌러도 잡힌다
    const rise = f?.rise ?? 0;
    if (c >= p.c && c < p.c + w && r >= p.r - rise && r < p.r + h) {
      const foot = p.r + h;
      if (!best || foot >= best.foot) best = { index, foot };
    }
  });
  if (best) return { kind: "prop", index: (best as { index: number }).index };
  return null;
}

/** 위쪽 벽(장면 좌표에서 r = -1)의 칸을 눌렀을 때 — 벽걸이 */
export function hitDecor(spec: SceneSpec, c: number): Hit {
  for (let i = spec.decor.length - 1; i >= 0; i -= 1) {
    const d = spec.decor[i];
    const w = footOf(d.kind)?.w ?? 1;
    if (c >= d.c && c < d.c + w) return { kind: "decor", index: i };
  }
  return null;
}

/** 키 순서에 무관한 JSON — 서버(pydantic)가 돌려주는 객체는 키 순서가 다르다 */
function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined && o[k] !== null).map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

/** 두 장면이 같은 설계인가 — id·이름은 빼고 본다(저장하면 id 가 uuid 로 바뀐다). 저장 뒤 편집기가 이력을 지우지 않기 위해. */
export function sameDesign(a: SceneSpec, b: SceneSpec): boolean {
  const strip = (s: SceneSpec) => {
    const c = compact(normalize(s));
    return stableJson({ ...c, id: "", label: "", cuts: [...(c.cuts ?? [])].sort((p, q) => p.r - q.r || p.c - q.c), tiles: [...(c.tiles ?? [])].sort((p, q) => p.r - q.r || p.c - q.c) });
  };
  return strip(a) === strip(b);
}

/** 서서 이야기하는 사무실의 장면들 — 방 하나에 장면 하나, 장면마다 크기와 바닥이 다르다.
 *
 * 이 사무실에는 **앉기가 없다.** 사람들은 자판기 앞에서, 화이트보드 앞에서, 커피 머신 앞에서,
 * 창가에서 서서 이야기한다. 방을 채우는 것은 자리 배치가 아니라 **장면**이다: 방이 몇 칸인가,
 * 바닥이 무엇인가, 어떤 소품이 어디 있고, 사람들이 어디 서서 어디를 보는가.
 *
 * 장면은 북쪽 방(문이 아래, 안쪽 벽이 위) 기준으로 적는다. 남쪽 방은 배치기가 위아래를
 * 뒤집고 up/down 을 바꾼다. 좌표는 방 안쪽 cols×rows 칸(c, r) 이다. 문은 아래 줄의
 * 가운데 두 칸(`doorCols`) 앞이다.
 *
 * 소품 이름은 아틀라스(atlas.ts 의 FOOT)의 이름이다 — 발자국·솟는 높이·벽걸이 여부는 거기서 온다.
 * `start` 는 응시자의 **업무 시작 지점** — 노트북이 놓인 책상(standDesk, 2×1). 앞(아래 줄)에 서면
 * 시작하므로 마지막 줄에는 둘 수 없고, 그 앞 두 칸은 문 칸이 아니어야 한다.
 *
 * **방의 모양**은 `cuts` 가 정한다 — 방에서 도려낸 모서리(칸 사각형)다. 도려낸 칸은 벽이 되어
 * ㄱ자·ㄷ자 방이 된다. 문 칸과 소품·자리·시작 지점은 컷 위에 올 수 없다(테스트가 잡는다).
 *
 * **벽걸이**는 벽의 앞면(캡 아래 24px)에 걸린다. 앞면은 방의 **위쪽 벽**에만 있다(탑다운) — 북쪽 방은
 * 뒷벽, 남쪽 방은 문이 있는 벽이다. 그래서 벽걸이 칸 아래에 위로 솟는 소품(rise ≥ 1)이 서면 겹친다 —
 * 그 자리는 피한다. 남쪽 방에서 문 칸과 겹치면 배치기가 옆으로 민다.
 *
 * 장면은 시험의 분야에서 고르고(`assignScenes`), 층 안에서 최대한 겹치지 않게 나눈다. 같은 장면이
 * 한 층에 두 번 서면 두 번째는 좌우를 뒤집는다.
 */
import type { Dir } from "@/lib/people";
import { FOOT, LEGACY_PROP_NAMES, type FloorKey, type SpriteName } from "./atlas.ts";

/** 기본 장면(코드에 있는 아홉)의 id. 관리자가 만든 장면은 uuid 를 id 로 쓴다. */
export type BuiltinSceneId =
  | "breakroom"
  | "whiteboard"
  | "coffee"
  | "lounge"
  | "printer"
  | "board"
  | "meeting"
  | "standing"
  | "server";
export type SceneId = string;

export type PropKind = SpriteName;

/** 장면 크기의 허용 범위 — 편집기·검증기·API(schemas.OfficeSpec)가 같은 수를 본다 */
export const SCENE_LIMITS = { minCols: 6, maxCols: 20, minRows: 5, maxRows: 14 } as const;

/** 장면 = 사무실 방 하나의 설계도. 기본 아홉은 코드에, 관리자가 만든 것은 DB(office_presets.spec)에
 *  **같은 모양의 JSON** 으로 산다. 편집기가 만들고 검증기(scene-check.ts)가 지키고 배치기(floorplan.ts)가 읽는다. */
export interface SceneSpec {
  id: SceneId;
  label: string;
  /** 방 안쪽 칸 수 — 장면마다 다르다 */
  cols: number;
  rows: number;
  floor: FloorKey;
  /** 바닥 칸을 쓰는 소품 (이름은 atlas 의 FOOT 에 있어야 한다) */
  props: { kind: PropKind; c: number; r: number }[];
  /** 안쪽 벽의 c 칸부터 거는 것 (FOOT[kind].wall 인 것만) */
  decor: { kind: PropKind; c: number }[];
  /** 사람이 서는 자리와 보는 방향. 앞의 것부터 채운다. */
  spots: { c: number; r: number; face: Dir }[];
  /** 업무 시작 지점(standDesk 2×1)의 왼쪽 칸 */
  start: { c: number; r: number };
  /** 방에서 도려낸 칸 사각형들 — 벽이 된다. 없으면 직사각형 방. */
  cuts?: { c: number; r: number; w: number; h: number }[];
  /** 문의 왼쪽 칸(아래 줄, 두 칸 폭). 없으면 가운데. */
  door?: number;
  /** 벽 스타일(atlas.WALL_STYLES 의 키). 없으면 기본(WALL_DEFAULT). */
  wall?: string;
  /** 칸마다 다른 바닥 — 기본 바닥(floor) 위에 덮어쓴다. 없으면 온 방이 한 바닥. */
  tiles?: { c: number; r: number; floor: FloorKey }[];
}

/** 바닥 칸을 막지 않는 소품 — 밟고 다닌다. 지금 팩에는 없다(러그가 생기면 여기 적는다). */
/** 저장된 장면(관리자 프리셋)을 지금 팩의 이름으로 — 옛 팩의 이름은 짝을 찾아 바꾸고, 모르는 것은 뺀다(그리다 멈추는 것보다 낫다). */
export function migrateScene<T extends Pick<SceneSpec, "props" | "decor">>(spec: T): T {
  const fix = (kind: string) => (kind in FOOT ? kind : LEGACY_PROP_NAMES[kind] ?? null);
  const props = spec.props.flatMap((p) => { const k = fix(p.kind); return k ? [{ ...p, kind: k as PropKind }] : []; });
  const decor = spec.decor.flatMap((d) => { const k = fix(d.kind); return k ? [{ ...d, kind: k as PropKind }] : []; });
  if (props.length === spec.props.length && decor.length === spec.decor.length && props.every((p, i) => p.kind === spec.props[i].kind) && decor.every((d, i) => d.kind === spec.decor[i].kind)) return spec;
  return { ...spec, props, decor };
}

export const WALKABLE_PROPS: ReadonlySet<string> = new Set(Object.entries(FOOT).filter(([, f]) => f.walk).map(([k]) => k));

/** 소품의 발자국(칸). 아틀라스가 안다 — 여기서 다시 적지 않는다. */
export function footprintOf(kind: PropKind): { w: number; h: number; rise: number; wall: boolean; walk: boolean; vis: number } {
  const f = (FOOT as Record<string, { w: number; h: number; rise: number; wall: boolean; walk: boolean; vis: number }>)[kind];
  if (!f) throw new Error(`[scenes] 아틀라스에 없는 소품 ${kind}`);
  return f;
}

/** 문이 뚫리는 아래 줄의 두 칸 — 기본은 방 너비의 가운데 */
export function doorCols(cols: number): [number, number] {
  const c = Math.floor(cols / 2) - 1;
  return [c, c + 1];
}

/** 장면의 문 칸 — 장면이 문 위치를 정했으면 그것, 아니면 가운데. 범위를 벗어난 값은 가운데로 본다. */
export function doorColsOf(spec: Pick<SceneSpec, "cols" | "door">): [number, number] {
  const d = spec.door;
  if (typeof d === "number" && Number.isInteger(d) && d >= 0 && d + 1 < spec.cols) return [d, d + 1];
  return doorCols(spec.cols);
}

/** 칸 사각형 하나를 같은 바닥으로 — 장면 안의 구역(원목 바닥의 소파 자리, 회의 탁자 밑 카펫 …)을 적는다 */
function area(c: number, r: number, w: number, h: number, floor: FloorKey): { c: number; r: number; floor: FloorKey }[] {
  const out: { c: number; r: number; floor: FloorKey }[] = [];
  for (let dr = 0; dr < h; dr += 1) for (let dc = 0; dc < w; dc += 1) out.push({ c: c + dc, r: r + dr, floor });
  return out;
}

/** 기본 장면 아홉 — 2026-09-14 넓이를 두 배로 키우고 다시 꾸몄다(여섯 사람이 좁은 방에 몰려 서 있어 보였다).
 *  방마다 구역이 둘 이상 있다: 벽을 따라 서는 가구, 가운데의 이야기 자리, 문에서 들어오는 길. 문 앞 두 줄은 비워 둔다. */
export const SCENES: Record<BuiltinSceneId, SceneSpec> = {
  breakroom: {
    id: "breakroom",
    label: "휴게실",
    cols: 12,
    rows: 8,
    floor: "slate",
    // 뒷벽은 자판기·쇼케이스·조리대(위에 상부장), 가운데는 카페 테이블 둘, 오른쪽 아래는 원목 바닥의 소파 자리
    tiles: area(8, 4, 4, 4, "oak"),
    props: [
      { kind: "vending-drink-1", c: 0, r: 0 },
      { kind: "vending-drink-3", c: 1, r: 0 },
      { kind: "vending-coffee", c: 2, r: 0 },
      { kind: "fridge-glass-1", c: 3, r: 0 },
      { kind: "counter-gray-espresso", c: 5, r: 0 },
      { kind: "cooler-1", c: 10, r: 0 },
      { kind: "plant-tall-1", c: 11, r: 0 },
      { kind: "cafe-white-1", c: 1, r: 3 },
      { kind: "cafe-brown-1", c: 9, r: 3 },
      { kind: "sofa-blue", c: 9, r: 5 },
      { kind: "armchair-brown", c: 11, r: 5 },
      { kind: "side-table-wood", c: 8, r: 6 },
      { kind: "plant-palm-1", c: 11, r: 4 },
      { kind: "plant-small-3", c: 0, r: 6 },
      { kind: "bin-gray", c: 4, r: 7 },
    ],
    decor: [
      { kind: "clock-blue", c: 4 },
      { kind: "upper-cabinet-gray", c: 5 },
      { kind: "upper-cabinet-gray", c: 7 },
      { kind: "picture-sea", c: 9 },
    ],
    spots: [
      { c: 6, r: 2, face: "up" },
      { c: 3, r: 4, face: "left" },
      { c: 8, r: 5, face: "right" },
      { c: 7, r: 2, face: "up" },
      { c: 1, r: 5, face: "up" },
      { c: 4, r: 1, face: "right" },
    ],
    start: { c: 1, r: 6 },
  },
  whiteboard: {
    id: "whiteboard",
    label: "화이트보드 앞",
    cols: 13,
    rows: 10,
    floor: "slate",
    // 뒷벽에 이동식 화이트보드 둘 — 그 앞에 서서 모인다. 오른쪽 아래는 유리 칸막이 뒤 업무 자리, 왼쪽 아래 모서리는 도려냈다.
    cuts: [{ c: 0, r: 8, w: 3, h: 2 }],
    props: [
      { kind: "bookshelf-wood-2", c: 0, r: 0 },
      { kind: "whiteboard-wheel-1", c: 4, r: 0 },
      { kind: "whiteboard-notes", c: 7, r: 0 },
      { kind: "cabinet-file-gray-1", c: 11, r: 0 },
      { kind: "cabinet-lateral-gray", c: 12, r: 0 },
      { kind: "plant-palm-2", c: 0, r: 3 },
      { kind: "round-table-wood-1", c: 1, r: 4 },
      { kind: "divider-glass-gray", c: 9, r: 5 },
      { kind: "divider-glass-gray", c: 11, r: 5 },
      { kind: "workstation-1", c: 9, r: 7 },
      { kind: "workstation-3", c: 11, r: 7 },
      { kind: "plant-tall-2", c: 12, r: 9 },
      { kind: "bin-dark", c: 3, r: 9 },
    ],
    decor: [
      { kind: "picture-abstract-1", c: 2 },
      { kind: "picture-map", c: 3 },
      { kind: "clock-blue", c: 6 },
      { kind: "board-cork", c: 9 },
    ],
    spots: [
      { c: 4, r: 2, face: "up" },
      { c: 8, r: 2, face: "up" },
      { c: 3, r: 3, face: "right" },
      { c: 5, r: 2, face: "up" },
      { c: 9, r: 3, face: "left" },
      { c: 7, r: 2, face: "up" },
    ],
    start: { c: 2, r: 6 },
  },
  coffee: {
    id: "coffee",
    label: "커피 코너",
    cols: 10,
    rows: 8,
    floor: "oak",
    // 뒷벽의 원목 조리대와 커피 스테이션, 가운데 카페 테이블 둘, 오른쪽 아래 ㄱ자 소파. 뒤 오른쪽 모서리는 기둥 자리.
    cuts: [{ c: 8, r: 0, w: 2, h: 2 }],
    props: [
      { kind: "counter-wood-espresso", c: 0, r: 0 },
      { kind: "coffee-station-1", c: 4, r: 0 },
      { kind: "fridge-glass-2", c: 6, r: 0 },
      { kind: "cooler-2", c: 7, r: 0 },
      { kind: "shelf-mugs", c: 8, r: 2 },
      { kind: "cafe-brown-1", c: 1, r: 3 },
      { kind: "cafe-brown-2", c: 6, r: 3 },
      { kind: "plant-palm-3", c: 9, r: 5 },
      { kind: "sofa-l-brown", c: 8, r: 6 },
      { kind: "seat-pair-brown-1", c: 0, r: 7 },
      { kind: "bin-dark", c: 3, r: 7 },
    ],
    decor: [
      { kind: "upper-cabinet-tan-1", c: 0 },
      { kind: "upper-cabinet-tan-2", c: 2 },
      { kind: "clock-white", c: 5 },
    ],
    spots: [
      { c: 2, r: 2, face: "up" },
      { c: 5, r: 4, face: "right" },
      { c: 3, r: 4, face: "left" },
      { c: 4, r: 2, face: "up" },
      { c: 7, r: 6, face: "right" },
      { c: 0, r: 2, face: "up" },
    ],
    start: { c: 1, r: 5 },
  },
  lounge: {
    id: "lounge",
    label: "라운지",
    cols: 14,
    rows: 10,
    floor: "walnut",
    // 창 아래 소파 자리 둘, 오른쪽 위 모서리(기둥)와 왼쪽 아래 모서리를 도려낸 넓은 방
    cuts: [{ c: 11, r: 0, w: 3, h: 3 }, { c: 0, r: 8, w: 2, h: 2 }],
    props: [
      { kind: "plant-tall-1", c: 0, r: 0 },
      { kind: "sofa-blue", c: 2, r: 0 },
      { kind: "armchair-brown", c: 1, r: 2 },
      { kind: "table-glass-plant", c: 2, r: 2 },
      { kind: "armchair-brown-2", c: 4, r: 2 },
      { kind: "sofa-l-white", c: 6, r: 0 },
      { kind: "sofa-blue", c: 8, r: 0 },
      { kind: "table-glass-food", c: 7, r: 2 },
      { kind: "plant-palm-blue", c: 10, r: 0 },
      { kind: "bookshelf-wood-2", c: 11, r: 3 },
      { kind: "plant-palm-1", c: 13, r: 3 },
      { kind: "seat-pair-blue-1", c: 0, r: 5 },
      { kind: "armchair-brown", c: 0, r: 7 },
      { kind: "round-table-blue-1", c: 2, r: 7 },
      { kind: "side-table-wood", c: 13, r: 6 },
      { kind: "plant-tall-2", c: 13, r: 9 },
    ],
    decor: [
      { kind: "window-slide", c: 2 },
      { kind: "clock-white", c: 5 },
      { kind: "window-slide", c: 8 },
    ],
    spots: [
      { c: 1, r: 4, face: "right" },
      { c: 9, r: 3, face: "left" },
      { c: 4, r: 3, face: "up" },
      { c: 6, r: 4, face: "right" },
      { c: 3, r: 6, face: "up" },
      { c: 12, r: 5, face: "left" },
    ],
    start: { c: 10, r: 7 },
  },
  printer: {
    id: "printer",
    label: "복합기 코너",
    cols: 10,
    rows: 8,
    floor: "slate",
    // 뒤 왼쪽 모서리를 도려낸 ㄱ자 — 뒷벽에 복합기 둘과 프린터 서랍장, 가운데 분류 탁자, 오른쪽 벽에 문서 수납
    cuts: [{ c: 0, r: 0, w: 2, h: 2 }],
    props: [
      { kind: "copier-cream-1", c: 2, r: 0 },
      { kind: "drawers-printer-gray", c: 4, r: 0 },
      { kind: "copier-gray-1", c: 8, r: 0 },
      { kind: "cabinet-file-gray-2", c: 0, r: 2 },
      { kind: "cabinet-file-gray-3", c: 1, r: 2 },
      { kind: "desk-printer-wood", c: 0, r: 4 },
      { kind: "table-gray-1", c: 4, r: 3 },
      { kind: "cabinet-door-gray-1", c: 8, r: 3 },
      { kind: "shredder-2", c: 9, r: 5 },
      { kind: "plant-small-4", c: 6, r: 7 },
      { kind: "bin-tall-gray", c: 9, r: 7 },
    ],
    decor: [{ kind: "board-cork", c: 6 }],
    spots: [
      { c: 3, r: 1, face: "up" },
      { c: 6, r: 4, face: "left" },
      { c: 3, r: 3, face: "right" },
      { c: 6, r: 1, face: "up" },
      { c: 7, r: 2, face: "left" },
      { c: 8, r: 5, face: "up" },
    ],
    start: { c: 1, r: 5 },
  },
  board: {
    id: "board",
    label: "게시판 앞",
    cols: 12,
    rows: 8,
    floor: "slate",
    // 뒷벽 가득 게시판 — 그 앞에 줄지어 선다. 앞 왼쪽 모서리를 도려내 들어서면 오른쪽으로 트인다.
    cuts: [{ c: 0, r: 6, w: 3, h: 2 }],
    props: [
      { kind: "bookshelf-wood-1", c: 0, r: 0 },
      { kind: "whiteboard-wheel-2", c: 10, r: 0 },
      { kind: "plant-tall-5", c: 0, r: 3 },
      { kind: "round-table-wood-1", c: 3, r: 3 },
      { kind: "round-table-wood-2", c: 6, r: 4 },
      { kind: "credenza-wood", c: 8, r: 3 },
      { kind: "plant-small-6", c: 3, r: 7 },
      { kind: "plant-palm-4", c: 11, r: 3 },
      { kind: "bin-dark", c: 11, r: 7 },
    ],
    decor: [
      { kind: "board-cork", c: 2 },
      { kind: "board-cork-notes", c: 5 },
      { kind: "clock-blue", c: 8 },
    ],
    spots: [
      { c: 2, r: 1, face: "up" },
      { c: 6, r: 1, face: "up" },
      { c: 8, r: 2, face: "left" },
      { c: 3, r: 1, face: "up" },
      { c: 2, r: 4, face: "right" },
      { c: 5, r: 1, face: "up" },
    ],
    start: { c: 9, r: 5 },
  },
  meeting: {
    id: "meeting",
    label: "회의실",
    cols: 14,
    rows: 11,
    floor: "slate",
    // ㄷ자 방 — 뒤 양쪽 모서리를 도려내 가운데가 발표 자리. 스크린 앞에 회의 탁자 둘, 탁자 밑은 회색 카펫.
    cuts: [{ c: 0, r: 0, w: 2, h: 2 }, { c: 12, r: 0, w: 2, h: 2 }],
    tiles: area(4, 2, 6, 7, "grayGrid"),
    props: [
      { kind: "plant-tall-3", c: 2, r: 0 },
      { kind: "screen-white-1", c: 6, r: 0 },
      { kind: "cooler-c1", c: 11, r: 0 },
      { kind: "meeting-8-wood", c: 5, r: 3 },
      { kind: "meeting-8-light", c: 5, r: 6 },
      { kind: "credenza-gray", c: 0, r: 4 },
      { kind: "plant-palm-4", c: 13, r: 3 },
      { kind: "cabinet-door-wood-1", c: 12, r: 6 },
      { kind: "plant-small-5", c: 0, r: 10 },
      { kind: "bin-gray", c: 13, r: 10 },
    ],
    decor: [
      { kind: "board-white", c: 3 },
      { kind: "clock-white", c: 9 },
      { kind: "picture-abstract-3", c: 10 },
    ],
    spots: [
      { c: 7, r: 1, face: "down" },
      { c: 4, r: 3, face: "right" },
      { c: 9, r: 3, face: "left" },
      { c: 6, r: 5, face: "up" },
      { c: 4, r: 6, face: "right" },
      { c: 9, r: 6, face: "left" },
    ],
    start: { c: 1, r: 8 },
  },
  standing: {
    id: "standing",
    label: "스탠딩 데스크",
    cols: 13,
    rows: 10,
    floor: "slate",
    // 업무 자리 두 줄(업무 시작 책상과 헷갈리지 않게 PC 자리로), 창 아래 수납장. 앞 오른쪽 모서리를 도려냈다.
    cuts: [{ c: 10, r: 8, w: 3, h: 2 }],
    props: [
      { kind: "bookshelf-wood-4", c: 0, r: 0 },
      { kind: "credenza-plants", c: 2, r: 0 },
      { kind: "cabinet-file-tan-1", c: 11, r: 0 },
      { kind: "cabinet-lateral-tan", c: 12, r: 0 },
      { kind: "workstation-1", c: 1, r: 2 },
      { kind: "workstation-2", c: 4, r: 2 },
      { kind: "workstation-3", c: 8, r: 2 },
      { kind: "workstation-4", c: 1, r: 5 },
      { kind: "workstation-2", c: 4, r: 5 },
      { kind: "plant-palm-2", c: 12, r: 4 },
      { kind: "plant-tall-4", c: 0, r: 9 },
      { kind: "bin-dark", c: 4, r: 9 },
    ],
    decor: [
      { kind: "window-slide", c: 5 },
      { kind: "picture-sea", c: 8 },
      { kind: "clock-white", c: 10 },
    ],
    spots: [
      { c: 1, r: 3, face: "up" },
      { c: 4, r: 3, face: "up" },
      { c: 8, r: 3, face: "up" },
      { c: 2, r: 3, face: "up" },
      { c: 1, r: 6, face: "up" },
      { c: 5, r: 6, face: "up" },
    ],
    start: { c: 8, r: 7 },
  },
  server: {
    id: "server",
    label: "서버실 앞",
    cols: 12,
    rows: 8,
    floor: "server",
    // 서버 랙 두 줄 사이의 통로와 관제 콘솔. 뒤 오른쪽을 도려낸 ㄱ자.
    cuts: [{ c: 9, r: 0, w: 3, h: 2 }],
    props: [
      { kind: "server-kiosk", c: 0, r: 0 },
      { kind: "server-kiosk", c: 1, r: 0 },
      { kind: "server-kiosk", c: 2, r: 0 },
      { kind: "server-kiosk", c: 3, r: 0 },
      { kind: "server-kiosk", c: 4, r: 0 },
      { kind: "server-kiosk", c: 7, r: 0 },
      { kind: "server-kiosk", c: 8, r: 0 },
      { kind: "server-kiosk", c: 0, r: 2 },
      { kind: "server-kiosk", c: 1, r: 2 },
      { kind: "server-kiosk", c: 2, r: 2 },
      { kind: "server-kiosk", c: 3, r: 2 },
      { kind: "server-kiosk", c: 4, r: 2 },
      { kind: "desk-monitor-chair", c: 7, r: 3 },
      { kind: "desk-monitor-phone", c: 9, r: 3 },
      { kind: "locker-gray", c: 11, r: 2 },
      { kind: "cabinet-file-gray-1", c: 11, r: 5 },
      { kind: "bin-dark", c: 9, r: 7 },
    ],
    decor: [{ kind: "board-black", c: 5 }],
    spots: [
      { c: 2, r: 1, face: "up" },
      { c: 7, r: 4, face: "up" },
      { c: 3, r: 3, face: "up" },
      { c: 9, r: 4, face: "up" },
      { c: 4, r: 1, face: "up" },
      { c: 8, r: 6, face: "left" },
    ],
    start: { c: 1, r: 5 },
  },
};

export const SCENE_IDS = Object.keys(SCENES) as BuiltinSceneId[];

export function isBuiltinScene(id: string): id is BuiltinSceneId {
  return Object.prototype.hasOwnProperty.call(SCENES, id);
}

/** 분야마다 어울리는 장면들. 같은 분야의 k 번째 방은 k 번째 것을 쓴다(돌아가며). */
const PREFERENCE: Record<string, BuiltinSceneId[]> = {
  infra: ["server", "standing", "whiteboard"],
  dev: ["whiteboard", "standing", "board"],
  ai: ["meeting", "standing", "server"],
  data: ["board", "whiteboard", "meeting"],
  office: ["coffee", "breakroom", "printer"],
  communication: ["breakroom", "lounge", "meeting"],
  planning: ["meeting", "board", "lounge"],
  problem: ["board", "whiteboard", "breakroom"],
  compliance: ["printer", "coffee", "board"],
  "": ["lounge", "breakroom", "coffee"],
};

export function sceneFor(category: string, nthInCategory: number): BuiltinSceneId {
  const list = PREFERENCE[category] ?? PREFERENCE[""];
  return list[Math.max(0, nthInCategory) % list.length];
}

/** 한 층의 방들에 장면을 나눠 준다.
 *
 *  분야의 선호 순서를 따르되, **층에서 아직 안 쓴 장면**을 먼저 쓴다 — 옆방이 똑같이 생기면
 *  한 층으로 읽히지 않는다. 선호 셋이 다 쓰였으면 층에 없는 아무 장면, 아홉이 다 쓰였으면
 *  이 분야 목록에서 가장 덜 쓰인 것. 입력 순서가 같으면 결과도 같다(결정론). */
export function assignScenes(categories: (string | null)[]): (BuiltinSceneId | null)[] {
  const used = new Map<BuiltinSceneId, number>();
  return categories.map((cat) => {
    // null = 이 방은 장면이 이미 정해져 있다(관리자 프리셋). 층의 다양성 계산에서 뺀다.
    if (cat === null) return null;
    const list = PREFERENCE[cat] ?? PREFERENCE[""];
    let pick = list.find((id) => !used.has(id));
    if (!pick) pick = SCENE_IDS.find((id) => !used.has(id));
    if (!pick) pick = list.reduce((best, id) => ((used.get(id) ?? 0) < (used.get(best) ?? 0) ? id : best), list[0]);
    used.set(pick, (used.get(pick) ?? 0) + 1);
    return pick;
  });
}

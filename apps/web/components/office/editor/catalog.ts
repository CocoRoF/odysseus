/** 편집기의 팔레트 — 무엇을 놓을 수 있고, 사람에게 뭐라고 부르는가.
 *
 *  그림·발자국·이름·묶음은 아틀라스(atlas.ts 의 FOOT·PROP_META)가 안다 — 구입한 팩(Office-3)의 매니페스트에서 나온다.
 *  여기는 그것을 팔레트 순서로 늘어놓고 바닥·벽 스타일의 이름을 댈 뿐이다.
 */
import { FOOT, FLOOR_KEYS, PROP_GROUP_LABELS, PROP_META, WALL_STYLES, WALL_STYLE_KEYS, type FloorKey, type SpriteName, type WallStyleKey } from "../atlas.ts";

export interface PaletteItem {
  kind: SpriteName;
  label: string;
}

export const FLOOR_LABELS: Record<FloorKey, string> = {
  slate: "기본 회색",
  speckle: "밝은 점무늬",
  dense: "짙은 점무늬",
  panel: "밝은 패널",
  blueGrid: "파란 격자",
  grayGrid: "회색 격자",
  paleGrid: "옅은 격자",
  oak: "오크 마루",
  walnut: "월넛 마루",
  concrete: "콘크리트",
  server: "서버실 그레이팅",
  mat: "매트",
};

export const FLOOR_ITEMS: { key: FloorKey; label: string }[] = [...FLOOR_KEYS]
  .sort((a, b) => (a === "slate" ? -1 : b === "slate" ? 1 : 0))
  .map((key) => ({ key, label: FLOOR_LABELS[key] }));

/** 벽 스타일 — 아틀라스 순서(첫 것이 기본) */
export const WALL_ITEMS: { key: WallStyleKey; label: string }[] = WALL_STYLE_KEYS.map((key) => ({ key, label: WALL_STYLES[key].label }));

const NAMES = Object.keys(PROP_META) as SpriteName[];

/** 바닥 소품 — 묶음 순서가 팔레트 순서다. 벽걸이(wall)와 시작 책상은 뺀다. */
export const PROP_GROUPS: { key: string; title: string; items: PaletteItem[] }[] = Object.entries(PROP_GROUP_LABELS)
  .filter(([key]) => key !== "wall")
  .map(([key, title]) => ({
    key,
    title,
    items: NAMES.filter((name) => PROP_META[name].group === key && !FOOT[name].wall && name !== "standDesk").map((kind) => ({ kind, label: PROP_META[kind].label })),
  }))
  .filter((g) => g.items.length > 0);

/** 벽걸이 — 위 벽의 앞면에 걸린다 */
export const DECOR_ITEMS: PaletteItem[] = NAMES.filter((name) => FOOT[name].wall).map((kind) => ({ kind, label: PROP_META[kind].label }));

export const PROP_LABEL: Record<string, string> = Object.fromEntries(NAMES.map((name) => [name, PROP_META[name].label]));

export function labelOf(kind: string): string {
  return PROP_LABEL[kind] ?? kind;
}

export function footOf(kind: string): { w: number; h: number; rise: number; wall: boolean; walk: boolean; vis: number } | null {
  return (FOOT as Record<string, { w: number; h: number; rise: number; wall: boolean; walk: boolean; vis: number }>)[kind] ?? null;
}

/** 팔레트에 있는 모든 종류 — 저장된 장면에 이 밖의 것이 있으면(옛 이름) 편집기가 알려 준다 */
export const KNOWN_KINDS: ReadonlySet<string> = new Set(NAMES);

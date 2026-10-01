/** 벽 칸을 화면 사각형으로 — 사무실과 편집기가 같은 함수로 그린다.
 *
 *  벽 칸은 윗면(top)이나 앞면(face) 하나로, 그림은 스타일 시트(WALL_STYLES)의 variant 번째 칸이다(오토타일 변형 —
 *  floorplan 이 이웃을 보고 정한다). 시트는 한 줄 WALL_SHEET_COLS 칸, 칸 사이 WALL_PITCH(여백 1px 는 블리딩 막이). z 는 칸 아래선. */
import { WALL_GUTTER, WALL_PITCH, WALL_SHEET_COLS, WALL_STYLES, WALL_TILE } from "./atlas.ts";
import { TILE, wallZOf, type WallPiece } from "./floorplan.ts";

export interface WallDraw {
  left: number;
  top: number;
  width: number;
  height: number;
  /** y 정렬층의 깊이 */
  z: number;
  kind: WallPiece["kind"];
  style: WallPiece["style"];
  bgX: number;
  bgY: number;
  bgW: number;
  bgH: number;
}

export function wallDraw(w: WallPiece): WallDraw {
  const col = w.variant % WALL_SHEET_COLS, row = Math.floor(w.variant / WALL_SHEET_COLS);
  return {
    left: w.x,
    top: w.y,
    width: TILE,
    height: TILE,
    z: wallZOf(w.y),
    kind: w.kind,
    style: w.style,
    bgX: -(col * WALL_PITCH + WALL_GUTTER),
    bgY: -(row * WALL_PITCH + WALL_GUTTER),
    bgW: WALL_STYLES[w.style].w,
    bgH: WALL_STYLES[w.style].h,
  };
}

/** 인라인 스타일 — 위치·크기·시트(스타일별 CSS 변수)·시트 안의 자리. 클래스 .o-wall 이 나머지를 댄다. */
export function wallStyle(d: WallDraw): React.CSSProperties {
  return {
    left: d.left,
    top: d.top,
    width: d.width,
    height: d.height,
    zIndex: d.z,
    backgroundImage: `var(--office-wall-${d.style})`,
    backgroundPosition: `${d.bgX}px ${d.bgY}px`,
    backgroundSize: `${d.bgW}px ${d.bgH}px`,
  };
}

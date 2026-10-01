// 생성 파일 — 직접 고치지 말 것. `node tools/tileset/characters-import.mjs` 가 만든다.
// 원본은 images/charactor_*/ 에 있다. 새 프리셋은 그 규칙대로 폴더를 하나 더 두면 된다.
// 사무실·메신저·시나리오 편집기가 모두 이 목록을 쓴다.
// 시트가 계약대로 잘렸는지는 `node --test tools/tileset/` 가 검사한다.
import type { CSSProperties } from "react";

/** 방향 — **원본 파일 이름 그대로**다 (idle-down.png … move-up.png).
 *
 *  코드가 따로 약어(s/w/e/n, north/south/…)를 두지 않는다. 그림 파일에서 화면까지
 *  가는 길에 번역이 한 번이라도 끼면 그 자리에서 방향이 어긋나고, 실제로 어긋났다. */
export type Dir = "down" | "left" | "right" | "up";
/** 자세 — 서 있는 자세와 내딛는 자세. 걸을 때 번갈아 쓴다. */
export type Pose = "idle" | "move";

export const DIRS: Dir[] = ["down","left","right","up"];
export const POSES: Pose[] = ["idle","move"];

/** 파일 이름의 해시는 내용에서 온다 — 시트가 바뀌면 이름도 바뀌어, 캐시된 옛 그림이
 *  새 좌표와 짝지어지는 일이 없다. */
export const PEOPLE_SRC = "/office/people.601d03fa9d.png";
/** 시트 배율 — 시트 px ÷ 월드 px (= 112/96). 시트는 **원본 픽셀 그대로**라 화면보다 촘촘하다. */
export const PEOPLE_SCALE = 1.1666666666666667;
/** 시트 한 칸·시트 전체 크기(시트 px, 정수) — 원본 픽셀을 다룰 때(캔버스에 굽기, 크게 보여 주기)는 이것을 쓴다 */
export const PERSON_SHEET_W = 98;
export const PERSON_SHEET_H = 112;
export const SHEET_PX_W = 784;
export const SHEET_PX_H = 3920;
/** 발로 보는 아래 줄 수(시트 px) — 시트를 검사할 때 임포터와 같은 자를 쓰라고 내보낸다 */
export const FOOT_ROWS = 13;
/** 크기를 보정하느라 **다시 샘플한** 프리셋 — 몸 키가 중앙값(110px)과 6% 넘게 달랐다. 나머지는 원본 픽셀 그대로다. */
export const RESAMPLED: string[] = [];
/** 시트 전체 크기(월드 px) — background-size 에 그대로 쓴다 */
export const SHEET_W = 672;
export const SHEET_H = 3360;
/** 한 칸 크기(월드 px) — 세로는 타일(32) 한 칸 반이다. 사람이 책상보다 커야 사람으로 보인다. */
export const PERSON_W = 84;
export const PERSON_H = 96;

/** 움직인 방향 → 볼 방향. 가로가 더 크면 좌우, 아니면 위아래다.
 *  (0,0) 이 오면 바꾸지 않는다는 뜻이라 `fallback` 을 돌려준다. */
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
  { id: "charactor-01", name: "정장 여성", gender: "female", row: 0, portrait: "/office/portraits/charactor-01.png", bust: "/office/portraits/charactor-01-bust.png" },
  { id: "charactor-02", name: "정장 남성", gender: "male", row: 1, portrait: "/office/portraits/charactor-02.png", bust: "/office/portraits/charactor-02-bust.png" },
  { id: "charactor-03", name: "가디건 여성", gender: "female", row: 2, portrait: "/office/portraits/charactor-03.png", bust: "/office/portraits/charactor-03-bust.png" },
  { id: "charactor-04", name: "포니테일 여성", gender: "female", row: 3, portrait: "/office/portraits/charactor-04.png", bust: "/office/portraits/charactor-04-bust.png" },
  { id: "charactor-05", name: "아이보리 정장 여성", gender: "female", row: 4, portrait: "/office/portraits/charactor-05.png", bust: "/office/portraits/charactor-05-bust.png" },
  { id: "charactor-06", name: "조끼 여성", gender: "female", row: 5, portrait: "/office/portraits/charactor-06.png", bust: "/office/portraits/charactor-06-bust.png" },
  { id: "charactor-07", name: "원피스 여성", gender: "female", row: 6, portrait: "/office/portraits/charactor-07.png", bust: "/office/portraits/charactor-07-bust.png" },
  { id: "charactor-08", name: "짙은 정장 남성", gender: "male", row: 7, portrait: "/office/portraits/charactor-08.png", bust: "/office/portraits/charactor-08-bust.png" },
  { id: "charactor-09", name: "스웨터 남성", gender: "male", row: 8, portrait: "/office/portraits/charactor-09.png", bust: "/office/portraits/charactor-09-bust.png" },
  { id: "charactor-10", name: "장발 남성", gender: "male", row: 9, portrait: "/office/portraits/charactor-10.png", bust: "/office/portraits/charactor-10-bust.png" },
  { id: "charactor-11", name: "조끼 남성", gender: "male", row: 10, portrait: "/office/portraits/charactor-11.png", bust: "/office/portraits/charactor-11-bust.png" },
  { id: "charactor-12", name: "그린 재킷 남성", gender: "male", row: 11, portrait: "/office/portraits/charactor-12.png", bust: "/office/portraits/charactor-12-bust.png" },
  { id: "charactor-13", name: "라벤더 가디건 여성", gender: "female", row: 12, portrait: "/office/portraits/charactor-13.png", bust: "/office/portraits/charactor-13-bust.png" },
  { id: "charactor-14", name: "땋은 머리 여성", gender: "female", row: 13, portrait: "/office/portraits/charactor-14.png", bust: "/office/portraits/charactor-14-bust.png" },
  { id: "charactor-15", name: "흰 정장 단발 여성", gender: "female", row: 14, portrait: "/office/portraits/charactor-15.png", bust: "/office/portraits/charactor-15-bust.png" },
  { id: "charactor-16", name: "로즈 재킷 여성", gender: "female", row: 15, portrait: "/office/portraits/charactor-16.png", bust: "/office/portraits/charactor-16-bust.png" },
  { id: "charactor-17", name: "체크 스커트 여성", gender: "female", row: 16, portrait: "/office/portraits/charactor-17.png", bust: "/office/portraits/charactor-17-bust.png" },
  { id: "charactor-18", name: "하늘색 셔츠 여성", gender: "female", row: 17, portrait: "/office/portraits/charactor-18.png", bust: "/office/portraits/charactor-18-bust.png" },
  { id: "charactor-19", name: "초록 블라우스 여성", gender: "female", row: 18, portrait: "/office/portraits/charactor-19.png", bust: "/office/portraits/charactor-19-bust.png" },
  { id: "charactor-20", name: "네이비 니트 여성", gender: "female", row: 19, portrait: "/office/portraits/charactor-20.png", bust: "/office/portraits/charactor-20-bust.png" },
  { id: "charactor-21", name: "네이비 스커트 여성", gender: "female", row: 20, portrait: "/office/portraits/charactor-21.png", bust: "/office/portraits/charactor-21-bust.png" },
  { id: "charactor-22", name: "살구 가디건 여성", gender: "female", row: 21, portrait: "/office/portraits/charactor-22.png", bust: "/office/portraits/charactor-22-bust.png" },
  { id: "charactor-23", name: "버건디 블라우스 여성", gender: "female", row: 22, portrait: "/office/portraits/charactor-23.png", bust: "/office/portraits/charactor-23-bust.png" },
  { id: "charactor-24", name: "세이지 원피스 여성", gender: "female", row: 23, portrait: "/office/portraits/charactor-24.png", bust: "/office/portraits/charactor-24-bust.png" },
  { id: "charactor-25", name: "검은 재킷 단발 여성", gender: "female", row: 24, portrait: "/office/portraits/charactor-25.png", bust: "/office/portraits/charactor-25-bust.png" },
  { id: "charactor-26", name: "아이보리 재킷 남성", gender: "male", row: 25, portrait: "/office/portraits/charactor-26.png", bust: "/office/portraits/charactor-26-bust.png" },
  { id: "charactor-27", name: "네이비 더블 정장 남성", gender: "male", row: 26, portrait: "/office/portraits/charactor-27.png", bust: "/office/portraits/charactor-27-bust.png" },
  { id: "charactor-28", name: "니트 가디건 남성", gender: "male", row: 27, portrait: "/office/portraits/charactor-28.png", bust: "/office/portraits/charactor-28-bust.png" },
  { id: "charactor-29", name: "검은 조끼 남성", gender: "male", row: 28, portrait: "/office/portraits/charactor-29.png", bust: "/office/portraits/charactor-29-bust.png" },
  { id: "charactor-30", name: "카키 셔츠 남성", gender: "male", row: 29, portrait: "/office/portraits/charactor-30.png", bust: "/office/portraits/charactor-30-bust.png" },
  { id: "charactor-31", name: "야구 점퍼 남성", gender: "male", row: 30, portrait: "/office/portraits/charactor-31.png", bust: "/office/portraits/charactor-31-bust.png" },
  { id: "charactor-32", name: "와이드 팬츠 남성", gender: "male", row: 31, portrait: "/office/portraits/charactor-32.png", bust: "/office/portraits/charactor-32-bust.png" },
  { id: "charactor-33", name: "트위드 재킷 남성", gender: "male", row: 32, portrait: "/office/portraits/charactor-33.png", bust: "/office/portraits/charactor-33-bust.png" },
  { id: "charactor-34", name: "하늘색 반팔 셔츠 남성", gender: "male", row: 33, portrait: "/office/portraits/charactor-34.png", bust: "/office/portraits/charactor-34-bust.png" },
  { id: "charactor-35", name: "회색 블레이저 남성", gender: "male", row: 34, portrait: "/office/portraits/charactor-35.png", bust: "/office/portraits/charactor-35-bust.png" },
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
 *  pixelated, 줄일 때는 부드럽게. 도트가 고르게 보이려면 늘리는 배율(높이 ÷ 112)을 정수로 고르는 것이 좋다. */
export function personSpriteAt(row: number, dir: Dir, pose: Pose, height: number): CSSProperties {
  const s = height / PERSON_SHEET_H;
  const cell = personSheetCell(row, dir, pose);
  return {
    width: PERSON_SHEET_W * s,
    height,
    backgroundImage: `url(${PEOPLE_SRC})`,
    backgroundSize: `${SHEET_PX_W * s}px ${SHEET_PX_H * s}px`,
    backgroundPosition: `-${cell.x * s}px -${cell.y * s}px`,
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
    backgroundImage: `url(${PEOPLE_SRC})`,
    backgroundSize: `${SHEET_W}px ${SHEET_H}px`,
    backgroundPosition: `-${cell.x}px -${cell.y}px`,
    backgroundRepeat: "no-repeat",
  };
}

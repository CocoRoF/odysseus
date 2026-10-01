/** 사무실 카메라의 셈 — 배율을 기기 픽셀에 끊고, 층 밖을 비추지 않게 가두고, 확대할 때 커서 밑의 한 점을 붙잡고,
 *  두 카메라 사이를 부드럽게 옮긴다. 순수 함수뿐이라 노드 테스트로 돈다.
 *
 *  좌표: 카메라 { s: 월드 px 하나가 CSS px 몇 개인가, fx·fy: 화면 가운데에 오는 월드 점 }. 화면(뷰) 좌표의 원점은 뷰포트
 *  왼쪽 위이고 w·h 는 하단 바를 뺀 쓸 수 있는 크기다. 월드 점 (x, y) 는 화면에서 (w/2 + s·(x − fx), h/2 + s·(y − fy)).
 *
 *  2026-09-14: 휠 확대가 **화면 가운데 배율만 바꾸고 시점은 움직이지 않던** 것을 고쳤다(PR #25 의 한계). 확대는 커서 밑을
 *  붙잡고, 끌면 시점이 움직이고, 방에 들어갈 때·되돌아갈 때는 미끄러지듯 옮긴다.
 */

export interface Cam {
  s: number;
  fx: number;
  fy: number;
}
export interface View {
  w: number;
  h: number;
}
export interface World {
  width: number;
  height: number;
}

/** 사용자 확대 배율의 범위(기본 배율에 곱한다) */
export const ZOOM_MIN = 0.6;
export const ZOOM_MAX = 2.6;
/** 버튼·키보드 한 번의 확대 비율 */
export const ZOOM_STEP = 1.25;

/** 배율을 한 칸(unit = TILE × dpr)이 기기 픽셀 정수가 되게 내림한다 — 소수 배율로 픽셀 그림을 늘리면 칸 경계에 실금이 생긴다 */
export function snapScale(raw: number, unit: number): number {
  return Math.max(1 / unit, Math.floor(raw * unit + 1e-9) / unit);
}

/** 한 축에서 초점이 있어도 되는 범위 [lo, hi].
 *  - 층이 화면보다 넓으면: 층 가장자리가 화면 끝에 닿을 때까지(바깥 어둠을 비추지 않는다).
 *  - 층이 화면보다 좁으면: 층 전체가 화면 안에 남는 범위. 예전에는 가운데에 못 박아, 방이 몇 개뿐인 층(운영: 방 셋)을 확대하면
 *    커서를 붙잡지 못하고 가운데로 끌려갔고 가로로 끌어도 꿈쩍 않았다(2026-09-14 운영 실측: 커서 밑이 300px 밀림). */
export function focusRange(half: number, span: number): [number, number] {
  return half * 2 >= span ? [span - half, half] : [half, span - half];
}

/** 한 축을 가둔다(범위 밖이면 가장자리로) */
export function clampAxis(v: number, half: number, span: number): number {
  const [lo, hi] = focusRange(half, span);
  return Math.min(Math.max(v, lo), hi);
}

export function clampFocus(fx: number, fy: number, s: number, view: View, world: World): { fx: number; fy: number } {
  return { fx: clampAxis(fx, view.w / s / 2, world.width), fy: clampAxis(fy, view.h / s / 2, world.height) };
}

/** 범위 밖으로 끌면 점점 버틴다(고무줄) — 넘친 만큼이 아니라 dim 에 다가가기만 한다. 놓으면 범위로 돌아간다. */
export function rubberBand(v: number, lo: number, hi: number, dim: number): number {
  const soft = (over: number) => (1 - 1 / ((over * 0.55) / dim + 1)) * dim;
  if (v < lo) return lo - soft(lo - v);
  if (v > hi) return hi + soft(v - hi);
  return v;
}

/** 두 축 고무줄 — dim 은 각 축의 화면 절반(월드 px) */
export function rubberFocus(fx: number, fy: number, s: number, view: View, world: World): { fx: number; fy: number } {
  const hw = view.w / s / 2, hh = view.h / s / 2;
  const [xl, xh] = focusRange(hw, world.width), [yl, yh] = focusRange(hh, world.height);
  return { fx: rubberBand(fx, xl, xh, hw), fy: rubberBand(fy, yl, yh, hh) };
}

/** 화면 점 (sx, sy) 밑의 월드 점 */
export function worldAt(cam: Cam, view: View, sx: number, sy: number): { x: number; y: number } {
  return { x: cam.fx + (sx - view.w / 2) / cam.s, y: cam.fy + (sy - view.h / 2) / cam.s };
}

/** 배율 s 에서 월드 점 (wx, wy) 가 화면 점 (sx, sy) 에 오게 하는 초점 */
export function focusKeeping(wx: number, wy: number, sx: number, sy: number, s: number, view: View): { fx: number; fy: number } {
  return { fx: wx - (sx - view.w / 2) / s, fy: wy - (sy - view.h / 2) / s };
}

/** glide: 느리게 출발해 느리게 멈춘다(방 드나들기·되돌아가기). anchor: 커서 밑을 붙잡고 확대. coast: 손을 놓은 끌기의 관성(빠르게 출발해 서서히 멈춘다). */
export type TweenKind = "glide" | "anchor" | "coast";

export interface Tween {
  from: Cam;
  /** 목표 — 옮기는 동안 아바타가 걸으면 목표가 따라 바뀐다(진행도는 그대로) */
  to: Cam;
  t0: number;
  dur: number;
  kind: TweenKind;
  /** anchor: 붙잡을 화면 점과 그 밑의 월드 점 */
  anchor?: { sx: number; sy: number; wx: number; wy: number };
}

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** 옮기는 중의 카메라. 배율은 로그 공간에서 옮긴다 — 곱으로 느끼는 크기라 일정한 빠르기로 커지고 작아진다.
 *  anchor 는 붙잡은 점이 화면에서 움직이지 않게 초점을 배율에 맞춰 풀고, 가두기 때문에 생긴 끝점의 차이만 서서히 더한다. */
export function tweenAt(tw: Tween, now: number, view: View): { cam: Cam; done: boolean } {
  const p = tw.dur <= 0 ? 1 : Math.min(1, Math.max(0, (now - tw.t0) / tw.dur));
  if (p >= 1) return { cam: { ...tw.to }, done: true };
  const e = tw.kind === "glide" ? easeInOut(p) : easeOut(p);
  const s = Math.exp(lerp(Math.log(tw.from.s), Math.log(tw.to.s), e));
  if (tw.kind === "anchor" && tw.anchor) {
    const a = tw.anchor;
    const here = focusKeeping(a.wx, a.wy, a.sx, a.sy, s, view);
    const end = focusKeeping(a.wx, a.wy, a.sx, a.sy, tw.to.s, view);
    return { cam: { s, fx: here.fx + (tw.to.fx - end.fx) * e, fy: here.fy + (tw.to.fy - end.fy) * e }, done: false };
  }
  return { cam: { s, fx: lerp(tw.from.fx, tw.to.fx, e), fy: lerp(tw.from.fy, tw.to.fy, e) }, done: false };
}

/** 끌기를 놓았을 때 미끄러질 초점 — 최근 속도(월드 px/ms)로 τ ms 만큼 더 가되, 화면에서 maxPx 를 넘지 않는다(세게 튕겨도
 *  보던 곳을 잃지 않게). 느리면(손을 멈추고 놓으면) 미끄러지지 않는다. */
export function coastFocus(fx: number, fy: number, vx: number, vy: number, s: number, tau = 160, minSpeedPx = 0.25, maxPx = 220): { fx: number; fy: number } | null {
  const speedPx = Math.hypot(vx, vy) * s;
  if (speedPx < minSpeedPx) return null;
  const k = Math.min(1, maxPx / (speedPx * tau));
  return { fx: fx + vx * tau * k, fy: fy + vy * tau * k };
}

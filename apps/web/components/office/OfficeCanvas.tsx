"use client";

/** 사무실 한 층을 **캔버스 한 장**에 그린다 — 복도·방 바닥·조명·벽·벽걸이·소품·시작 책상·동료·나.
 *
 *  왜 DOM 이 아닌가(2026-09-13): 벽·바닥·소품을 수백 개의 요소로 두고 층 전체에 소수 배율(transform: scale)을 걸면, 브라우저가
 *  그 요소를 어느 레이어에서 래스터하느냐에 따라 소수 픽셀 위치를 다르게 반올림한다. 사람이 움직이면 겹치는 벽·소품이 레이어
 *  사이를 오가며 1px 씩 튀었다.
 *
 *  왜 **구워 둔 비트맵**인가(같은 날, 캔버스로 옮긴 뒤에도 남은 것): 벽 타일 48px 를 40 기기 px 로 최근접 축소하면(비율 1.2) 표본점이
 *  원본 픽셀 경계에 **정확히** 걸리는 자리가 생긴다. 그 자리에서 어느 열을 버릴지는 부동소수점 오차가 정하고, 오차는 그리는 **절대
 *  위치**에 따라 달라진다 — 카메라가 아바타를 따라 옮기면 벽돌의 1px 줄눈이 프레임마다 나타났다 사라졌다(측정: 같은 벽 구역을
 *  정확한 이동량으로 겹쳐도 2.1% 가 어긋났다).
 *
 *  그래서 축소는 **배율마다 한 번**, 원점 (0,0) 에서만 한다: 벽 변형·소품·사람 프레임·발밑 그림자·방 바닥+조명을 각자 작은 캔버스에
 *  구워 두고, 매 프레임은 그것을 정수 위치에 **1:1 로 복사**할 뿐이다. 1:1 복사에는 표본을 고를 일이 없으므로, 카메라 이동은 픽셀
 *  단위의 평행이동이 되고 가만히 있을 때는 픽셀이 수학적으로 같다. 이웃 벽 칸은 크기가 정수(48·k)라 틈도 겹침도 없다.
 *
 *  카메라가 **움직이는 동안**(방에 들어갈 때의 확대, 휠 확대, 되돌아가기 — 2026-09-14): 배율이 매 프레임 바뀌므로 그때마다
 *  굽지 않는다. 가까운 정수 배율(bakeK)로 구워 둔 것을 캔버스 변환으로 늘이고 줄여 그린다(부드럽게). 멈추면 그 배율에서
 *  다시 굽고 1:1 복사로 돌아간다 — 쉴 때의 픽셀은 예전과 같다. 굽기는 **화면에 보이는 것만** 한다: 방이 넓어지고 확대가
 *  생기면서, 보이지 않는 방까지 큰 배율로 굽던 것이 메모리를 채울 수 있었다. 오래 안 쓴 비트맵은 비운다.
 *
 *  깊이는 발끝 y 한 줄로 정렬한다(벽·벽걸이·소품·책상·사람). 같은 깊이는 예전 DOM 순서(벽 → 벽걸이 → 소품 → 책상 → 동료 → 나)를 따른다.
 *  누름(방 영역·시작 지점 버튼)과 글자(이름표·말 걸기)는 DOM 에 그대로 있다 — 투명하거나 배율 밖이라 흔들릴 것이 없다.
 *
 *  **바뀐 자리만 다시 그린다**(2026-09-21): 카메라·배율·방·그림이 그대로면 사람이 움직인 자리와 책상 불빛의 자리만 지우고
 *  그 사각형 안에 걸리는 것(바닥·벽·소품·사람)을 깊이 순서대로 다시 얹는다. 예전에는 동료 한 명이 한 걸음 옮길 때마다 층 전체를
 *  다시 칠했다 — GPU 가 있으면 티가 안 나지만, 하드웨어 가속이 꺼진 PC 에서는 그 한 장을 CPU 가 칠하느라(1600×1000 에 프레임당
 *  20ms 남짓, DPR 2 면 네 배) 사무실이 10fps 로 떨어졌다. 프레임 시간의 93% 가 캔버스 래스터였다(헤드리스 소프트웨어 크로미움 실측).
 *  거기에 lib/render-power 의 **가벼운 모드**(lite): 25Hz 로 묶고, 옮기는 중엔 최근접으로 늘이고, 느리면 스스로 알린다(onSlow).
 */
import { useEffect, useMemo, useRef } from "react";
import type { MyAssignment } from "@/lib/types";
import { PEOPLE_SRC, PERSON_H, PERSON_SHEET_H, PERSON_SHEET_W, PERSON_W, personSheetCell, type Dir, type Pose } from "@/lib/people";
import { ATLAS, HALL_SRC, S, WALL_STYLES, floorSrc, type SpriteName } from "./atlas";
import { TILE, doorGapOf, innerOrigin, type Floor, type RoomLayout } from "./floorplan";
import { wallDraw } from "./wall-draw";
import type { CrewMember } from "./useCrew";

/** 바닥 그림 한 장이 덮는 월드 px — 128px 그림이 2×2 칸 */
const PATCH = 2 * TILE;

export interface CanvasPlayer {
  x: number;
  y: number;
  dir: Dir;
  pose: Pose;
  row: number;
}

export interface OfficeCanvasProps {
  floor: Floor;
  layouts: Map<string, RoomLayout>;
  byRoom: { map: Map<string, MyAssignment[]> };
  entered: string | null;
  peekedId: string | null;
  /** 동료 — useCrew 가 매 틱 고치는 살아 있는 배열 */
  live: { current: readonly CrewMember[] };
  rowOf: (m: CrewMember) => number;
  player: CanvasPlayer;
  /** 뷰포트 CSS 크기(하단 바 포함 전체) */
  viewW: number;
  viewH: number;
  dpr: number;
  /** 뷰포트 요소의 소수 픽셀 몫 — 캔버스를 그만큼 당겨 기기 픽셀 격자에 앉힌다 */
  originFrac: { x: number; y: number };
  /** 월드 px 하나가 기기 px 몇 개인가 */
  k: number;
  /** 월드 원점의 기기 px 위치(정수) — 캔버스 왼쪽 위 기준 */
  ox: number;
  oy: number;
  /** 카메라가 배율을 옮기는 중이면 구워 둘 배율(기기 px/월드 px, 한 칸이 정수가 되는 값). 없으면 k 로 굽고 1:1 로 복사한다. */
  bakeK?: number;
  /** 가벼운 모드 — 그리기 여력이 없는 브라우저(lib/render-power). 25Hz 로 묶고 옮기는 중엔 최근접으로 늘인다 */
  lite?: boolean;
  /** 그리기가 잦은데도 프레임이 30fps 를 못 넘긴다(중앙값 > 33ms, 두 창 연속) — 가볍게 가자는 신호. 한 번만 부른다 */
  onSlow?: () => void;
}

/** 가벼운 모드의 다시 그리기 간격(ms) — 25Hz. 도트 걸음(150ms 에 한 걸음)에는 충분하다 */
const LITE_MIN_GAP_MS = 40;
/** 느림 판정 — 이만큼의 프레임을 모아 중앙값을 본다 */
const SLOW_WINDOW = 90;
const SLOW_MEDIAN_MS = 33;

/** 캔버스(기기 px) 위의 사각형 — 반열린 [x0, x1) × [y0, y1) */
interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
const rectArea = (r: Rect) => Math.max(0, r.x1 - r.x0) * Math.max(0, r.y1 - r.y0);
/** 겹치거나 맞닿은 사각형을 합친다(캔버스 밖은 잘라 낸다). 너무 잘게 나뉘면 하나의 테두리 상자로 */
function mergeRects(list: Rect[], w: number, h: number): Rect[] {
  let out: Rect[] = [];
  for (const r of list) {
    const c = { x0: Math.max(0, Math.floor(r.x0)), y0: Math.max(0, Math.floor(r.y0)), x1: Math.min(w, Math.ceil(r.x1)), y1: Math.min(h, Math.ceil(r.y1)) };
    if (c.x1 > c.x0 && c.y1 > c.y0) out.push(c);
  }
  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < out.length && !merged; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const a = out[i], b = out[j];
        if (a.x0 <= b.x1 + 1 && b.x0 <= a.x1 + 1 && a.y0 <= b.y1 + 1 && b.y0 <= a.y1 + 1) {
          out[i] = { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
          out.splice(j, 1);
          merged = true;
          break;
        }
      }
    }
  }
  if (out.length > 12) {
    out = [out.reduce((u, r) => ({ x0: Math.min(u.x0, r.x0), y0: Math.min(u.y0, r.y0), x1: Math.max(u.x1, r.x1), y1: Math.max(u.y1, r.y1) }))];
  }
  return out;
}

/** 움직이지 않는 것 하나 — 그림의 한 조각(원본 sx·sy·sw·sh)을 월드 사각형(wx·wy·ww·wh)에 */
interface StaticItem {
  z: number;
  group: number;
  order: number;
  kind: "wall" | "sprite" | "desk";
  src: string;
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  wx: number;
  wy: number;
  ww: number;
  wh: number;
  roomId?: string;
}

interface PersonItem {
  z: number;
  group: number;
  order: number;
  row: number;
  dir: Dir;
  pose: Pose;
  x: number;
  y: number;
  me: boolean;
  name: string;
}

interface ProbeHandle {
  /** 사람들 — 발끝 월드 좌표 */
  people: () => { n: string; x: number; y: number; dir: Dir; pose: Pose; me: boolean }[];
  /** 사람 그림의 페이지 CSS 사각형 [left, top, right, bottom] — 검증 스크립트가 배경 비교에서 가린다 */
  peopleRects: () => [number, number, number, number][];
  draws: number;
  /** 구워 둔 비트맵 수 */
  baked: () => number;
  /** 마지막 그리기 — "baked" 는 1:1 복사, "motion" 은 움직이는 중(늘여 그림) */
  mode: "baked" | "motion";
  /** 구워 둔 배율과 그리는 배율 */
  bakeK: number;
  k: number;
  /** 가벼운 모드로 그리는 중인가 */
  lite: boolean;
  /** 마지막 그리기가 바뀐 자리만이었으면 그 사각형 수(0 = 전부 다시 그렸다) */
  regions: number;
}

const images = new Map<string, HTMLImageElement>();
function image(src: string, onLoad: () => void): HTMLImageElement {
  let img = images.get(src);
  if (!img) {
    img = new Image();
    img.decoding = "async";
    img.src = src;
    images.set(src, img);
  }
  if (!img.complete) img.addEventListener("load", onLoad, { once: true });
  return img;
}
const ready = (img: HTMLImageElement) => img.complete && img.naturalWidth > 0;

function reducedMotion(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

export function OfficeCanvas(props: OfficeCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;

  /** 움직이지 않는 것 — 벽·벽걸이·소품·시작 책상. 층이 바뀔 때만 다시 만든다. */
  const staticItems = useMemo(() => {
    const { floor, layouts } = props;
    const out: StaticItem[] = [];
    let order = 0;
    for (const w of floor.walls) {
      const d = wallDraw(w);
      out.push({ kind: "wall", z: d.z, group: 0, order: order++, src: WALL_STYLES[d.style].src, sx: -d.bgX, sy: -d.bgY, sw: TILE, sh: TILE, wx: d.left, wy: d.top, ww: TILE, wh: TILE });
    }
    const sprite = (name: SpriteName, z: number, group: number, wx: number, wy: number, kind: "sprite" | "desk" = "sprite", roomId?: string) => {
      const s = S[name];
      out.push({ kind, z, group, order: order++, src: ATLAS[s.sheet].src, sx: s.x, sy: s.y, sw: s.w, sh: s.h, wx, wy, ww: s.w, wh: s.h, roomId });
    };
    for (const d of [...floor.decor, ...floor.rooms.flatMap((r) => (layouts.get(r.id) as RoomLayout).decor)]) sprite(d.kind as SpriteName, d.z, 1, d.x, d.y);
    for (const p of [...floor.props, ...floor.rooms.flatMap((r) => (layouts.get(r.id) as RoomLayout).props)]) {
      const name = p.kind as SpriteName;
      const foot = p.y + p.h * TILE;
      sprite(name, foot, 2, p.x, foot - S[name].h);
    }
    for (const r of floor.rooms) {
      const L = layouts.get(r.id) as RoomLayout;
      const foot = L.start.y + TILE;
      sprite("standDesk", foot, 3, L.start.x, foot - S.standDesk.h, "desk", r.id);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.floor, props.layouts]);
  const staticRef = useRef(staticItems);
  staticRef.current = staticItems;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;
    const still = reducedMotion();
    let raf = 0;
    let loaded = 0;
    const bump = () => { loaded += 1; };

    // ── 구워 둔 비트맵 ─────────────────────────────────────
    // 열쇠에 배율(k)이 들어 있지 않다 — 배율이 바뀌면 통째로 비운다. 그림이 아직 안 들어왔으면 굽지 않고 다음 프레임에 다시 본다.
    const baked = new Map<string, HTMLCanvasElement>();
    /** 비트맵마다 마지막으로 쓴 그리기 번호 — 오래 안 쓴 큰 것부터 비운다 */
    const lastUse = new Map<string, number>();
    let bakedPixels = 0;
    let bakedK = -1;
    let drawNo = 0;
    const bake = (key: string, w: number, h: number, draw: (g: CanvasRenderingContext2D) => boolean): HTMLCanvasElement | null => {
      const hit = baked.get(key);
      if (hit) { lastUse.set(key, drawNo); return hit; }
      if (w <= 0 || h <= 0) return null;
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const g = c.getContext("2d");
      if (!g) return null;
      if (!draw(g)) return null;
      baked.set(key, c);
      lastUse.set(key, drawNo);
      bakedPixels += w * h;
      return c;
    };
    const clearBaked = () => { baked.clear(); lastUse.clear(); bakedPixels = 0; };

    const handle: ProbeHandle = { people: () => [], peopleRects: () => [], draws: 0, baked: () => baked.size, mode: "baked", bakeK: 0, k: 0, lite: false, regions: 0 };
    (canvas as unknown as { __office: ProbeHandle }).__office = handle;

    /** 지난 그리기의 재료(카메라·배율·방·그림). 그대로면 사람이 움직인 자리와 책상 불빛의 자리만 다시 그린다 */
    let lastBase = "";
    type SeenPerson = { x: number; y: number; dir: Dir; pose: Pose; row: number; rect: Rect };
    let prevPeople: SeenPerson[] = [];
    let lastPulse = -1;
    let lastDrawAt = -Infinity;
    // 프레임 간격 — 그리기가 잦은데도 느리면 가볍게 가자고 알린다
    let lastNow = 0;
    let gaps: number[] = [];
    let drawnInWindow = 0;
    let toldSlow = false;
    /** 잇달아 느린 창의 수 — 한 창(1.5초쯤)의 우연한 버벅임(첫 로드의 JIT·다른 탭)으로 판정하지 않는다 */
    let slowWindows = 0;

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const P = propsRef.current;
      const lite = Boolean(P.lite);
      if (lastNow) gaps.push(now - lastNow);
      lastNow = now;
      if (gaps.length >= SLOW_WINDOW) {
        if (!lite && !toldSlow && drawnInWindow >= SLOW_WINDOW / 2) {
          const sorted = [...gaps].sort((x, y) => x - y);
          slowWindows = sorted[sorted.length >> 1] > SLOW_MEDIAN_MS ? slowWindows + 1 : 0;
          if (slowWindows >= 2) {
            toldSlow = true;
            P.onSlow?.();
          }
        }
        gaps = [];
        drawnInWindow = 0;
      }
      // 가벼운 모드 — 25Hz. 프레임을 거른다고 잃는 것은 없다: 다음 프레임이 그때의 상태를 그린다
      if (lite && now - lastDrawAt < LITE_MIN_GAP_MS) return;
      const { k, ox, oy, dpr } = P;
      // 굽는 배율 — 쉴 때는 k 그대로. 움직이는 동안은 받은 bakeK 로 굽되, 이미 구워 둔 배율이 가까우면(1.6배 안) 그대로 쓴다:
      // 휠을 한 칸 굴릴 때마다 층 전체를 다시 굽지 않게.
      let K = P.bakeK ?? k;
      if (P.bakeK !== undefined && bakedK > 0 && Math.abs(Math.log(bakedK / K)) < Math.log(1.6)) K = bakedK;
      if (K !== bakedK) {
        clearBaked();
        bakedK = K;
        lastBase = "";
      }
      /** 구운 좌표 → 기기 px 의 배율. 쉴 때는 1 이라 1:1 복사다. */
      const r = k / K;
      const motion = Math.abs(r - 1) > 1e-9;
      // 캔버스를 기기 픽셀 격자에 앉힌다 — 왼쪽 위를 뷰포트의 소수 픽셀만큼 당기고, 크기는 기기 px 로 딱 떨어지게
      const bw = Math.max(1, Math.ceil((P.viewW + P.originFrac.x) * dpr));
      const bh = Math.max(1, Math.ceil((P.viewH + P.originFrac.y) * dpr));
      if (canvas.width !== bw || canvas.height !== bh) {
        canvas.width = bw;
        canvas.height = bh;
        lastBase = "";
      }
      const cssLeft = `${-P.originFrac.x}px`, cssTop = `${-P.originFrac.y}px`;
      if (canvas.style.left !== cssLeft) canvas.style.left = cssLeft;
      if (canvas.style.top !== cssTop) canvas.style.top = cssTop;
      const cssW = `${bw / dpr}px`, cssH = `${bh / dpr}px`;
      if (canvas.style.width !== cssW) canvas.style.width = cssW;
      if (canvas.style.height !== cssH) canvas.style.height = cssH;

      // 사람 — 살아 있는 배열에서 바로 읽는다
      const people: PersonItem[] = [];
      let order = 1_000_000;
      for (const m of P.live.current) {
        const x = Math.round(m.x), y = Math.round(m.y);
        people.push({ z: y, group: 4, order: order++, row: P.rowOf(m), dir: m.dir, pose: m.pose, x, y, me: false, name: m.c.name });
      }
      const me = P.player;
      people.push({ z: Math.round(me.y), group: 5, order: order++, row: me.row, dir: me.dir, pose: me.pose, x: Math.round(me.x), y: Math.round(me.y), me: true, name: "" });

      // 책상 깜박임(응시 중) — 박자를 끊어 필요할 때만 다시 그린다(가벼운 모드는 더 성기게)
      let pulseBucket = -1;
      if (!still) for (const room of P.floor.rooms) if (P.byRoom.map.get(room.id)?.[0]?.attempt_status === "in_progress") { pulseBucket = Math.floor(now / (lite ? 160 : 80)); break; }

      /** 월드 → 구운 좌표(기기 px, 카메라 없이). 모든 모서리가 이 한 식에서 나온다. 쉴 때는 K = k 라 곧 기기 px 다. */
      const R = (w: number) => Math.round(w * K);
      /** 사람 한 칸 크기 — 모든 사람·프레임이 같은 크기로 구워진다(걸어도 모양이 한 픽셀도 달라지지 않게) */
      const pw = R(PERSON_W), ph = R(PERSON_H);
      const shW = Math.max(2, R(22)), shH = Math.max(2, R(7));
      /** 사람 한 명이 덮는 캔버스 사각형(그림자 포함) — 쉴 때(r = 1)의 자리 */
      const personRect = (p: PersonItem): Rect => {
        const x0 = R(p.x) - Math.round(pw / 2), y0 = R(p.y) - ph;
        const sx = R(p.x - 11), sy = R(p.y - 4);
        return { x0: Math.min(x0, sx) + ox - 1, y0: Math.min(y0, sy) + oy - 1, x1: Math.max(x0 + pw, sx + shW) + ox + 1, y1: Math.max(y0 + ph, sy + shH) + oy + 1 };
      };
      /** 시작 책상이 덮는 캔버스 사각형 — 불빛의 번짐(drop-shadow)만큼 넉넉히 */
      const deskRect = (s: StaticItem): Rect => {
        const dw = R(s.ww), dh = R(s.wh);
        const x0 = R(s.wx) + ox, y0 = R(s.wy + s.wh) - dh + oy;
        const m = Math.ceil(8 * k) + 2;
        return { x0: x0 - m, y0: y0 - m, x1: x0 + dw + m, y1: y0 + dh + m };
      };

      const base = `${bw}x${bh}|${k}|${K}|${ox}|${oy}|${P.entered}|${P.peekedId}|${loaded}|${staticRef.current.length}|${motion ? 1 : 0}`;
      /** 다시 그릴 자리들. null = 전부 */
      let regions: Rect[] | null = null;
      if (base === lastBase && !motion) {
        const dirty: Rect[] = [];
        const n = Math.max(people.length, prevPeople.length);
        for (let i = 0; i < n; i++) {
          const was = prevPeople[i], is = people[i];
          if (was && is && was.x === is.x && was.y === is.y && was.dir === is.dir && was.pose === is.pose && was.row === is.row) continue;
          if (was) dirty.push(was.rect);
          if (is) dirty.push(personRect(is));
        }
        if (pulseBucket !== lastPulse) {
          for (const s of staticRef.current) {
            if (s.kind === "desk" && P.byRoom.map.get(s.roomId as string)?.[0]?.attempt_status === "in_progress") dirty.push(deskRect(s));
          }
        }
        if (!dirty.length) return;
        regions = mergeRects(dirty, bw, bh);
        // 바뀐 자리가 화면의 셋 중 하나를 넘으면 그냥 전부 — 조각조각 그리는 값이 더 든다
        if (!regions.length || regions.reduce((sum, rg) => sum + rectArea(rg), 0) > bw * bh * 0.35) regions = null;
      }
      lastBase = base;
      lastPulse = pulseBucket;
      lastDrawAt = now;
      drawnInWindow += 1;
      drawNo += 1;

      /** 그림 한 조각을 dw×dh 로 한 번 굽는다 */
      const bakeSprite = (src: string, sx: number, sy: number, sw: number, sh: number, dw: number, dh: number, smooth: boolean) =>
        bake(`s|${src}|${sx}|${sy}|${sw}|${sh}|${dw}|${dh}|${smooth ? 1 : 0}`, dw, dh, (g) => {
          const img = image(src, bump);
          if (!ready(img)) return false;
          g.imageSmoothingEnabled = smooth;
          if (smooth) g.imageSmoothingQuality = "high";
          g.drawImage(img, sx, sy, sw, sh, 0, 0, dw, dh);
          return true;
        });

      /** 한 구역(월드 사각형)의 바닥 — 구역을 덮는 비트맵의 원점 기기 px 와 그 비트맵 안에서의 월드→기기 식 */
      const regionBox = (rx: number, ry: number, rw: number, rh: number) => {
        const X0 = R(rx), Y0 = R(ry);
        return { X0, Y0, W: R(rx + rw) - X0, H: R(ry + rh) - Y0, lx: (w: number) => R(w) - X0, ly: (w: number) => R(w) - Y0 };
      };
      /** 바닥 — 128px 그림을 PATCH 월드 px 로, 원점에 무늬를 맞춰 사각형 안만 채운다(구역 비트맵 안에서) */
      const tiled = (g: CanvasRenderingContext2D, box: ReturnType<typeof regionBox>, src: string, rx: number, ry: number, rw: number, rh: number, originX: number, originY: number): boolean => {
        const img = image(src, bump);
        if (!ready(img)) return false;
        const s = img.naturalWidth / PATCH;
        g.imageSmoothingEnabled = true;
        g.imageSmoothingQuality = "high";
        const startX = originX + Math.floor((rx - originX) / PATCH) * PATCH;
        const startY = originY + Math.floor((ry - originY) / PATCH) * PATCH;
        for (let py = startY; py < ry + rh; py += PATCH) {
          for (let px = startX; px < rx + rw; px += PATCH) {
            const x0 = Math.max(px, rx), y0 = Math.max(py, ry), x1 = Math.min(px + PATCH, rx + rw), y1 = Math.min(py + PATCH, ry + rh);
            if (x1 <= x0 || y1 <= y0) continue;
            const dx0 = box.lx(x0), dy0 = box.ly(y0), dx1 = box.lx(x1), dy1 = box.ly(y1);
            if (dx1 <= dx0 || dy1 <= dy0) continue;
            g.drawImage(img, (x0 - px) * s, (y0 - py) * s, (x1 - x0) * s, (y1 - y0) * s, dx0, dy0, dx1 - dx0, dy1 - dy0);
          }
        }
        return true;
      };
      const glow = (g: CanvasRenderingContext2D, cx: number, cy: number, rx: number, ry: number, stops: [number, string][], clip: [number, number, number, number]) => {
        g.save();
        g.beginPath();
        g.rect(clip[0], clip[1], clip[2], clip[3]);
        g.clip();
        g.translate(cx, cy);
        g.scale(1, ry / rx);
        const gr = g.createRadialGradient(0, 0, 0, 0, 0, rx);
        for (const [o, c] of stops) gr.addColorStop(o, c);
        g.fillStyle = gr;
        g.fillRect(-rx, -rx, rx * 2, rx * 2);
        g.restore();
      };
      const shadow = bake("shadow", shW, shH, (g) => {
        const rx = shW / 2, ry = shH / 2;
        g.translate(rx, ry);
        g.scale(1, ry / rx);
        const gr = g.createRadialGradient(0, 0, 0, 0, 0, rx);
        gr.addColorStop(0, "rgba(2,6,20,0.42)");
        gr.addColorStop(0.72, "rgba(2,6,20,0)");
        g.fillStyle = gr;
        g.fillRect(-rx, -rx, rx * 2, rx * 2);
        return true;
      });

      // 세계 — 발끝 y 로 정렬한 한 줄. 전부 구워 둔 비트맵의 1:1 복사다.
      type Draw = { z: number; group: number; order: number; s?: StaticItem; p?: PersonItem };
      const items: Draw[] = [];
      for (const s of staticRef.current) items.push({ z: s.z, group: s.group, order: s.order, s });
      for (const p of people) items.push({ z: p.z, group: p.group, order: p.order, p });
      items.sort((a, b) => a.z - b.z || a.group - b.group || a.order - b.order);
      const canFilter = typeof ctx.filter === "string";

      /** 한 자리(clip, 캔버스 px)를 그린다. null 이면 캔버스 전부. 걸리는 것만 고르고, 큰 바닥은 걸리는 조각만 복사한다 */
      const paint = (clip: Rect | null) => {
        const cx0 = clip ? clip.x0 : 0, cy0 = clip ? clip.y0 : 0, cx1 = clip ? clip.x1 : bw, cy1 = clip ? clip.y1 : bh;
        /** 구운 좌표의 사각형이 이 자리에 걸리는가 — 카메라(r, ox, oy)를 건 뒤의 자리로 판단한다 */
        const seen = (bx: number, by: number, w: number, h: number) => {
          const x0 = bx * r + ox, y0 = by * r + oy;
          return x0 + w * r > cx0 && y0 + h * r > cy0 && x0 < cx1 && y0 < cy1;
        };
        /** 구운 비트맵을 구운 좌표 (bx, by) 에 — 쉴 때는 정수 자리에 1:1(걸리는 조각만), 움직일 때는 늘여 그린다 */
        const put = (bmp: HTMLCanvasElement | null, bx: number, by: number) => {
          if (!bmp || !seen(bx, by, bmp.width, bmp.height)) return;
          if (motion) {
            ctx.drawImage(bmp, bx * r + ox, by * r + oy, bmp.width * r, bmp.height * r);
            return;
          }
          const dx = bx + ox, dy = by + oy;
          const ix0 = Math.max(dx, cx0), iy0 = Math.max(dy, cy0), ix1 = Math.min(dx + bmp.width, cx1), iy1 = Math.min(dy + bmp.height, cy1);
          if (ix1 <= ix0 || iy1 <= iy0) return;
          if (ix0 === dx && iy0 === dy && ix1 - ix0 === bmp.width && iy1 - iy0 === bmp.height) ctx.drawImage(bmp, dx, dy);
          else ctx.drawImage(bmp, ix0 - dx, iy0 - dy, ix1 - ix0, iy1 - iy0, ix0, iy0, ix1 - ix0, iy1 - iy0);
        };

        // ── 1. 복도 — 바닥 + 천장 조명 다섯 (한 장으로 구워 둔다) ──
        {
          const cor = P.floor.corridor;
          const cw = cor.right - cor.left, ch = cor.bottom - cor.top;
          const box = regionBox(cor.left, cor.top, cw, ch);
          if (seen(box.X0, box.Y0, box.W, box.H)) {
            const bmp = bake(`corridor|${cor.left},${cor.top},${cw},${ch}`, box.W, box.H, (g) => {
              if (!tiled(g, box, HALL_SRC, cor.left, cor.top, cw, ch, cor.left, cor.top)) return false;
              for (const lx of [64, 288, 512, 736, 960]) {
                glow(g, box.lx(cor.left + lx), box.ly(cor.top + ch / 2), 150 * K, 70 * K, [[0, "rgba(255,244,214,0.16)"], [0.72, "rgba(255,244,214,0)"]], [0, 0, box.W, box.H]);
              }
              return true;
            });
            put(bmp, box.X0, box.Y0);
          }
        }

        // ── 2. 방 바닥 — 칸 줄·문 통로·조명·안쪽 그림자·비네트를 방마다 한 장으로 ──
        for (const room of P.floor.rooms) {
          const L = P.layouts.get(room.id) as RoomLayout;
          const inner = innerOrigin(L.room);
          const W = L.room.cols * TILE, H = L.room.rows * TILE;
          const gap = doorGapOf(L.room);
          const bx0 = Math.min(inner.x, gap.x), by0 = Math.min(inner.y, gap.y);
          const bx1 = Math.max(inner.x + W, gap.x + gap.w), by1 = Math.max(inner.y + H, gap.y + gap.h);
          const box = regionBox(bx0, by0, bx1 - bx0, by1 - by0);
          if (!seen(box.X0, box.Y0, box.W, box.H)) continue; // 보이지 않는 방은 굽지도 않는다
          const entered = P.entered === room.id;
          const bmp = bake(`room|${room.id}|${entered ? 1 : 0}|${L.floors.length}`, box.W, box.H, (g) => {
            for (const f of L.floors) if (!tiled(g, box, floorSrc(f.floor), f.x, f.y, f.w, f.h, inner.x, inner.y)) return false;
            if (!tiled(g, box, floorSrc(L.room.floorKey), gap.x, gap.y, gap.w, gap.h, inner.x, inner.y)) return false;
            const cx = box.lx(inner.x), cy = box.ly(inner.y), cww = box.lx(inner.x + W) - cx, chh = box.ly(inner.y + H) - cy;
            const clipBox: [number, number, number, number] = [cx, cy, cww, chh];
            glow(g, box.lx(inner.x + W / 2), box.ly(inner.y + H * 0.4), (entered ? 220 : 200) * K, (entered ? 160 : 140) * K,
              [[0, `rgba(255,246,220,${entered ? 0.2 : 0.1})`], [entered ? 0.72 : 0.7, "rgba(255,246,220,0)"]], clipBox);
            if (entered) {
              g.save();
              g.globalAlpha = 0.03;
              g.fillStyle = L.room.accent;
              g.fillRect(cx, cy, cww, chh);
              g.restore();
            }
            // 안쪽 그림자(가장자리가 살짝 어둡다)
            const band = Math.max(1, Math.round(14 * K));
            const edge = (x0: number, y0: number, x1: number, y1: number, rx: number, ry: number, rw: number, rh: number) => {
              const gr = g.createLinearGradient(x0, y0, x1, y1);
              gr.addColorStop(0, "rgba(3,5,12,0.3)");
              gr.addColorStop(1, "rgba(3,5,12,0)");
              g.fillStyle = gr;
              g.fillRect(rx, ry, rw, rh);
            };
            edge(cx, cy, cx, cy + band, cx, cy, cww, band);
            edge(cx, cy + chh, cx, cy + chh - band, cx, cy + chh - band, cww, band);
            edge(cx, cy, cx + band, cy, cx, cy, band, chh);
            edge(cx + cww, cy, cx + cww - band, cy, cx + cww - band, cy, band, chh);
            // 비네트
            glow(g, box.lx(inner.x + W / 2), box.ly(inner.y + H * 0.45), 1.2 * W * K, 1.2 * H * K,
              [[0, "rgba(4,7,14,0)"], [0.68, "rgba(4,7,14,0)"], [1, "rgba(4,7,14,0.26)"]], clipBox);
            return true;
          });
          put(bmp, box.X0, box.Y0);
        }

        // ── 3. 세계 ──
        for (const it of items) {
          if (it.s) {
            const s = it.s;
            if (s.kind === "wall") {
              // 벽 칸 — 크기 48·k 가 정수라 이웃 칸과 모서리를 나눈다
              const x0 = R(s.wx), y0 = R(s.wy);
              const ww = R(s.wx + s.ww) - x0, wh = R(s.wy + s.wh) - y0;
              if (!seen(x0, y0, ww, wh)) continue;
              put(bakeSprite(s.src, s.sx, s.sy, s.sw, s.sh, ww, wh, false), x0, y0);
              continue;
            }
            // 소품·책상 — 발끝 선(아랫변)을 격자에 맞추고 크기는 그림마다 하나로 굽는다
            const dw = R(s.ww), dh = R(s.wh);
            const x0 = R(s.wx), y0 = R(s.wy + s.wh) - dh;
            if (s.kind === "desk") {
              const a = P.byRoom.map.get(s.roomId as string)?.[0];
              if (!a) continue;
              // 불빛이 그림 밖으로 번지므로 걸림 판정은 그만큼 넓게
              const m = Math.ceil(8 * k) + 2;
              if (!seen(x0 - m, y0 - m, dw + 2 * m, dh + 2 * m)) continue;
              const bmp = bakeSprite(s.src, s.sx, s.sy, s.sw, s.sh, dw, dh, false);
              const finished = Boolean(a.attempt_status && a.attempt_status !== "in_progress");
              const resuming = a.attempt_status === "in_progress";
              let filter = "none";
              if (resuming && !still) {
                const t = (1 - Math.cos((now / 2400) * Math.PI * 2)) / 2;
                filter = `brightness(${(1 + 0.22 * t).toFixed(3)}) drop-shadow(0 0 ${(5 * k).toFixed(1)}px rgba(232,185,106,${(0.6 * t).toFixed(3)}))`;
              } else if (P.peekedId === a.assessment_id) {
                filter = `brightness(1.18) drop-shadow(0 0 ${(4 * k).toFixed(1)}px rgba(127,212,255,0.55))`;
              } else if (finished) {
                filter = "saturate(0.6) brightness(0.9)";
              }
              if (canFilter && filter !== "none") ctx.filter = filter;
              // 번짐이 있는 그림은 조각으로 자르지 않는다(자르면 번짐이 끊긴다) — clip 이 밖을 막는다
              if (bmp && filter !== "none" && !motion) ctx.drawImage(bmp, x0 + ox, y0 + oy);
              else put(bmp, x0, y0);
              if (canFilter && filter !== "none") ctx.filter = "none";
              continue;
            }
            if (!seen(x0, y0, dw, dh)) continue;
            put(bakeSprite(s.src, s.sx, s.sy, s.sw, s.sh, dw, dh, false), x0, y0);
            continue;
          }
          const p = it.p as PersonItem;
          // 발밑 그림자 — 발끝 아래로 살짝, 발을 가리지 않게
          put(shadow, R(p.x - 11), R(p.y - 4));
          const cell = personSheetCell(p.row, p.dir, p.pose);
          // 시트는 원본 픽셀 그대로다 — 정수 시트 좌표로 꺼내 이 배율에서 **한 번만** 옮겨 굽는다.
          // 줄일 때(k < 시트 배율)는 부드럽게, 늘릴 때는 도트가 도트로 남게 최근접으로.
          const upscale = pw >= PERSON_SHEET_W;
          const x0 = R(p.x) - Math.round(pw / 2), y0 = R(p.y) - ph;
          if (!seen(x0, y0, pw, ph)) continue;
          put(bakeSprite(PEOPLE_SRC, cell.x, cell.y, PERSON_SHEET_W, PERSON_SHEET_H, pw, ph, !upscale), x0, y0);
        }
      };

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      // 쉴 때는 1:1 복사라 표본을 고를 일이 없고, 움직일 때는 늘여 그리므로 부드럽게(최근접이면 확대 도중 무늬가 반짝인다).
      // 가벼운 모드는 옮기는 중에도 최근접 — CPU 로 보간까지 하면 옮기는 내내 버벅인다. 잠깐 반짝이는 쪽이 낫다.
      ctx.imageSmoothingEnabled = motion && !lite;
      if (!regions) {
        ctx.clearRect(0, 0, bw, bh);
        paint(null);
      } else {
        for (const rg of regions) {
          ctx.save();
          ctx.beginPath();
          ctx.rect(rg.x0, rg.y0, rg.x1 - rg.x0, rg.y1 - rg.y0);
          ctx.clip();
          ctx.clearRect(rg.x0, rg.y0, rg.x1 - rg.x0, rg.y1 - rg.y0);
          paint(rg);
          ctx.restore();
        }
      }

      handle.draws += 1;
      handle.mode = motion ? "motion" : "baked";
      handle.bakeK = K;
      handle.k = k;
      handle.lite = lite;
      handle.regions = regions ? regions.length : 0;
      // 큰 비트맵이 쌓이면(넓은 방을 크게 보다가 옮겨 다니면) 한동안 안 쓴 것부터 비운다 — 기기 px 3200만 개(약 128MB) 기준
      if (bakedPixels > 32_000_000) {
        for (const [key, c] of baked) {
          if ((lastUse.get(key) ?? 0) >= drawNo - 30) continue;
          baked.delete(key);
          lastUse.delete(key);
          bakedPixels -= c.width * c.height;
        }
      }
      // 다음 프레임이 "무엇이 바뀌었나" 를 셀 재료 — 사람마다 지금 자리
      prevPeople = motion ? [] : people.map((p) => ({ x: p.x, y: p.y, dir: p.dir, pose: p.pose, row: p.row, rect: personRect(p) }));
      const snapshot = people.map((q) => ({ n: q.name, x: q.x, y: q.y, dir: q.dir, pose: q.pose, me: q.me }));
      handle.people = () => snapshot;
      // 사람 그림의 페이지 사각형 — 물어볼 때만 잰다(getBoundingClientRect 는 레이아웃을 강제하므로 프레임마다 부르지 않는다)
      const local = people.map((p) => {
        const x0 = (R(p.x) - Math.round(pw / 2)) * r + ox, y0 = (R(p.y) - ph) * r + oy;
        return [x0 / dpr, y0 / dpr, (x0 + pw * r) / dpr, (y0 + ph * r) / dpr] as [number, number, number, number];
      });
      handle.peopleRects = () => {
        const cr = canvas.getBoundingClientRect();
        return local.map(([a, b, c, d]) => [cr.left + a, cr.top + b, cr.left + c, cr.top + d] as [number, number, number, number]);
      };
    };

    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  return <canvas ref={canvasRef} className="office-canvas" data-office-canvas="" aria-hidden="true" />;
}

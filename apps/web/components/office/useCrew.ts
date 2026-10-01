"use client";

import { MEET_RANGE, NPC_WALK_SPEED, NPC_STEP_MS } from "./life";
import { TILE } from "./floorplan";
import { useEffect, useRef, useState } from "react";
import { dirOf, dirTo, type Dir, type Pose } from "@/lib/people";
import type { OfficeColleague } from "@/lib/types";

/** 한 사람이 지금 어디서 어디를 보고 있는가. 화면과 '다가갔는가' 판정이 **이 목록
 *  하나**를 같이 본다. 두 군데서 따로 계산하면 말 걸기 표시가 허공에 뜬다. */
export interface CrewMember {
  key: string;
  c: OfficeColleague;
  roomId: string;
  /** 발끝 월드 좌표 */
  x: number;
  y: number;
  dir: Dir;
  pose: Pose;
}

/** 한 사람을 어디에 둘지 — 배치기가 정해서 넘겨주는 것 */
export interface CrewSeed {
  key: string;
  c: OfficeColleague;
  roomId: string;
  /** 처음 서는 자리, 발끝 좌표 */
  home: { x: number; y: number };
  /** 가만히 있을 때 보는 방향 — 장면이 정한다(화이트보드를 본다, 마주 본다 …) */
  face: Dir;
  /** 오갈 수 있는 자리들(같은 방 안). 자리마다 보는 방향이 있다. */
  roam: { x: number; y: number; face: Dir }[];
}

/** 자리 하나를 두 사람이 차지하지 않게 — 서 있는 사람은 제자리를, 걷는 사람은 목적지를 찜한다.
 *  걷는 도중에 스쳐 지나는 것은 괜찮다(사람은 서로를 비켜 간다). 멈춰 서는 자리만 겹치지 않으면 된다. */
const claimKey = (p: { x: number; y: number }) => `${Math.round(p.x)},${Math.round(p.y)}`;

/** 사람은 두 칸 키라, 한 사람의 바로 위·아래 칸에 서면 그림이 포개진다. 멈춰 서는 자리는 이 상자 밖이어야 한다 —
 *  옆 칸은 괜찮다(어깨를 나란히 하는 것은 포개지지 않는다). */
const STACK_W = 36;
const STACK_H = 77;
const stacks = (p: { x: number; y: number }, q: { x: number; y: number }) =>
  Math.abs(p.x - q.x) < STACK_W && Math.abs(p.y - q.y) < STACK_H;

/** 이 거리 안에 사람이 오면 하던 일을 멈추고 고개를 돌린다.
 *  말 걸기 사거리(96)보다 조금 넉넉해야, 말을 걸 수 있게 된 순간에는 **이미**
 *  나를 보고 있다. 사거리에 딱 맞추면 고개가 도는 것과 안내가 동시에 떠서 어색하다. */
const NOTICE = 120;

/** 서 있는 사람이 한 자리에 머무는 시간(ms). 사람마다 다르게 흩어 놓는다. */
const DWELL_MIN = 4200;
const DWELL_SPAN = 7000;
/** 걷는 속도(월드 px/초). 아바타(300)보다 느긋해야 배경으로 읽힌다. */
const SPEED = NPC_WALK_SPEED;
/** 다리가 바뀌는 간격 */
const STEP_MS = NPC_STEP_MS;
/** 화면을 다시 그리는 간격. 도트라 60fps 가 필요 없고, 사람이 일흔 명이라
 *  매 프레임 다시 그리면 방에 들어갈 때 눈에 띄게 버벅인다. */
const DRAW_MS = 90;

/** 문자열 → 0..1. 같은 사람은 언제나 같은 리듬으로 움직인다(서버·브라우저 동일). */
function hash01(seed: string, salt: number): number {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

interface Agent extends CrewMember {
  roam: { x: number; y: number; face: Dir }[];
  home: { x: number; y: number };
  /** 지금 걸어가는 목적지. null 이면 서 있다. */
  target: { x: number; y: number; face: Dir } | null;
  /** 목적지까지의 길(꺾이는 점들 + 목적지). 가구·벽을 돌아간다. */
  path: { x: number; y: number }[];
  /** 이 시각이 지나면 다음 자리로 옮긴다 */
  moveAt: number;
  stepAt: number;
  /** 원래 보던 방향 — 사람이 지나가고 나면 여기로 돌아온다 */
  rest: Dir;
  /** 잡담 짝의 옆자리로 걸어가는 중이면 그 사람의 key */
  approach: string | null;
}

function seedAgents(seeds: CrewSeed[], now: number): Agent[] {
  const agents: Agent[] = seeds.map((s) => ({
    key: s.key,
    c: s.c,
    roomId: s.roomId,
    x: s.home.x,
    y: s.home.y,
    dir: s.face,
    pose: "idle" as Pose,
    roam: s.roam,
    home: s.home,
    target: null,
    path: [],
    moveAt: now + DWELL_MIN + hash01(s.key, 7) * DWELL_SPAN,
    stepAt: 0,
    rest: s.face,
    approach: null,
  }));
  // 장면이 준 첫 자리가 앞사람과 포개지면 곧 자리를 옮긴다 — 첫 화면부터 겹쳐 보이지 않게
  agents.forEach((a, i) => {
    if (agents.slice(0, i).some((o) => o.roomId === a.roomId && stacks(a, o))) a.moveAt = now + 800 + hash01(a.key, 13) * 1200;
  });
  return agents;
}

function reduceMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * 사무실 사람들을 살려 둔다.
 *
 * 세 가지가 동시에 돌아간다.
 *  1. **모두 서 있다.** 자리마다 보는 방향이 있다 — 화이트보드를 보거나, 마주 보거나.
 *  2. **몇 초에 한 번 옆자리로 옮긴다.** 걷는 동안 `idle`/`move` 두 자세를 번갈아
 *     쓴다 — 여덟 장을 다 쓰는 건 이 루프다. 도착하면 그 자리가 정한 방향을 본다.
 *  3. **누가 다가오면 그 사람을 본다.** 고개를 돌리고 걸음을 멈춘다. 말을 걸 수 있게 되는 순간 상대가 등을 돌리고 있으면 말 걸기 안내가
 *     거짓말이 된다.
 *
 * 위치를 화면과 근접 판정이 **같은 배열**에서 읽는다. 예전에는 렌더가 쓰는 좌표와
 * 판정이 쓰는 좌표를 따로 계산했고, 그래서 사람이 없는 자리에 말 걸기 표시가 떴다.
 */
export function useCrew(
  seeds: CrewSeed[],
  player: { x: number; y: number },
  /** 멈춰 세울 조건 — 목록 모드이거나 대화 중이면 움직이지 않는다 */
  paused: boolean,
  /** 두 점 사이의 길. 없는 자리로는 가지 않는다(직선으로 가면 책상을 뚫는다). */
  route?: (from: { x: number; y: number }, to: { x: number; y: number }) => { x: number; y: number }[] | null,
  /** 그리는 쪽(캔버스)이 **지금 이 순간**의 사람들을 읽는 자리. React 상태(view)는 90ms 마다 묶여 나가지만 그림은
   *  매 프레임 살아 있는 값을 봐야 한다 — 걸음을 멈춘 바로 그 프레임이 화면에 나온다. */
  live?: { current: readonly CrewMember[] },
  social?: { held: ReadonlySet<string>; partners: ReadonlyMap<string, string> },
): CrewMember[] {
  const socialRef = useRef(social);
  socialRef.current = social;
  const agents = useRef<Agent[]>([]);
  const [view, setView] = useState<CrewMember[]>(() => seedAgents(seeds, 0));
  const playerRef = useRef(player);
  playerRef.current = player;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const routeRef = useRef(route);
  routeRef.current = route;
  const liveRef = useRef(live);
  liveRef.current = live;

  // 배치가 바뀌면(시험 목록이 바뀌었다) 사람들을 처음 자리에 다시 세운다.
  useEffect(() => {
    const now = typeof performance !== "undefined" ? performance.now() : 0;
    agents.current = seedAgents(seeds, now);
    if (liveRef.current) liveRef.current.current = agents.current;
    setView(agents.current.map(snapshot));
  }, [seeds]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const still = reduceMotion();
    let raf = 0;
    let last = performance.now();
    let drewAt = 0;
    /** 바뀌었는데 아직 내보내지 못한 것이 있는가. 묶어 내보내는 간격(DRAW_MS) 안에서 바뀐 **마지막** 상태 — 걸음을 멈추고
     *  서는 순간 — 가 그 다음 틱에 바뀐 것이 없다는 이유로 버려지면, 사람이 걷는 자세로 굳는다(2026-09-13 지적). */
    let dirty = false;

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const me = playerRef.current;
      const frozen = pausedRef.current;
      let changed = false;

      for (const a of agents.current) {
        if (socialRef.current?.held.has(a.key)) {
          const partnerKey = socialRef.current.partners.get(a.key);
          const partner = partnerKey ? agents.current.find(other => other.key === partnerKey) : undefined;
          // 잡담 짝이 옆자리에 없으면 키가 작은 쪽이 상대의 한 칸 옆으로 걸어간다 — 마주 서서 말해야 잡담으로 읽힌다.
          // 상대는 서서 기다린다. 옆자리가 막혀 있으면 떨어진 채로 마주 본다(첫 줄은 useOfficeLife 가 잠시 기다려 준다).
          if (partner && a.key < partner.key && Math.hypot(a.x - partner.x, a.y - partner.y) > MEET_RANGE) {
            if (a.approach !== partner.key || !a.target) {
              a.approach = partner.key;
              a.target = null; a.path = [];
              const claims = agents.current.filter((o) => o !== a && o !== partner && o.roomId === a.roomId).map((o) => o.target ?? { x: o.x, y: o.y });
              // 바로 옆자리가 먼저, 막혀 있으면 한 칸 건너. 위·아래 칸은 그림이 포개져 쓰지 않는다
              const sides = [1, 2].flatMap((n) => [
                { x: partner.x - TILE * n, y: partner.y, face: "right" as Dir },
                { x: partner.x + TILE * n, y: partner.y, face: "left" as Dir },
              ]).sort((p, q) => Math.abs(p.x - partner.x) - Math.abs(q.x - partner.x) || Math.hypot(p.x - a.x, p.y - a.y) - Math.hypot(q.x - a.x, q.y - a.y));
              for (const side of sides) {
                if (claims.some((q) => claimKey(q) === claimKey(side) || stacks(side, q))) continue;
                const path = routeRef.current ? routeRef.current(a, side) : [side];
                if (path) { a.target = side; a.path = path; break; }
              }
            }
            if (!a.target) {
              const face = dirTo(a, partner, a.dir);
              if (a.pose !== "idle" || a.dir !== face) changed = true;
              a.pose = "idle"; a.dir = face; a.moveAt = now + DWELL_MIN;
              continue;
            }
            // 목적지가 있으면 아래 걷기 코드가 옮긴다
          } else {
            const anchor = partner ?? me;
            const face = dirTo(a, anchor, a.dir);
            if (a.target || a.pose !== "idle" || a.dir !== face) changed = true;
            a.target = null; a.path = []; a.pose = "idle"; a.dir = face;
            a.approach = null;
            a.moveAt = now + DWELL_MIN;
            continue;
          }
        } else if (a.approach) {
          // 잡담이 끝났거나 취소됐다 — 가던 길을 멈추고 평소대로 돌아간다
          a.approach = null; a.target = null; a.path = []; a.pose = "idle";
          a.moveAt = now + 1500;
          changed = true;
        }
        // ── 다가온 사람을 본다 ──
        const near = Math.hypot(me.x - a.x, me.y - a.y) < NOTICE;
        const want = near ? dirTo(a, me, a.rest) : a.dir;
        if (near) {
          // 말을 거는 사람 앞에서 걸어가 버리지 않는다. 걷던 중이었다면 선 자세로 바뀐 것도 '바뀐 것'이다.
          if (a.target || a.pose !== "idle") changed = true;
          a.target = null;
          a.path = [];
          a.pose = "idle";
          a.moveAt = now + DWELL_MIN;
          if (a.dir !== want) {
            a.dir = want;
            changed = true;
          }
          continue;
        }

        if (frozen || still || a.roam.length < 2) {
          if (a.dir !== a.rest || a.pose !== "idle") {
            a.dir = a.rest;
            a.pose = "idle";
            changed = true;
          }
          continue;
        }

        // ── 다음 자리로 옮길 때가 되었는가 ──
        if (!a.target && now >= a.moveAt) {
          // 같은 방에서 누가 찜한 자리는 뺀다 — 서 있는 사람은 제자리를, 걷는 사람은 목적지를 찜하고 있다.
          // 남과 위아래로 포개지는 자리도 뺀다.
          const claims = agents.current.filter((o) => o !== a && o.roomId === a.roomId).map((o) => o.target ?? { x: o.x, y: o.y });
          const claimed = new Set(claims.map(claimKey));
          const pool = a.roam.filter(
            (p) => Math.hypot(p.x - a.x, p.y - a.y) > 8 && !claimed.has(claimKey(p)) && !claims.some((q) => stacks(p, q)),
          );
          if (pool.length) {
            const pick = Math.floor(hash01(a.key, Math.floor(now / 1000)) * pool.length);
            const spot = pool[Math.min(pool.length - 1, pick)];
            const path = routeRef.current ? routeRef.current(a, spot) : [spot];
            if (path) { a.target = spot; a.path = path; }
            else a.moveAt = now + 1500; // 길이 없는 자리 — 조금 뒤에 다른 자리를 고른다
          }
        }

        if (!a.target) continue;

        const wp = a.path[0] ?? a.target;
        const dx = wp.x - a.x;
        const dy = wp.y - a.y;
        const dist = Math.hypot(dx, dy);
        if (dist < 1.5) {
          a.x = wp.x;
          a.y = wp.y;
          if (a.path.length > 1) { a.path.shift(); continue; }
          a.path = [];
          const arrived = a.roam.find((p) => p.x === a.target?.x && p.y === a.target?.y);
          a.target = null;
          a.pose = "idle";
          a.rest = arrived ? arrived.face : a.dir; // 도착한 자리가 정한 방향을 본다 — 보드를, 상대를
          a.dir = a.rest;
          a.moveAt = now + DWELL_MIN + hash01(a.key, Math.floor(now / 997)) * DWELL_SPAN;
          changed = true;
          continue;
        }
        const move = Math.min(dist, SPEED * dt);
        a.x += (dx / dist) * move;
        a.y += (dy / dist) * move;
        a.dir = dirOf(dx, dy, a.dir);
        if (now - a.stepAt > STEP_MS) {
          a.stepAt = now;
          a.pose = a.pose === "idle" ? "move" : "idle";
        }
        changed = true;
      }

      // 도트는 60fps 가 필요 없다. 사람이 일흔 명이면 매 프레임 다시 그리는 비용이
      // 그대로 방에 들어갈 때의 버벅임이 된다.
      if (changed) dirty = true;
      if (dirty && now - drewAt >= DRAW_MS) {
        drewAt = now;
        dirty = false;
        setView(agents.current.map(snapshot));
      }
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return view;
}

/** 화면이 읽는 몫만 떼어 낸다 — 좌표는 정수로 맞춘다(도트가 반 픽셀에 걸리면 흐려진다). */
function snapshot(a: Agent): CrewMember {
  return {
    key: a.key,
    c: a.c,
    roomId: a.roomId,
    x: Math.round(a.x),
    y: Math.round(a.y),
    dir: a.dir,
    pose: a.pose,
  };
}

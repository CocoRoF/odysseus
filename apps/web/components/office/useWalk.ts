"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { dirOf, type Dir } from "@/lib/people";

export interface Point {
  x: number;
  y: number;
}

/** 걷는 속도(월드 픽셀/초)와 다리가 바뀌는 간격(ms). */
const SPEED = 420;
/** 방향키로 직접 몰 때는 조금 느리게. 빠르면 문틈을 지나치기 쉽다. */
const DRIVE_SPEED = 300;
const STEP_MS = 150;

function reduceMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** 두 점 사이의 방향. 시트가 쓰는 네 단어를 그대로 돌려준다 — 여기서 자기만의
 *  약어를 만들면 화면까지 가는 사이에 번역이 한 번 더 생긴다. */
function dirBetween(from: Point, to: Point, prev: Dir): Dir {
  return dirOf(to.x - from.x, to.y - from.y, prev);
}

/** 복도를 거쳐 가는 ㄱ자 경로. 사무실에서 벽을 통과하지 않으려면 이 정도면 충분하다.
 *  복도의 높이는 층마다 다르므로(방 수에 따라 월드가 달라진다) 밖에서 받는다. */
function pathTo(from: Point, to: Point, corridorY: number): Point[] {
  const way: Point[] = [];
  if (Math.abs(from.y - corridorY) > 1) way.push({ x: from.x, y: corridorY });
  if (Math.abs(to.x - from.x) > 1) way.push({ x: to.x, y: corridorY });
  way.push(to);
  return way;
}

/** 아바타의 위치·방향·다리.
 *
 * 움직이는 길이 둘이다. 자리를 누르면 그리로 **걸어가고**(`walkTo`), 방향키를 누르고
 * 있으면 그 방향으로 **몬다**(`drive`). 둘을 한 루프에서 돌리는 이유는, 걸어가는 중에
 * 방향키를 누르면 그 즉시 조종이 사람에게 넘어와야 하기 때문이다. 루프가 둘이면 두
 * 아바타가 서로 다른 곳으로 가려고 다툰다.
 *
 * 걷기는 **연출일 뿐이다.** 목적지에 닿는 것이 어떤 동작의 전제조건이 되면 안 되고
 * (그러면 걷지 못하는 사람은 시험을 시작할 수 없다), `prefers-reduced-motion` 이
 * 켜져 있으면 즉시 도착한다.
 */
export function useWalk(
  home: Point,
  corridorY: number,
  /** 이 자리에 설 수 있는가. 없으면 벽을 통과한다(방향키를 쓰지 않는 화면). */
  canStand?: (x: number, y: number) => boolean,
  /** 두 점 사이의 길(꺾이는 점들 + 목적지). 없으면 복도를 거치는 ㄱ자로 간다. */
  route?: (from: Point, to: Point) => Point[] | null,
) {
  const [pos, setPos] = useState<Point>(home);
  const [dir, setDir] = useState<Dir>("down");
  /** 지금 그릴 자세. 걸을 때만 idle 과 move 를 번갈아 쓴다. */
  const [pose, setPose] = useState<"idle" | "move">("idle");
  const [walking, setWalking] = useState(false);
  const dirRef = useRef<Dir>("down");

  const frame = useRef<number | null>(null);
  const queue = useRef<Point[]>([]);
  const drive = useRef<Point>({ x: 0, y: 0 });
  const posRef = useRef<Point>(home);
  /** 지금 걷는 빠르기(월드 px/초). walkTo 가 정한다 */
  const speedRef = useRef(SPEED);
  const stepAt = useRef(0);
  const lastAt = useRef(0);
  const standRef = useRef(canStand);
  standRef.current = canStand;
  const routeRef = useRef(route);
  routeRef.current = route;

  const halt = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    setWalking(false);
    setPose("idle");
  }, []);

  const stop = useCallback(() => {
    queue.current = [];
    drive.current = { x: 0, y: 0 };
    halt();
  }, [halt]);

  /** 한 프레임. 사람이 몰고 있으면 그쪽이 이기고, 아니면 남은 경로를 따라간다. */
  const tick = useCallback(
    (now: number) => {
      const dt = Math.min(0.05, (now - lastAt.current) / 1000);
      lastAt.current = now;
      const stand = standRef.current;

      const d = drive.current;
      if (d.x !== 0 || d.y !== 0) {
        queue.current = []; // 사람이 잡으면 가던 길은 버린다
        const len = Math.hypot(d.x, d.y) || 1;
        const move = DRIVE_SPEED * dt;
        const nx = posRef.current.x + (d.x / len) * move;
        const ny = posRef.current.y + (d.y / len) * move;
        // 축을 따로 본다. 벽에 비스듬히 붙어도 벽을 따라 미끄러진다.
        const next = { ...posRef.current };
        if (!stand || stand(nx, next.y)) next.x = nx;
        if (!stand || stand(next.x, ny)) next.y = ny;

        // 문 보정. 문은 두 칸(64px)뿐이라 방향키만으로 정확히 겨누기가 빡빡하다.
        // 가려는 쪽이 막혔으면 옆으로 조금씩 밀어 보고, 들어갈 틈이 있으면 그리로
        // 끌어당긴다. 게임에서 흔히 쓰는 보정이고, 없으면 문 앞에서 좌우로 더듬게 된다.
        if (stand) {
          const FUNNEL = [5, -5, 10, -10, 15, -15, 20, -20];
          if (next.y === posRef.current.y && d.y !== 0) {
            for (const off of FUNNEL) {
              if (stand(posRef.current.x + off, ny)) {
                next.x = posRef.current.x + off;
                next.y = ny;
                break;
              }
            }
          }
          if (next.x === posRef.current.x && d.x !== 0) {
            for (const off of FUNNEL) {
              if (stand(nx, posRef.current.y + off)) {
                next.x = nx;
                next.y = posRef.current.y + off;
                break;
              }
            }
          }
        }
        if (next.x !== posRef.current.x || next.y !== posRef.current.y) {
          const face = dirBetween(posRef.current, next, dirRef.current);
          dirRef.current = face;
          setDir(face);
          posRef.current = next;
          setPos(next);
          if (now - stepAt.current > STEP_MS) {
            stepAt.current = now;
            setPose((p) => (p === "idle" ? "move" : "idle"));
          }
        }
        frame.current = requestAnimationFrame(tick);
        return;
      }

      const target = queue.current[0];
      if (!target) {
        halt();
        return;
      }
      const dx = target.x - posRef.current.x;
      const dy = target.y - posRef.current.y;
      const dist = Math.hypot(dx, dy);
      if (dist < 2) {
        posRef.current = target;
        setPos(target);
        queue.current.shift();
        frame.current = requestAnimationFrame(tick);
        return;
      }
      const move = Math.min(dist, speedRef.current * dt);
      const moved = {
        x: posRef.current.x + (dx / dist) * move,
        y: posRef.current.y + (dy / dist) * move,
      };
      const face = dirBetween(posRef.current, target, dirRef.current);
      dirRef.current = face;
      setDir(face);
      posRef.current = moved;
      setPos(moved);
      if (now - stepAt.current > STEP_MS) {
        stepAt.current = now;
        setPose((p) => (p === "idle" ? "move" : "idle"));
      }
      frame.current = requestAnimationFrame(tick);
    },
    [halt],
  );

  const start = useCallback(() => {
    if (frame.current !== null) return;
    lastAt.current = performance.now();
    setWalking(true);
    frame.current = requestAnimationFrame(tick);
  }, [tick]);

  /** 방향키로 몬다. (0, 0) 을 주면 선다. */
  const setDrive = useCallback(
    (x: number, y: number) => {
      drive.current = { x, y };
      if (x === 0 && y === 0) {
        if (queue.current.length === 0) halt();
        return;
      }
      start();
    },
    [start, halt],
  );

  const walkTo = useCallback(
    (target: Point, speed = SPEED) => {
      drive.current = { x: 0, y: 0 };
      speedRef.current = speed;
      if (reduceMotion()) {
        const d = dirBetween(posRef.current, target, dirRef.current);
        dirRef.current = d;
        setDir(d);
        posRef.current = target;
        setPos(target);
        queue.current = [];
        halt();
        return;
      }
      queue.current = routeRef.current?.(posRef.current, target) ?? pathTo(posRef.current, target, corridorY);
      start();
    },
    [corridorY, start, halt],
  );

  /** 층이 바뀌면(시험 목록이 바뀌었다) 아바타를 다시 문 앞에 세운다. */
  const teleport = useCallback(
    (target: Point) => {
      stop();
      posRef.current = target;
      setPos(target);
    },
    [stop],
  );

  useEffect(() => stop, [stop]);

  return { pos, dir, pose, walking, walkTo, setDrive, teleport, stop };
}

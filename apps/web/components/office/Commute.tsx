"use client";

import { useEffect, useRef, useState } from "react";
import { type Pose } from "@/lib/people";
import { FLOOR_SRC, OFFICE_ASSET_VARS, S, type SpriteName } from "./atlas";
import { TILE, WALL, wallPieces } from "./floorplan";
import { wallDraw, wallStyle } from "./wall-draw";
import { Person } from "./Person";
import { Sprite } from "./Sprite";

/** 고정된 복도 월드에서 실제로 걷고, 카메라가 아바타의 발끝을 따라간다.
 * 바닥·벽·소품·광원은 모두 월드 좌표다. 빛까지의 거리가 주변 밝기를 결정한다. */
const WALK_MS = 3800;
const FLASH_IN_MS = 650;
const FLASH_OUT_MS = 900;
const WAIT_NOTICE_MS = 1500;
const START_Y = 720;
const END_Y = 1200;
const LIGHT_Y = 1440;
const HALL_COLS = 6;
const HALL_ROWS = 64;
const HALL_W = (HALL_COLS + 2) * TILE;
const HALL_H = (HALL_ROWS + 3) * TILE;
const ME_X = WALL + HALL_COLS * TILE / 2;
const HALL_WALLS = wallPieces(
  { x: 0, y: 0, cols: HALL_COLS, rows: HALL_ROWS, side: "south", doorC: 2 },
  new Uint8Array(HALL_COLS * HALL_ROWS), "office",
).map(wallDraw);
const PLANTS: SpriteName[] = ["plant-tall-1", "plant-palm-1", "plant-tall-3", "plant-bush-1"];
const HALL_PROPS = Array.from({ length: 16 }, (_, i) => {
  const name = PLANTS[i % PLANTS.length];
  const y = 240 + Math.floor(i / 2) * 288 + (i % 2) * 80;
  return { name, x: WALL + (i % 2 ? HALL_COLS - 1 : 0) * TILE, y: y - S[name].h, z: y };
});

type Phase = "walk" | "wait" | "flash" | "reveal";

export function Commute({
  name,
  row,
  ready,
  onEnter,
  onGone,
}: {
  name: string;
  /** 내 아바타의 시트 줄. 아직 모르면 null (사람을 그리지 않는다) */
  row: number | null;
  /** 사무실을 그릴 준비가 됐는가. 안 됐으면 빛 앞에서 기다린다 */
  ready: boolean;
  /** 빛이 화면을 다 덮은 순간. 이때 사무실이 켜지기 시작한다 */
  onEnter: () => void;
  /** 빛이 걷힌 뒤. 이 컴포넌트를 내려도 된다 */
  onGone: () => void;
}) {
  const [phase, setPhase] = useState<Phase>("walk");
  const [positionY, setPositionY] = useState(START_Y);
  const [pose, setPose] = useState<Pose>("idle");
  const [waitedLong, setWaitedLong] = useState(false);
  const enterRef = useRef(onEnter);
  enterRef.current = onEnter;
  const goneRef = useRef(onGone);
  goneRef.current = onGone;
  const readyRef = useRef(ready);
  readyRef.current = ready;

  const walking = phase === "walk" || phase === "wait";

  // 하나의 시계로 월드 위치·걸음·도착을 계산한다. 카메라는 같은 위치를 읽는다.
  useEffect(() => {
    if (phase !== "walk") { setPose("idle"); return; }
    let frame = 0;
    let elapsed = 0;
    let previous = 0;
    const tick = (now: number) => {
      if (previous) elapsed += Math.min(now - previous, 50);
      previous = now;
      const progress = Math.min(1, elapsed / WALK_MS);
      setPositionY(START_Y + (END_Y - START_Y) * progress);
      setPose(Math.floor(elapsed / 150) % 2 ? "move" : "idle");
      if (progress === 1) setPhase(readyRef.current ? "flash" : "wait");
      else frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [phase]);

  useEffect(() => {
    if (phase === "wait" && ready) setPhase("flash");
  }, [phase, ready]);

  useEffect(() => {
    if (phase !== "wait") return;
    const t = setTimeout(() => setWaitedLong(true), WAIT_NOTICE_MS);
    return () => clearTimeout(t);
  }, [phase]);

  // 빛이 다 덮이면 사무실이 켜지기 시작하고, 그 위에서 빛이 걷힌다. animationend 에 기대지 않는다
  useEffect(() => {
    if (phase !== "flash") return;
    const t = setTimeout(() => {
      enterRef.current();
      setPhase("reveal");
    }, FLASH_IN_MS);
    return () => clearTimeout(t);
  }, [phase]);

  useEffect(() => {
    if (phase !== "reveal") return;
    const t = setTimeout(() => goneRef.current(), FLASH_OUT_MS);
    return () => clearTimeout(t);
  }, [phase]);

  const skip = () => {
    if (!walking) return;
    setPhase(readyRef.current ? "flash" : "wait");
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" && e.key !== " " && e.key !== "Escape") return;
      e.preventDefault();
      skip();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walking]);

  const sub = phase === "wait" && waitedLong ? "사무실을 준비하고 있습니다." : "맡을 업무가 기다리고 있습니다.";

  const progress = Math.max(0, Math.min(1, (positionY - START_Y) / (END_Y - START_Y)));

  return (
    <div className="commute" data-phase={phase} role="status" aria-live="polite" aria-label="사무실로 출근하는 중" onClick={skip}>
      <div className="commute-camera" aria-hidden="true">
        <div className="commute-world" data-camera-y={positionY.toFixed(2)} style={{
          width: HALL_W, height: HALL_H,
          transform: `translate3d(${-ME_X}px, ${-positionY}px, 0)`,
          filter: `brightness(${0.24 + 0.76 * progress})`,
          ...(OFFICE_ASSET_VARS as React.CSSProperties),
        }}>
          <div className="commute-floor" style={{ left: WALL, top: 0, width: HALL_COLS * TILE, height: HALL_H, backgroundImage: `url(${FLOOR_SRC.grayGrid})` }} />
          {HALL_WALLS.map((d, i) => <div key={i} className="o-wall" data-kind={d.kind} style={wallStyle(d)} />)}
          {HALL_PROPS.map((p, i) => <Sprite key={i} name={p.name} x={p.x} y={p.y} style={{ zIndex: p.z }} />)}
          <div className="commute-light-pool" style={{ top: LIGHT_Y - 480 }} />
          {row !== null && <Person row={row} dir="down" pose={pose} x={ME_X} y={positionY} className="commute-person" style={{ zIndex: Math.round(positionY) }} />}
        </div>
      </div>
      <div className="commute-darkness" aria-hidden="true" />
      <div className="commute-light" aria-hidden="true" style={{ opacity: 0.2 + progress * 0.8, transform: `translateY(${(1 - progress) * 22}%)` }} />

      <div className="commute-caption">
        <p className="commute-brand">ODYSSEUS</p>
        <h2 className="commute-title">{name ? `${name}님, 첫 출근입니다` : "첫 출근입니다"}</h2>
        <p className="commute-sub">{sub}</p>
      </div>

      {walking && (
        <button
          type="button"
          className="commute-skip"
          onClick={(e) => {
            e.stopPropagation();
            skip();
          }}
        >
          건너뛰기
        </button>
      )}

      <div className="commute-veil" aria-hidden="true" />
    </div>
  );
}

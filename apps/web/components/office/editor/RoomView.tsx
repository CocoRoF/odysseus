"use client";

/** 방 하나를 그린다 — 편집 중인(아직 틀릴 수 있는) 장면도 그대로.
 *
 *  사무실(OfficeStage)은 배치기(layoutRoom)를 거친 **올바른** 장면만 그린다. 편집기는 겹친 소품·막힌 문 같은
 *  틀린 상태도 보여 줘야 고칠 수 있으므로, 배치기를 거치지 않고 장면을 곧장 그린다. 다만 벽·바닥·벽걸이 위치는
 *  배치기와 같은 함수(wallPieces·floorRuns·hang)를 써서 사무실과 한 픽셀도 다르지 않다. 벽만은 방 혼자 분류하므로
 *  옆방·복도와 이어지는 테두리는 사무실에서 달라진다.
 *
 *  좌표는 장면 좌표(북쪽 방, 문이 아래). 월드 px 로 그리고 바깥에서 transform: scale 로 키운다.
 */
import { OFFICE_ASSET_VARS, S, floorSrc, type FloorKey, type SpriteName } from "../atlas";
import { PEOPLE } from "@/lib/people";
import { Person } from "../Person";
import { Sprite } from "../Sprite";
import { FACE, SOLID, TILE, WALL, floorRuns, hang, wallPieces, wallStyleOf } from "../floorplan";
import { wallDraw, wallStyle } from "../wall-draw";
import { doorColsOf, type SceneSpec } from "../scenes";
import type { SceneProblem } from "../scene-check";
import { footOf } from "./catalog";
import { isCut } from "./state";

/** 방 위 여백 — 없다(벽걸이는 앞면 줄과 그 위 고리 줄 안에 든다). 아래에는 문 아래 앞면 칸(복도 쪽)을 한 줄 더 그린다. */
export const ROOM_VIEW_PAD = 0;
/** 방 상자 아래 한 줄 — 문 통로의 복도 쪽 앞면 칸 */
export const ROOM_VIEW_TAIL = TILE;

export interface Ghost {
  c: number;
  r: number;
  w: number;
  h: number;
  ok: boolean;
  /** 위쪽 벽(벽걸이)에 뜨는 유령 */
  onWall?: boolean;
}

export interface Selection {
  kind: "prop" | "decor" | "spot" | "start";
  index?: number;
}

export function RoomView({
  spec,
  grid = true,
  hover,
  ghost,
  selection,
  problems = [],
  focusCells,
  doorTool = false,
}: {
  spec: SceneSpec;
  grid?: boolean;
  hover?: { c: number; r: number } | null;
  ghost?: Ghost | null;
  selection?: Selection | null;
  problems?: SceneProblem[];
  /** 문제 목록에서 고른 문제의 칸 — 더 진하게 */
  focusCells?: { c: number; r: number }[] | null;
  doorTool?: boolean;
}) {
  const { cols, rows } = spec;
  const W = (cols + 2) * TILE, H = (rows + 3) * TILE + ROOM_VIEW_PAD + ROOM_VIEW_TAIL;
  const ox = WALL, oy = WALL + FACE + ROOM_VIEW_PAD;
  const [d0] = doorColsOf(spec);
  const room = { x: 0, y: ROOM_VIEW_PAD, cols, rows, side: "north" as const, doorC: d0 };
  const cellGrid = new Uint8Array(cols * rows);
  for (const k of spec.cuts ?? []) for (let dr = 0; dr < k.h; dr += 1) for (let dc = 0; dc < k.w; dc += 1) {
    const c = k.c + dc, r = k.r + dr;
    if (c >= 0 && c < cols && r >= 0 && r < rows) cellGrid[r * cols + c] = SOLID;
  }
  const walls = wallPieces(room, cellGrid, wallStyleOf(spec));
  const px = (c: number) => ox + c * TILE;
  const py = (r: number) => oy + r * TILE;

  // 바닥 — 칸 줄. 관리자가 칠한 칸은 그 바닥으로.
  const tileAt = new Map<number, FloorKey>();
  for (const t of spec.tiles ?? []) if (t.c >= 0 && t.c < cols && t.r >= 0 && t.r < rows && t.floor !== spec.floor && !isCut(spec, t.c, t.r)) tileAt.set(t.r * cols + t.c, t.floor as FloorKey);
  const floors = floorRuns(cols, rows, cellGrid, { x: ox, y: oy }, spec.floor, tileAt);
  const floorVar = (key: FloorKey) => ({ ["--floor" as string]: `url(${floorSrc(key)})`, ["--accent" as string]: "#62A8C8" });

  // y 정렬층에 들어갈 것들
  type Item = { key: string; z: number; node: React.ReactNode };
  const items: Item[] = [];
  walls.forEach((w, i) => {
    const d = wallDraw(w);
    items.push({ key: `w${i}`, z: d.z, node: <div key={`w${i}`} className="o-wall" data-kind={d.kind} style={wallStyle(d)} /> });
  });
  spec.decor.forEach((d, i) => {
    const f = footOf(d.kind);
    if (!f || !f.wall) return;
    const h = hang(d.kind, px(d.c), ROOM_VIEW_PAD + WALL);
    const selected = selection?.kind === "decor" && selection.index === i;
    items.push({ key: `d${i}`, z: h.z, node: <Sprite key={`d${i}`} name={d.kind as SpriteName} x={h.x} y={h.y} className={selected ? "oe-selected" : ""} style={{ zIndex: h.z }} /> });
  });
  spec.props.forEach((p, i) => {
    const f = footOf(p.kind);
    const name = p.kind as SpriteName;
    if (!f || !S[name]) return;
    const foot = py(p.r) + f.h * TILE;
    const selected = selection?.kind === "prop" && selection.index === i;
    items.push({ key: `p${i}`, z: foot, node: <Sprite key={`p${i}`} name={name} x={px(p.c)} y={foot - S[name].h} className={selected ? "oe-selected" : ""} style={{ zIndex: foot }} /> });
  });
  {
    const foot = py(spec.start.r) + TILE;
    const selected = selection?.kind === "start";
    items.push({ key: "start", z: foot, node: <Sprite key="start" name="standDesk" x={px(spec.start.c)} y={foot - S.standDesk.h} className={selected ? "oe-selected" : ""} style={{ zIndex: foot }} /> });
  }
  spec.spots.forEach((sp, i) => {
    const x = px(sp.c) + TILE / 2, y = py(sp.r) + TILE * 0.9;
    const selected = selection?.kind === "spot" && selection.index === i;
    items.push({ key: `s${i}`, z: y, node: <Person key={`s${i}`} row={PEOPLE[i % PEOPLE.length].row} dir={sp.face} x={x} y={y} className={selected ? "oe-selected" : ""} style={{ zIndex: Math.round(y) }} /> });
  });

  const problemCells = new Map<string, "error" | "warn">();
  for (const p of problems) for (const cell of p.cells ?? []) {
    const k = `${cell.c},${cell.r}`;
    if (p.level === "error" || !problemCells.has(k)) problemCells.set(k, p.level);
  }

  return (
    <div className="oe-room" style={{ width: W, height: H, ...(OFFICE_ASSET_VARS as React.CSSProperties) }}>
      {/* 바닥 — 안쪽 칸 줄 + 문 통로(고리 칸과 그 아래 앞면 칸, 방 바닥이 이어진다) */}
      {floors.map((f, i) => (
        <div key={`t${i}`} className="o-tile" style={{ left: f.x, top: f.y, width: f.w, height: f.h, ...floorVar(f.floor), backgroundPosition: `${-(f.x - ox)}px ${-(f.y - oy)}px` }} />
      ))}
      <div className="o-tile" style={{ left: px(d0), top: py(rows), width: 2 * TILE, height: WALL + FACE, ...floorVar(spec.floor), backgroundPosition: `${-(px(d0) - ox)}px ${-(py(rows) - oy)}px` }} />
      <div className="o-floor-shade" style={{ left: ox, top: oy, width: cols * TILE, height: rows * TILE, ["--accent" as string]: "#62A8C8" }} />
      {/* 세계 — 발끝 y 정렬 */}
      <div className="oe-world">{items.sort((a, b) => a.z - b.z).map((it) => it.node)}</div>
      {/* NPC 번호표·시작 표 — 배율을 타되 글자는 작게 */}
      {spec.spots.map((sp, i) => (
        <span key={`tag${i}`} className="oe-tag" style={{ left: px(sp.c) + TILE / 2, top: py(sp.r) - 22 }}>
          NPC {i + 1}
        </span>
      ))}
      <span className="oe-tag oe-tag-start" style={{ left: px(spec.start.c) + TILE, top: py(spec.start.r) - 12 }}>
        시작
      </span>
      {/* 덮개 — 격자·문제·호버·유령·선택 */}
      {grid && <div className="oe-grid" style={{ left: ox, top: oy, width: cols * TILE, height: rows * TILE }} />}
      {grid && <div className="oe-grid oe-grid-wall" style={{ left: ox, top: ROOM_VIEW_PAD + WALL, width: cols * TILE, height: FACE }} />}
      {[...problemCells].map(([k, level]) => {
        const [c, r] = k.split(",").map(Number);
        const focused = focusCells?.some((f) => f.c === c && f.r === r);
        return <div key={`pb${k}`} className="oe-problem" data-level={level} data-focus={focused ? "true" : undefined} style={{ left: px(c), top: py(r), width: TILE, height: TILE }} />;
      })}
      {doorTool && (
        <div className="oe-doorhint" style={{ left: px(d0), top: py(rows), width: 2 * TILE, height: TILE }} />
      )}
      {hover && (
        // 둘레 벽 칸(옆·아래 고리, 위쪽 벽 앞면)도 같은 식으로 잡힌다 — 허물 수 있는 벽이라는 표시로 점선
        <div className="oe-hover" data-edge={hover.c < 0 || hover.c >= cols || hover.r < 0 || hover.r >= rows ? "true" : undefined} style={{ left: px(hover.c), top: hover.r === -1 ? ROOM_VIEW_PAD + WALL : py(hover.r), width: TILE, height: hover.r === -1 ? FACE : TILE }} />
      )}
      {ghost && (
        <div className="oe-ghost" data-ok={ghost.ok ? "true" : "false"} style={{ left: px(ghost.c), top: ghost.onWall ? ROOM_VIEW_PAD + WALL : py(ghost.r), width: ghost.w * TILE, height: ghost.onWall ? FACE : ghost.h * TILE }} />
      )}
      {selection && (() => {
        let rect: { c: number; r: number; w: number; h: number; wall?: boolean } | null = null;
        if (selection.kind === "prop" && selection.index !== undefined) {
          const p = spec.props[selection.index];
          const f = p && footOf(p.kind);
          if (p && f) rect = { c: p.c, r: p.r, w: f.w, h: f.h };
        } else if (selection.kind === "decor" && selection.index !== undefined) {
          const d = spec.decor[selection.index];
          const f = d && footOf(d.kind);
          if (d && f) rect = { c: d.c, r: -1, w: f.w, h: 1, wall: true };
        } else if (selection.kind === "spot" && selection.index !== undefined) {
          const sp = spec.spots[selection.index];
          if (sp) rect = { c: sp.c, r: sp.r, w: 1, h: 1 };
        } else if (selection.kind === "start") rect = { c: spec.start.c, r: spec.start.r, w: 2, h: 1 };
        if (!rect) return null;
        return <div className="oe-selection" style={{ left: px(rect.c), top: rect.wall ? ROOM_VIEW_PAD + WALL : py(rect.r), width: rect.w * TILE, height: rect.wall ? FACE : rect.h * TILE }} />;
      })()}
    </div>
  );
}

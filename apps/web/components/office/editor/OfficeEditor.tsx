"use client";

/** 사무실 커스텀 편집기 — 방 하나(장면)를 타일과 에셋으로 설계한다.
 *
 *  세 가지 마우스가 있다.
 *   - 둘러보기: 끌어서 옮기고, 휠로 당기고, 칸 위에 올리면 무엇인지 말해 준다. 아무것도 바꾸지 않는다.
 *   - 타일 편집: 바닥을 칠하고 벽을 세운다. 끌면 이어서 칠하고, Shift 로 끌면 사각형을 채운다.
 *   - 에셋 편집: 소품·벽걸이·NPC 자리·시작 지점·문을 놓고 옮기고 지운다.
 *
 *  잘못된 상태를 막지 않는다 — 소품이 겹쳐도 놓인다. 대신 검증기가 곧바로 무엇이 틀렸는지 말하고, 오류가 있으면
 *  저장 버튼이 잠긴다. 막으면 "왜 안 놓이지"가 되고, 보여 주면 "아, 겹쳤구나"가 된다.
 *
 *  실제 사무실로 보기: 같은 장면을 진짜 사무실 화면(OfficeStage)에 올려 걸어 볼 수 있다.
 *
 *  둘레 벽: 방의 테두리 벽도 칸이다. 타일 편집에서 [벽 허물기]나 바닥 붓으로 누르면 방이 그쪽으로 한 칸 넓어지고 그 칸만
 *  뚫린다(state.openEdge). 예전에는 둘레 벽을 눌러도 아무 일이 없어 "벽은 편집이 안 된다"로 보였다(2026-09-13).
 *
 *  템플릿: 코드에 있는 기본 장면도 고칠 수 있다. 태그와 [기본값으로 되돌리기]를 달 뿐, 편집은 프리셋과 같다.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { Dir } from "@/lib/people";
import { PEOPLE } from "@/lib/people";
import type { MyAssignment } from "@/lib/types";
import { WALL_DEFAULT, type FloorKey, type WallStyleKey } from "../atlas";
import { OfficeStage } from "../OfficeStage";
import { FACE, TILE, WALL } from "../floorplan";
import { SCENE_LIMITS, doorColsOf, type SceneSpec } from "../scenes";
import { validateScene, type SceneProblem } from "../scene-check";
import { READ_ONLY_REASON, useReadOnly, writeProps } from "@/components/readonly";
import { DECOR_ITEMS, FLOOR_ITEMS, FLOOR_LABELS, KNOWN_KINDS, PROP_GROUPS, WALL_ITEMS, footOf, labelOf } from "./catalog";
import { ROOM_VIEW_PAD, ROOM_VIEW_TAIL, RoomView, type Ghost, type Selection } from "./RoomView";
import {
  addSpot, compact, faceSpot, fillRect, hitDecor, hitTest, initialState, isCut, moveDecor, moveProp, moveSpot, nextDir, paintTile,
  placeDecor, placeProp, reduce, removeDecor, removeProp, removeSpot, resize, sameDesign, setBaseFloor, setDoor, setLabel, setStart, setWall, setWallStyle, tileAt,
  openEdge, type Cell, type Edge,
} from "./state";

export type EditorMode = "browse" | "tiles" | "assets";
type TileTool = { kind: "floor"; floor: FloorKey } | { kind: "erase" } | { kind: "wall" } | { kind: "unwall" };
type AssetTool = { kind: "select" } | { kind: "prop"; prop: string } | { kind: "decor"; prop: string } | { kind: "npc" } | { kind: "start" } | { kind: "door" };

const ZOOMS = [0.5, 0.75, 1, 1.5, 2, 3];

/** 방 전체가 편집기 칸에 들어오는 가장 큰 배율. 화면 폭을 모르면(서버 렌더) 보수적으로 1 을 쓴다. */
function fitZoom(cols: number, rows: number): number {
  if (typeof window === "undefined") return 1;
  // 좌우 패널(템플릿·팔레트·규칙)과 여백을 뺀 대략의 캔버스 폭·높이
  const w = Math.max(320, window.innerWidth - 980);
  const h = Math.max(320, window.innerHeight - 320);
  const fit = Math.min(w / ((cols + 2) * TILE), h / ((rows + 3) * TILE));
  const usable = ZOOMS.filter((z) => z <= fit);
  return usable.length ? usable[usable.length - 1] : ZOOMS[0];
}

export function OfficeEditor({
  spec: initial,
  readOnly = false,
  onSave,
  onDirty,
  saving = false,
  template,
}: {
  spec: SceneSpec;
  /** 둘러보기만 된다 */
  readOnly?: boolean;
  /** 템플릿(코드에 있는 기본 장면)을 고치는 중 — 태그와 [기본값으로 되돌리기]를 단다. modified = DB 에 고친 모양이 있다. */
  template?: { modified: boolean; onReset: () => void };
  onSave?: (spec: SceneSpec) => void;
  onDirty?: (dirty: boolean) => void;
  saving?: boolean;
}) {
  /** 둘러보기 계정 — 장면은 마음껏 만져 보되 저장·되돌리기만 잠근다 (components/readonly.tsx) */
  const demoLocked = useReadOnly();
  const [state, dispatch] = useReducer(reduce, initial, initialState);
  const spec = state.spec;
  const [mode, setModeRaw] = useState<EditorMode>(readOnly ? "browse" : "assets");
  const [tileTool, setTileTool] = useState<TileTool>({ kind: "floor", floor: "oak" });
  const [assetTool, setAssetTool] = useState<AssetTool>({ kind: "select" });
  // 처음 배율은 방이 한눈에 들어오게 정한다 — 고정 150% 면 큰 방(14×11)이 오른쪽으로 잘린 채 시작했다.
  const [zoom, setZoom] = useState(() => fitZoom(initial.cols, initial.rows));
  const [grid, setGrid] = useState(true);
  const [hover, setHover] = useState<Cell | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [focus, setFocus] = useState<SceneProblem | null>(null);
  const [preview, setPreview] = useState(false);
  /** 상태 줄에 잠깐 띄우는 말 — 더 넓힐 수 없을 때 */
  const [notice, setNotice] = useState("");
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(""), 2500);
    return () => clearTimeout(t);
  }, [notice]);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef<
    | { kind: "paint"; stroke: string; rect: Cell | null; last: string }
    | { kind: "move"; sel: Selection; from: Cell; moved: boolean; stroke: string }
    | { kind: "pan"; x: number; y: number; sx: number; sy: number }
    | null
  >(null);
  const strokeSeq = useRef(0);

  // 밖에서 다른 장면을 주면 새로 시작한다. 저장 뒤 서버가 돌려준 **같은 설계**는 새로 시작하지 않는다 —
  // 그러면 모드·선택·되돌리기 이력이 저장할 때마다 튕긴다.
  const specRef = useRef(state.spec);
  specRef.current = state.spec;
  const readOnlyRef = useRef(readOnly);
  useEffect(() => {
    const sameRole = readOnlyRef.current === readOnly;
    readOnlyRef.current = readOnly;
    if (sameRole && sameDesign(initial, specRef.current)) {
      dispatch({ type: "saved" });
      return;
    }
    dispatch({ type: "load", spec: initial });
    setSelection(null);
    setFocus(null);
    setModeRaw(readOnly ? "browse" : "assets");
  }, [initial, readOnly]);
  useEffect(() => onDirty?.(state.dirty), [state.dirty, onDirty]);

  const setMode = useCallback((m: EditorMode) => {
    if (readOnly && m !== "browse") return;
    setModeRaw(m);
    setSelection(null);
  }, [readOnly]);

  const problems = useMemo(() => validateScene(spec), [spec]);
  const errors = problems.filter((p) => p.level === "error");
  const unknownKinds = useMemo(
    () => [...new Set([...spec.props.map((p) => p.kind), ...spec.decor.map((d) => d.kind)].filter((k) => !KNOWN_KINDS.has(k)))],
    [spec],
  );

  const commit = useCallback((next: SceneSpec, coalesce?: string) => dispatch({ type: "commit", spec: next, coalesce }), []);

  // ── 좌표 ──
  /** 누른 칸 — 방 안쪽이면 edge 가 null, 둘레 벽이면 그 쪽. wall 은 위쪽 벽(벽걸이를 거는 앞면 줄)이다. */
  const cellAt = useCallback((e: { clientX: number; clientY: number }): { c: number; r: number; wall: boolean; edge: Edge | null } | null => {
    const el = stageRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const wx = (e.clientX - rect.left) / zoom;
    const wy = (e.clientY - rect.top) / zoom - ROOM_VIEW_PAD;
    const c = Math.floor((wx - WALL) / TILE);
    const r = Math.floor((wy - WALL - FACE) / TILE);
    const inCols = c >= 0 && c < spec.cols, inRows = r >= 0 && r < spec.rows;
    if (inCols && inRows) return { c, r, wall: false, edge: null };
    // 둘레 벽 — 위쪽은 윗면 줄(r = -2)도 앞면 줄(r = -1)과 같은 벽이다
    if (inCols && (r === -1 || r === -2)) return { c, r: -1, wall: true, edge: "top" };
    if (inRows && c === -1) return { c, r, wall: false, edge: "left" };
    if (inRows && c === spec.cols) return { c, r, wall: false, edge: "right" };
    if (inCols && r === spec.rows) return { c, r, wall: false, edge: "bottom" };
    return null;
  }, [zoom, spec.cols, spec.rows]);

  // ── 타일 ──
  const applyTile = useCallback((s: SceneSpec, c: number, r: number, erase = false): SceneSpec => {
    if (erase) return isCut(s, c, r) ? setWall(s, c, r, false) : paintTile(s, c, r, null);
    switch (tileTool.kind) {
      case "floor": return paintTile(isCut(s, c, r) ? setWall(s, c, r, false) : s, c, r, tileTool.floor);
      case "erase": return paintTile(s, c, r, null);
      case "wall": return setWall(s, c, r, true);
      case "unwall": return setWall(s, c, r, false);
    }
  }, [tileTool]);

  // ── 유령(놓을 자리 미리보기) ──
  const ghost: Ghost | null = useMemo(() => {
    if (!hover || mode !== "assets") return null;
    if (assetTool.kind === "prop") {
      const f = footOf(assetTool.prop);
      if (!f || hover.r < 0) return null;
      const ok = hover.c + f.w <= spec.cols && hover.r + f.h <= spec.rows;
      return { c: hover.c, r: hover.r, w: f.w, h: f.h, ok };
    }
    if (assetTool.kind === "decor") {
      const f = footOf(assetTool.prop);
      if (!f) return null;
      return { c: hover.c, r: -1, w: f.w, h: 1, ok: hover.c + f.w <= spec.cols, onWall: true };
    }
    if (assetTool.kind === "npc" && hover.r >= 0) return { c: hover.c, r: hover.r, w: 1, h: 1, ok: !isCut(spec, hover.c, hover.r) };
    if (assetTool.kind === "start" && hover.r >= 0) return { c: hover.c, r: hover.r, w: 2, h: 1, ok: hover.c + 2 <= spec.cols && hover.r < spec.rows - 1 };
    if (assetTool.kind === "door" && hover.r >= 0) {
      const c = Math.max(0, Math.min(spec.cols - 2, hover.c));
      return { c, r: spec.rows - 1, w: 2, h: 1, ok: !isCut(spec, c, spec.rows - 1) && !isCut(spec, c + 1, spec.rows - 1) };
    }
    return null;
  }, [hover, mode, assetTool, spec]);

  // ── 마우스 ──
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button === 1 || mode === "browse" || e.altKey) {
      const sc = scrollRef.current;
      if (!sc) return;
      drag.current = { kind: "pan", x: e.clientX, y: e.clientY, sx: sc.scrollLeft, sy: sc.scrollTop };
      stageRef.current?.setPointerCapture?.(e.pointerId);
      e.preventDefault();
      return;
    }
    if (readOnly) return;
    const cell = cellAt(e);
    if (!cell) { setSelection(null); return; }
    if (mode === "tiles") {
      if (cell.edge) {
        // 둘레 벽 — 허물기나 바닥 붓으로 누르면 방이 그쪽으로 한 칸 넓어진다. 한 번 누를 때만 넓힌다: 끄는 동안 넓히면
        // 위·왼쪽으로 밀린 좌표 때문에 붓이 엉뚱한 칸으로 튄다.
        if (e.button === 2 || (tileTool.kind !== "unwall" && tileTool.kind !== "floor")) return;
        const grown = openEdge(spec, cell.edge, cell.edge === "left" || cell.edge === "right" ? cell.r : cell.c);
        if (!grown) {
          setNotice(`방은 ${SCENE_LIMITS.maxCols}×${SCENE_LIMITS.maxRows} 칸보다 넓힐 수 없습니다`);
          return;
        }
        commit(tileTool.kind === "floor" ? paintTile(grown.spec, grown.cell.c, grown.cell.r, tileTool.floor) : grown.spec);
        setHover(null);
        e.preventDefault();
        return;
      }
      const stroke = `stroke-${(strokeSeq.current += 1)}`;
      const erase = e.button === 2;
      if (e.shiftKey && !erase) {
        drag.current = { kind: "paint", stroke, rect: { c: cell.c, r: cell.r }, last: "" };
      } else {
        drag.current = { kind: "paint", stroke, rect: null, last: `${cell.c},${cell.r}` };
        commit(applyTile(spec, cell.c, cell.r, erase), stroke);
      }
      stageRef.current?.setPointerCapture?.(e.pointerId);
      e.preventDefault();
      return;
    }
    // 에셋 — 옆·아래 둘레 벽에는 놓을 것이 없다(위쪽 벽은 벽걸이 자리)
    if (cell.edge && !cell.wall) { setSelection(null); return; }
    if (e.button === 2) {
      const hit = cell.wall ? hitDecor(spec, cell.c) : hitTest(spec, cell.c, cell.r);
      if (hit) remove(hit);
      e.preventDefault();
      return;
    }
    if (assetTool.kind === "select") {
      const hit = cell.wall ? hitDecor(spec, cell.c) : hitTest(spec, cell.c, cell.r);
      setSelection(hit);
      if (hit) {
        drag.current = { kind: "move", sel: hit, from: { c: cell.c, r: cell.r }, moved: false, stroke: `move-${(strokeSeq.current += 1)}` };
        stageRef.current?.setPointerCapture?.(e.pointerId);
      }
      return;
    }
    if (assetTool.kind === "prop" && !cell.wall) {
      const next = placeProp(spec, assetTool.prop, cell.c, cell.r);
      if (next !== spec) { commit(next); setSelection({ kind: "prop", index: next.props.length - 1 }); }
      return;
    }
    if (assetTool.kind === "decor") {
      const next = placeDecor(spec, assetTool.prop, cell.c);
      if (next !== spec) { commit(next); setSelection({ kind: "decor", index: next.decor.length - 1 }); }
      return;
    }
    if (assetTool.kind === "npc" && !cell.wall) {
      const next = addSpot(spec, cell.c, cell.r, "down");
      if (next !== spec) { commit(next); setSelection({ kind: "spot", index: next.spots.length - 1 }); }
      return;
    }
    if (assetTool.kind === "start" && !cell.wall) {
      const next = setStart(spec, cell.c, cell.r);
      if (next !== spec) { commit(next); setSelection({ kind: "start" }); }
      return;
    }
    if (assetTool.kind === "door" && !cell.wall) {
      const next = setDoor(spec, cell.c);
      if (next !== spec) commit(next);
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (d?.kind === "pan") {
      const sc = scrollRef.current;
      if (sc) { sc.scrollLeft = d.sx - (e.clientX - d.x); sc.scrollTop = d.sy - (e.clientY - d.y); }
      return;
    }
    const cell = cellAt(e);
    setHover(cell && (mode !== "assets" || !cell.edge || cell.wall) ? { c: cell.c, r: cell.r } : null);
    if (!d || !cell) return;
    if (d.kind === "paint") {
      if (cell.edge) return;
      if (d.rect) {
        // 사각형 채우기는 놓을 때 한 번에 — 끄는 동안은 유령만
        setRectGhost({ a: d.rect, b: { c: cell.c, r: cell.r } });
        return;
      }
      const key = `${cell.c},${cell.r}`;
      if (key === d.last) return;
      d.last = key;
      commit(applyTile(spec, cell.c, cell.r, e.buttons === 2), d.stroke);
      return;
    }
    if (d.kind === "move") {
      const dc = cell.c - d.from.c, dr = cell.r - d.from.r;
      if (!dc && !dr) return;
      d.from = { c: cell.c, r: cell.r };
      d.moved = true;
      const sel = d.sel;
      let next = spec;
      if (sel.kind === "prop" && sel.index !== undefined) { const p = spec.props[sel.index]; if (p) next = moveProp(spec, sel.index, p.c + dc, p.r + dr); }
      else if (sel.kind === "decor" && sel.index !== undefined) { const x = spec.decor[sel.index]; if (x) next = moveDecor(spec, sel.index, x.c + dc); }
      else if (sel.kind === "spot" && sel.index !== undefined) { const x = spec.spots[sel.index]; if (x) next = moveSpot(spec, sel.index, x.c + dc, x.r + dr); }
      else if (sel.kind === "start") next = setStart(spec, spec.start.c + dc, spec.start.r + dr);
      if (next !== spec) commit(next, d.stroke);
    }
  };

  const [rectGhost, setRectGhost] = useState<{ a: Cell; b: Cell } | null>(null);
  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (d?.kind === "paint" && d.rect) {
      const cell = cellAt(e);
      const b = cell && !cell.edge ? { c: cell.c, r: cell.r } : d.rect;
      commit(fillRect(spec, d.rect, b, (s, c, r) => applyTile(s, c, r)), d.stroke);
      setRectGhost(null);
    }
  };

  const remove = useCallback((sel: Selection | null) => {
    if (!sel) return;
    let next = spec;
    if (sel.kind === "prop" && sel.index !== undefined) next = removeProp(spec, sel.index);
    else if (sel.kind === "decor" && sel.index !== undefined) next = removeDecor(spec, sel.index);
    else if (sel.kind === "spot" && sel.index !== undefined) next = removeSpot(spec, sel.index);
    if (next !== spec) { commit(next); setSelection(null); }
  }, [spec, commit]);

  // ── 키보드 ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (preview) return; // 미리보기에서는 사무실이 키를 가진다(방향키로 걷는다)
      // 되돌리기는 입력칸 안에서도 편집기의 것이다. 브라우저의 글자 되돌리기는 문서 전체의 입력 이력을 타고
      // 다른 칸(칸 수 입력)으로 건너가 엉뚱한 값을 되살렸다 — "12" 를 쳤던 칸이 "117" 이 되어 방이 14칸으로 튀었다.
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); dispatch({ type: e.shiftKey ? "redo" : "undo" }); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") { e.preventDefault(); dispatch({ type: "redo" }); return; }
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if (e.key === "1") setMode("browse");
      else if (e.key === "2") setMode("tiles");
      else if (e.key === "3") setMode("assets");
      else if (e.key.toLowerCase() === "g") setGrid((g) => !g);
      else if (e.key === "Escape") { setSelection(null); setAssetTool({ kind: "select" }); }
      else if (readOnly) return;
      else if ((e.key === "Delete" || e.key === "Backspace") && selection) { e.preventDefault(); remove(selection); }
      else if (e.key.toLowerCase() === "r" && selection?.kind === "spot" && selection.index !== undefined) {
        const sp = spec.spots[selection.index];
        if (sp) commit(faceSpot(spec, selection.index, nextDir(sp.face)));
      } else if (selection && ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) {
        e.preventDefault();
        const dc = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0;
        const dr = e.key === "ArrowUp" ? -1 : e.key === "ArrowDown" ? 1 : 0;
        let next = spec;
        if (selection.kind === "prop" && selection.index !== undefined) { const p = spec.props[selection.index]; if (p) next = moveProp(spec, selection.index, p.c + dc, p.r + dr); }
        else if (selection.kind === "decor" && selection.index !== undefined) { const x = spec.decor[selection.index]; if (x) next = moveDecor(spec, selection.index, x.c + dc); }
        else if (selection.kind === "spot" && selection.index !== undefined) { const x = spec.spots[selection.index]; if (x) next = moveSpot(spec, selection.index, x.c + dc, x.r + dr); }
        else if (selection.kind === "start") next = setStart(spec, spec.start.c + dc, spec.start.r + dr);
        if (next !== spec) commit(next);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [spec, selection, readOnly, commit, remove, setMode, preview]);

  // 휠 + Ctrl = 당기기. React 의 onWheel 은 passive 라 브라우저 확대를 못 막는다 — 직접 단다.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      setZoom((z) => {
        const i = ZOOMS.findIndex((v) => v >= z - 1e-6);
        const next = e.deltaY < 0 ? Math.min(ZOOMS.length - 1, i + 1) : Math.max(0, i - 1);
        return ZOOMS[next];
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [preview]);

  // ── 선택된 것의 설명 ──
  const selected = useMemo(() => {
    if (!selection) return null;
    if (selection.kind === "prop" && selection.index !== undefined) { const p = spec.props[selection.index]; return p ? { title: labelOf(p.kind), where: `(${p.c}, ${p.r})`, spot: null } : null; }
    if (selection.kind === "decor" && selection.index !== undefined) { const d = spec.decor[selection.index]; return d ? { title: `${labelOf(d.kind)} (벽걸이)`, where: `${d.c} 칸`, spot: null } : null; }
    if (selection.kind === "spot" && selection.index !== undefined) { const s = spec.spots[selection.index]; return s ? { title: `NPC ${selection.index + 1} 자리`, where: `(${s.c}, ${s.r})`, spot: s } : null; }
    if (selection.kind === "start") return { title: "응시자 시작 지점 (스탠딩 데스크)", where: `(${spec.start.c}, ${spec.start.r})`, spot: null };
    return null;
  }, [selection, spec]);

  const hoverInfo = useMemo(() => {
    if (!hover) return null;
    const grow = (dir: string, full: boolean) =>
      full ? `더 넓힐 수 없습니다 (최대 ${SCENE_LIMITS.maxCols}×${SCENE_LIMITS.maxRows} 칸)` : `벽 허물기·바닥 붓으로 누르면 방이 ${dir} 한 칸 넓어집니다`;
    const wide = spec.cols >= SCENE_LIMITS.maxCols, tall = spec.rows >= SCENE_LIMITS.maxRows;
    if (hover.c === -1) return `왼쪽 벽 — ${grow("왼쪽으로", wide)}`;
    if (hover.c === spec.cols) return `오른쪽 벽 — ${grow("오른쪽으로", wide)}`;
    if (hover.r === spec.rows) return `아래쪽 벽 — ${grow("아래로", tall)}`;
    if (hover.r === -1 && mode === "tiles") return `위쪽 벽 — ${grow("위로", tall)}`;
    if (hover.r === -1) {
      const hit = hitDecor(spec, hover.c);
      return hit?.kind === "decor" ? `위쪽 벽 ${hover.c} — ${labelOf(spec.decor[hit.index].kind)}` : `위쪽 벽 ${hover.c} — 벽걸이 자리`;
    }
    const parts = [`(${hover.c}, ${hover.r})`];
    if (isCut(spec, hover.c, hover.r)) parts.push("벽");
    else parts.push(FLOOR_LABELS[tileAt(spec, hover.c, hover.r) ?? spec.floor]);
    const hit = hitTest(spec, hover.c, hover.r);
    if (hit?.kind === "prop" && hit.index !== undefined) parts.push(labelOf(spec.props[hit.index].kind));
    if (hit?.kind === "spot" && hit.index !== undefined) parts.push(`NPC ${hit.index + 1} (${DIR_LABEL[spec.spots[hit.index].face]})`);
    if (hit?.kind === "start") parts.push("응시자 시작 지점");
    const [d0, d1] = doorColsOf(spec);
    if (hover.r === spec.rows - 1 && (hover.c === d0 || hover.c === d1)) parts.push("문");
    return parts.join(" · ");
  }, [hover, spec, mode]);

  // ── 실제 사무실 미리보기 ──
  const previewAssignments: MyAssignment[] = useMemo(() => {
    const compacted = compact(spec);
    return [{
      assessment_id: "preview",
      title: spec.label || "미리보기",
      description: "",
      category: "",
      duration_min: 60,
      label: "",
      difficulty: "medium",
      scenario_count: 1,
      starts_at: null,
      ends_at: null,
      attempt_id: null,
      attempt_status: null,
      assigned: true,
      colleagues: spec.spots.map((_, i) => ({ key: `npc${i}`, name: `NPC ${i + 1}`, role: "", avatar_preset: PEOPLE[i % PEOPLE.length].id })),
      office_preset: compacted.id,
      office_scene: compacted as unknown as Record<string, unknown>,
    }];
  }, [spec]);
  const [announce, setAnnounce] = useState("");

  const W = (spec.cols + 2) * TILE, H = (spec.rows + 3) * TILE + ROOM_VIEW_PAD + ROOM_VIEW_TAIL;

  return (
    <div className="oe" data-mode={mode}>
      {/* 도구 막대 */}
      <div className="oe-toolbar">
        {/* 두 줄로 나눈다 — 한 줄에 몰아 두면 좁은 화면에서 모드 탭이 이름·크기 칸 사이로 끼어든다 */}
        <div className="oe-row">
          <div className="oe-modes" role="tablist" aria-label="편집 방식">
          <button type="button" role="tab" aria-selected={mode === "browse"} data-on={mode === "browse" ? "true" : undefined} onClick={() => setMode("browse")} title="1">둘러보기</button>
          <button type="button" role="tab" aria-selected={mode === "tiles"} data-on={mode === "tiles" ? "true" : undefined} onClick={() => setMode("tiles")} disabled={readOnly} title="2">타일 편집</button>
          <button type="button" role="tab" aria-selected={mode === "assets"} data-on={mode === "assets" ? "true" : undefined} onClick={() => setMode("assets")} disabled={readOnly} title="3">에셋 편집</button>
          </div>
          <button type="button" className="oe-btn" onClick={() => dispatch({ type: "undo" })} disabled={!state.past.length} title="Ctrl+Z">되돌리기</button>
          <button type="button" className="oe-btn" onClick={() => dispatch({ type: "redo" })} disabled={!state.future.length} title="Ctrl+Y">다시</button>
          <span className="oe-sep" />
          <button type="button" className="oe-btn" data-on={grid ? "true" : undefined} onClick={() => setGrid((g) => !g)} title="G">격자</button>
          <select className="oe-zoom" value={zoom} onChange={(e) => setZoom(Number(e.target.value))} aria-label="배율">
            {ZOOMS.map((z) => <option key={z} value={z}>{Math.round(z * 100)}%</option>)}
          </select>
          <button type="button" className="oe-btn" data-on={preview ? "true" : undefined} onClick={() => setPreview((p) => !p)}>{preview ? "편집기로" : "실제 사무실로 보기"}</button>
        </div>
        <div className="oe-row">
          {template && (
            <span className="oe-template-tags">
              <span className="oe-chip" data-kind="template">템플릿</span>
              {template.modified && <span className="oe-chip" data-kind="modified">기본값에서 수정됨</span>}
            </span>
          )}
          <label className="oe-field">
            이름
            <input value={spec.label} maxLength={60} disabled={readOnly} onChange={(e) => commit(setLabel(spec, e.target.value), "label")} />
          </label>
          <Stepper label="가로" value={spec.cols} min={SCENE_LIMITS.minCols} max={SCENE_LIMITS.maxCols} disabled={readOnly} onCommit={(v) => commit(resize(spec, v, spec.rows))} />
          <Stepper label="세로" value={spec.rows} min={SCENE_LIMITS.minRows} max={SCENE_LIMITS.maxRows} disabled={readOnly} onCommit={(v) => commit(resize(spec, spec.cols, v))} />
          <label className="oe-field">
            기본 바닥
            <select value={spec.floor} disabled={readOnly} onChange={(e) => commit(setBaseFloor(spec, e.target.value as FloorKey))}>
              {FLOOR_ITEMS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
            </select>
          </label>
          <label className="oe-field">
            벽
            <select value={spec.wall ?? WALL_DEFAULT} disabled={readOnly} onChange={(e) => commit(setWallStyle(spec, e.target.value as WallStyleKey))}>
              {WALL_ITEMS.map((w) => <option key={w.key} value={w.key}>{w.label}</option>)}
            </select>
          </label>
          <span className="oe-grow" />
          {template && (
            <button
              type="button"
              className="oe-btn"
              data-reset
              onClick={template.onReset}
              {...writeProps(demoLocked, saving || (!template.modified && !state.dirty))}
              title={demoLocked ? READ_ONLY_REASON : "코드에 있는 처음 모양으로 돌아갑니다"}
            >
              기본값으로 되돌리기
            </button>
          )}
          {!readOnly && onSave && (
            <button
              type="button"
              className="oe-save"
              {...writeProps(demoLocked, errors.length > 0 || saving || !state.dirty)}
              onClick={() => onSave(compact(spec))}
            >
              {demoLocked ? "저장 잠김" : saving ? "저장 중…" : errors.length ? `오류 ${errors.length}` : state.dirty ? "저장" : "저장됨"}
            </button>
          )}
        </div>
      </div>

      {preview ? (
        <div className="oe-preview">
          <OfficeStage assignments={previewAssignments} seed="preview" busyId={null} onStart={() => setAnnounce("미리보기에서는 시험을 시작하지 않습니다.")} onAnnounce={setAnnounce} />
          <p className="oe-preview-note" data-level={errors.length ? "error" : undefined}>
            {errors.length
              ? `오류가 ${errors.length}개 있어 이 장면을 깔 수 없습니다 — 기본 장면이 대신 보입니다. 편집기로 돌아가 검사 목록을 고치세요.`
              : announce || "방향키로 걸어 보세요. SPACE로 NPC 에게 말을 걸 수 있습니다."}
          </p>
        </div>
      ) : (
        <div className="oe-body">
          {/* 팔레트 */}
          <aside className="oe-palette">
            {mode === "browse" && (
              <div className="oe-help">
                <b>둘러보기</b>
                <p>끌어서 옮기고, Ctrl+휠로 당깁니다. 칸 위에 올리면 아래에 무엇인지 나옵니다.</p>
                {readOnly && <p>이 장면은 바꿀 수 없습니다. 왼쪽에서 <b>복제</b>하면 내 프리셋이 됩니다.</p>}
                {template && <p><b>템플릿</b>입니다. 고쳐 저장하면 이 템플릿을 쓰는 모든 방이 바뀌고, 배포해도 유지됩니다. <b>기본값으로 되돌리기</b>를 누르면 처음 모양으로 돌아갑니다.</p>}
              </div>
            )}
            {mode === "tiles" && (
              <>
                <h4>바닥</h4>
                <div className="oe-swatches">
                  {FLOOR_ITEMS.map((f) => (
                    <button key={f.key} type="button" className="oe-swatch" data-on={tileTool.kind === "floor" && tileTool.floor === f.key ? "true" : undefined} onClick={() => setTileTool({ kind: "floor", floor: f.key })} title={f.label}>
                      <span className="oe-swatch-img" style={{ backgroundImage: `url(${floorSrc(f.key)})` }} />
                      <span>{f.label}</span>
                    </button>
                  ))}
                </div>
                <h4>벽</h4>
                <div className="oe-swatches">
                  <button type="button" className="oe-swatch" data-on={tileTool.kind === "wall" ? "true" : undefined} onClick={() => setTileTool({ kind: "wall" })}><span className="oe-swatch-img oe-swatch-wall" /><span>벽 세우기</span></button>
                  <button type="button" className="oe-swatch" data-on={tileTool.kind === "unwall" ? "true" : undefined} onClick={() => setTileTool({ kind: "unwall" })}><span className="oe-swatch-img oe-swatch-unwall" /><span>벽 허물기</span></button>
                  <button type="button" className="oe-swatch" data-on={tileTool.kind === "erase" ? "true" : undefined} onClick={() => setTileTool({ kind: "erase" })}><span className="oe-swatch-img oe-swatch-erase" /><span>기본 바닥으로</span></button>
                </div>
                <p className="oe-hint">끌면 이어서 칠합니다. Shift+끌기는 사각형, 오른쪽 버튼은 지우기.</p>
                <p className="oe-hint">방 둘레의 벽을 <b>벽 허물기</b>나 바닥 붓으로 누르면 방이 그쪽으로 한 칸 넓어집니다. 방 안에 벽을 세우면 방 모양이 바뀝니다. 벽의 색은 위 막대의 <b>벽</b>에서 고릅니다.</p>
              </>
            )}
            {mode === "assets" && (
              <>
                <div className="oe-swatches oe-swatches-wide">
                  <button type="button" className="oe-swatch" data-on={assetTool.kind === "select" ? "true" : undefined} onClick={() => setAssetTool({ kind: "select" })}><span>선택·옮기기</span></button>
                  <button type="button" className="oe-swatch" data-on={assetTool.kind === "npc" ? "true" : undefined} onClick={() => setAssetTool({ kind: "npc" })}><span>NPC 자리</span></button>
                  <button type="button" className="oe-swatch" data-on={assetTool.kind === "start" ? "true" : undefined} onClick={() => setAssetTool({ kind: "start" })}><span>응시자 시작 지점</span></button>
                  <button type="button" className="oe-swatch" data-on={assetTool.kind === "door" ? "true" : undefined} onClick={() => setAssetTool({ kind: "door" })}><span>문 위치</span></button>
                </div>
                {PROP_GROUPS.map((g) => (
                  <div key={g.title}>
                    <h4>{g.title}</h4>
                    <div className="oe-swatches">
                      {g.items.map((it) => (
                        <button key={it.kind} type="button" className="oe-swatch" data-on={assetTool.kind === "prop" && assetTool.prop === it.kind ? "true" : undefined} onClick={() => setAssetTool({ kind: "prop", prop: it.kind })} title={it.label}>
                          <span className="oe-swatch-img"><SpriteThumb kind={it.kind} /></span>
                          <span>{it.label}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
                <h4>벽걸이 (위쪽 벽)</h4>
                <div className="oe-swatches">
                  {DECOR_ITEMS.map((it) => (
                    <button key={it.kind} type="button" className="oe-swatch" data-on={assetTool.kind === "decor" && assetTool.prop === it.kind ? "true" : undefined} onClick={() => setAssetTool({ kind: "decor", prop: it.kind })} title={it.label}>
                      <span className="oe-swatch-img"><SpriteThumb kind={it.kind} /></span>
                      <span>{it.label}</span>
                    </button>
                  ))}
                </div>
                <p className="oe-hint">누르면 놓입니다. 선택 후 끌거나 방향키로 옮기고, Delete 로 지웁니다. NPC 는 R 로 방향을 돌립니다. 오른쪽 버튼은 지우기.</p>
              </>
            )}
          </aside>

          {/* 캔버스 */}
          <div className="oe-canvas" ref={scrollRef}>
            <div
              ref={stageRef}
              className="oe-stage"
              style={{ width: W * zoom, height: H * zoom }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerLeave={() => { setHover(null); }}
              onContextMenu={(e) => e.preventDefault()}
              data-tool={mode === "browse" ? "pan" : mode === "tiles" ? "paint" : assetTool.kind}
            >
              <div className="oe-scaled" style={{ transform: `scale(${zoom})`, width: W, height: H }}>
                <RoomView
                  spec={spec}
                  grid={grid}
                  hover={hover}
                  ghost={rectGhost ? { c: Math.min(rectGhost.a.c, rectGhost.b.c), r: Math.min(rectGhost.a.r, rectGhost.b.r), w: Math.abs(rectGhost.a.c - rectGhost.b.c) + 1, h: Math.abs(rectGhost.a.r - rectGhost.b.r) + 1, ok: true } : ghost}
                  selection={mode === "assets" ? selection : null}
                  problems={problems}
                  focusCells={focus?.cells ?? null}
                  doorTool={mode === "assets" && assetTool.kind === "door"}
                />
              </div>
            </div>
            <div className="oe-status">
              <span>{notice || hoverInfo || `${spec.cols}×${spec.rows} 칸 · 소품 ${spec.props.length} · 벽걸이 ${spec.decor.length} · NPC ${spec.spots.length}`}</span>
            </div>
          </div>

          {/* 검사·선택 */}
          <aside className="oe-inspector">
            {selected && !readOnly && (
              <div className="oe-selected-box">
                <b>{selected.title}</b>
                <span>{selected.where}</span>
                {selected.spot && (
                  <div className="oe-dirs">
                    {(["up", "left", "down", "right"] as Dir[]).map((d) => (
                      <button key={d} type="button" data-on={selected.spot?.face === d ? "true" : undefined} onClick={() => selection?.index !== undefined && commit(faceSpot(spec, selection.index, d))}>{DIR_LABEL[d]}</button>
                    ))}
                  </div>
                )}
                {selection?.kind !== "start" && <button type="button" className="oe-btn oe-danger" onClick={() => remove(selection)}>지우기</button>}
              </div>
            )}
            <h4>검사 {problems.length ? <span className="oe-count" data-level={errors.length ? "error" : "warn"}>{problems.length}</span> : <span className="oe-ok">통과</span>}</h4>
            {unknownKinds.length > 0 && <p className="oe-problem-row" data-level="warn">모르는 소품 이름: {unknownKinds.join(", ")} — 그리지 못합니다</p>}
            <ul className="oe-problems">
              {problems.map((p, i) => (
                <li key={i}>
                  <button type="button" className="oe-problem-row" data-level={p.level} data-on={focus === p ? "true" : undefined} onClick={() => setFocus(focus === p ? null : p)}>
                    {p.message}
                  </button>
                </li>
              ))}
            </ul>
            <div className="oe-legend">
              <p><b>단축키</b></p>
              <p>· 1 / 2 / 3 모드 · G 격자 · Ctrl+Z / Ctrl+Y 되돌리기 · Esc 선택 해제</p>
              <p>· 방향키 옮기기 · Delete 지우기 · R NPC 방향 · Ctrl+휠 배율 · Alt+끌기 화면 옮기기</p>
              <p><b>규칙</b></p>
              <p>· 문은 아래 줄, 두 칸. 문 앞과 시작 지점 앞은 비워야 합니다.</p>
              <p>· 둘레 벽을 허물면 방이 넓어집니다 (최대 {SCENE_LIMITS.maxCols}×{SCENE_LIMITS.maxRows} 칸).</p>
              <p>· NPC 자리는 문에서 걸어서 닿아야 합니다.</p>
              <p>· 벽걸이는 위쪽 벽에 걸립니다. 아래 칸에 키 큰 소품이 있으면 옆으로 밀립니다.</p>
              <p>· 남쪽 줄(복도 아래)에 놓이면 위아래가 뒤집혀 그려집니다.</p>
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}

const DIR_LABEL: Record<Dir, string> = { up: "위", down: "아래", left: "왼쪽", right: "오른쪽" };

/** 칸 수 입력 — 타이핑 도중에는 반영하지 않는다. "12" 를 치는 사이 "1" 이 방을 6칸으로 줄여 소품을 날려 버렸다.
 *  −/+ 는 한 칸씩 곧바로, 글자는 놓거나 Enter 할 때 한 번에. 범위 밖은 끝으로 맞춘다. */
function Stepper({ label, value, min, max, disabled, onCommit }: { label: string; value: number; min: number; max: number; disabled?: boolean; onCommit: (v: number) => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const settle = () => {
    const n = Math.round(Number(text));
    if (!Number.isFinite(n)) { setText(String(value)); return; }
    const v = Math.max(min, Math.min(max, n));
    setText(String(v));
    if (v !== value) onCommit(v);
  };
  return (
    <label className="oe-field oe-stepper" title={`${min}~${max}`}>
      {label}
      <button type="button" aria-label={`${label} 한 칸 줄이기`} disabled={disabled || value <= min} onClick={() => onCommit(value - 1)}>−</button>
      <input
        inputMode="numeric"
        value={text}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onBlur={settle}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); (e.target as HTMLInputElement).blur(); } if (e.key === "Escape") { setText(String(value)); (e.target as HTMLInputElement).blur(); } }}
      />
      <button type="button" aria-label={`${label} 한 칸 늘리기`} disabled={disabled || value >= max} onClick={() => onCommit(value + 1)}>+</button>
    </label>
  );
}

/** 팔레트의 작은 그림 — 아틀라스에서 꺼내 칸에 맞춰 줄인다 */
function SpriteThumb({ kind }: { kind: string }) {
  const s = (S as Record<string, { x: number; y: number; w: number; h: number; sheet: string }>)[kind];
  if (!s) return null;
  const scale = Math.min(40 / s.w, 40 / s.h, 1);
  return (
    <span className="oe-thumb" style={{ width: s.w * scale, height: s.h * scale }}>
      <span className="o-sprite" style={{ left: 0, top: 0, width: s.w, height: s.h, transform: `scale(${scale})`, transformOrigin: "0 0", backgroundImage: `url(${ATLAS[s.sheet].src})`, backgroundSize: `${ATLAS[s.sheet].w}px ${ATLAS[s.sheet].h}px`, backgroundPosition: `-${s.x}px -${s.y}px` }} />
    </span>
  );
}

import { ATLAS, S, floorSrc } from "../atlas";

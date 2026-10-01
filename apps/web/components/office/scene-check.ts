/** 장면(방 설계도)의 검증기 — 편집기가 저장 전에, 사무실이 그리기 전에 같은 규칙을 본다.
 *
 *  배치기(floorplan.layoutRoom)는 잘못된 장면을 만나면 개발 모드에서 throw 한다. 관리자가 만드는 장면은
 *  편집하는 동안 얼마든지 잘못될 수 있으므로, throw 하지 않고 **문제 목록**을 돌려주는 검사가 따로 있어야
 *  한다. 규칙은 배치기·테스트(floorplan.test.ts)와 같다 — 여기서 통과한 장면은 배치기가 반드시 깔 수 있다.
 *
 *  좌표는 장면 좌표(북쪽 방 기준, 문이 아래 줄)다.
 */
import { FOOT, FLOOR_KEYS, type FloorKey } from "./atlas.ts";
import { SCENE_LIMITS, WALKABLE_PROPS, doorColsOf, type SceneSpec, migrateScene } from "./scenes.ts";

export interface SceneProblem {
  /** error 는 저장할 수 없다, warn 은 저장은 되지만 알려 준다 */
  level: "error" | "warn";
  code: string;
  message: string;
  /** 문제의 칸들 — 편집기가 빨갛게 칠한다 */
  cells?: { c: number; r: number }[];
}

const FLOOR_SET = new Set<string>(FLOOR_KEYS as readonly string[]);

function foot(kind: string) {
  return (FOOT as Record<string, { w: number; h: number; rise: number; wall: boolean; vis: number }>)[kind];
}

/** 장면 하나를 검사한다. 빈 배열이면 배치기가 확실히 깔 수 있다. */
export function validateScene(spec: SceneSpec): SceneProblem[] {
  const out: SceneProblem[] = [];
  const err = (code: string, message: string, cells?: { c: number; r: number }[]) => out.push({ level: "error", code, message, cells });
  const warn = (code: string, message: string, cells?: { c: number; r: number }[]) => out.push({ level: "warn", code, message, cells });

  const { cols, rows } = spec;
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < SCENE_LIMITS.minCols || cols > SCENE_LIMITS.maxCols || rows < SCENE_LIMITS.minRows || rows > SCENE_LIMITS.maxRows) {
    err("size", `방 크기는 ${SCENE_LIMITS.minCols}~${SCENE_LIMITS.maxCols} × ${SCENE_LIMITS.minRows}~${SCENE_LIMITS.maxRows} 칸이어야 합니다 (지금 ${cols}×${rows})`);
    return out; // 크기가 틀리면 나머지 검사는 뜻이 없다
  }
  if (!spec.label || !spec.label.trim()) warn("label", "장면 이름이 비어 있습니다");
  if (!FLOOR_SET.has(spec.floor)) err("floor", `모르는 바닥 ${String(spec.floor)}`);

  const inside = (c: number, r: number) => Number.isInteger(c) && Number.isInteger(r) && c >= 0 && c < cols && r >= 0 && r < rows;
  const idx = (c: number, r: number) => r * cols + c;
  // 칸 점유: 0 빈 칸, 1 벽(컷), 5 소품/책상
  const grid = new Uint8Array(cols * rows);
  const owner = new Array<string>(cols * rows).fill("");

  // 문
  if (typeof spec.door === "number" && (!Number.isInteger(spec.door) || spec.door < 0 || spec.door + 1 >= cols)) {
    err("door", `문 위치 ${spec.door} 가 방 밖입니다 (0~${cols - 2})`);
  }
  const [d0, d1] = doorColsOf(spec);
  const doorCells = [{ c: d0, r: rows - 1 }, { c: d1, r: rows - 1 }];
  const isDoor = (c: number, r: number) => r === rows - 1 && (c === d0 || c === d1);

  // 컷
  for (const cut of spec.cuts ?? []) {
    const bad: { c: number; r: number }[] = [];
    for (let dr = 0; dr < cut.h; dr += 1) for (let dc = 0; dc < cut.w; dc += 1) {
      const c = cut.c + dc, r = cut.r + dr;
      if (!inside(c, r)) { bad.push({ c, r }); continue; }
      if (isDoor(c, r)) err("cut-door", `문 칸 (${c},${r}) 은 벽으로 만들 수 없습니다`, [{ c, r }]);
      grid[idx(c, r)] = 1;
      owner[idx(c, r)] = "벽";
    }
    if (bad.length) err("cut-bounds", "벽 칸이 방 밖에 있습니다", bad.filter((b) => inside(Math.max(0, Math.min(cols - 1, b.c)), Math.max(0, Math.min(rows - 1, b.r)))));
  }

  // 소품
  const occupy = (c: number, r: number, what: string) => {
    if (!inside(c, r)) return "밖";
    const i = idx(c, r);
    if (grid[i] !== 0) return owner[i];
    grid[i] = 5;
    owner[i] = what;
    return "";
  };
  spec.props.forEach((p, n) => {
    const f = foot(p.kind);
    if (!f) { err("prop-kind", `모르는 소품 ${p.kind}`); return; }
    if (f.wall) { err("prop-wall", `${p.kind} 은 벽걸이라 바닥에 놓을 수 없습니다`, [{ c: p.c, r: p.r }]); return; }
    if (WALKABLE_PROPS.has(p.kind)) return;
    for (let dr = 0; dr < f.h; dr += 1) for (let dc = 0; dc < f.w; dc += 1) {
      const c = p.c + dc, r = p.r + dr;
      const hit = occupy(c, r, `${p.kind}#${n}`);
      if (hit === "밖") err("prop-bounds", `소품 ${p.kind} 이 방 밖으로 나갑니다`, [{ c: Math.min(cols - 1, Math.max(0, c)), r: Math.min(rows - 1, Math.max(0, r)) }]);
      else if (hit) err("overlap", `소품 ${p.kind} 이 (${c},${r}) 에서 ${hit.replace(/#\d+$/, "")} 과 겹칩니다`, [{ c, r }]);
      else if (isDoor(c, r)) err("prop-door", `소품 ${p.kind} 이 문 칸 (${c},${r}) 을 막습니다`, [{ c, r }]);
    }
  });

  // 시작 지점 (2×1) + 앞 줄
  const st = spec.start;
  if (!st || !inside(st.c, st.r) || !inside(st.c + 1, st.r)) {
    err("start-bounds", "시작 지점(2칸)이 방 밖입니다", st && inside(st.c, st.r) ? [{ c: st.c, r: st.r }] : undefined);
  } else {
    for (const c of [st.c, st.c + 1]) {
      const hit = occupy(c, st.r, "시작 지점");
      if (hit) err("start-overlap", `시작 지점이 (${c},${st.r}) 에서 ${hit.replace(/#\d+$/, "")} 과 겹칩니다`, [{ c, r: st.r }]);
      if (isDoor(c, st.r)) err("start-door", "시작 지점이 문 칸을 막습니다", [{ c, r: st.r }]);
    }
    if (st.r + 1 >= rows) err("start-front", "시작 지점이 마지막 줄입니다 — 앞에 설 곳이 없습니다", [{ c: st.c, r: st.r }, { c: st.c + 1, r: st.r }]);
    else {
      for (const c of [st.c, st.c + 1]) {
        if (grid[idx(c, st.r + 1)] !== 0) err("start-front", `시작 지점 앞 (${c},${st.r + 1}) 이 막혀 있습니다`, [{ c, r: st.r + 1 }]);
        else if (isDoor(c, st.r + 1)) err("start-front-door", `시작 지점 앞 (${c},${st.r + 1}) 이 문 칸입니다`, [{ c, r: st.r + 1 }]);
      }
    }
  }

  // 문 앞
  for (const d of doorCells) if (grid[idx(d.c, d.r)] !== 0) err("door-blocked", `문 앞 (${d.c},${d.r}) 이 막혀 있습니다`, [d]);

  // 문에서 닿는 칸
  const reached = new Set<number>();
  const frontier: number[] = [];
  for (const d of doorCells) if (grid[idx(d.c, d.r)] === 0) { reached.add(idx(d.c, d.r)); frontier.push(idx(d.c, d.r)); }
  while (frontier.length) {
    const cur = frontier.shift() as number;
    const cc = cur % cols, rr = (cur - cc) / cols;
    for (const [a, b] of [[cc - 1, rr], [cc + 1, rr], [cc, rr - 1], [cc, rr + 1]]) {
      if (!inside(a, b) || grid[idx(a, b)] !== 0) continue;
      const n = idx(a, b);
      if (!reached.has(n)) { reached.add(n); frontier.push(n); }
    }
  }
  if (st && inside(st.c, st.r) && st.r + 1 < rows) {
    for (const c of [st.c, st.c + 1]) {
      if (grid[idx(c, st.r + 1)] === 0 && !reached.has(idx(c, st.r + 1))) err("start-unreachable", "문에서 시작 지점까지 갈 수 없습니다", [{ c, r: st.r + 1 }]);
    }
  }
  // 빈 칸인데 문에서 못 가는 칸 — 오류는 아니지만 알려 준다(사람이 갇힌다)
  const stranded: { c: number; r: number }[] = [];
  for (let r = 0; r < rows; r += 1) for (let c = 0; c < cols; c += 1) if (grid[idx(c, r)] === 0 && !reached.has(idx(c, r))) stranded.push({ c, r });
  if (stranded.length) warn("stranded", `문에서 갈 수 없는 빈 칸이 ${stranded.length}개 있습니다`, stranded);

  // 서는 자리
  const seen = new Set<number>();
  spec.spots.forEach((sp, n) => {
    if (!inside(sp.c, sp.r)) { err("spot-bounds", `NPC ${n + 1} 자리가 방 밖입니다`); return; }
    if (!["up", "down", "left", "right"].includes(sp.face)) err("spot-face", `NPC ${n + 1} 의 방향 ${String(sp.face)} 을 모릅니다`, [{ c: sp.c, r: sp.r }]);
    const i = idx(sp.c, sp.r);
    if (grid[i] !== 0) err("spot-blocked", `NPC ${n + 1} 자리 (${sp.c},${sp.r}) 가 ${owner[i].replace(/#\d+$/, "")} 위입니다`, [{ c: sp.c, r: sp.r }]);
    else if (!reached.has(i)) err("spot-unreachable", `NPC ${n + 1} 자리 (${sp.c},${sp.r}) 에 문에서 갈 수 없습니다`, [{ c: sp.c, r: sp.r }]);
    if (st && sp.r === st.r + 1 && (sp.c === st.c || sp.c === st.c + 1)) err("spot-start", `NPC ${n + 1} 자리가 시작 지점 앞 칸입니다`, [{ c: sp.c, r: sp.r }]);
    if (seen.has(i)) err("spot-dup", `NPC 자리 (${sp.c},${sp.r}) 가 두 번 있습니다`, [{ c: sp.c, r: sp.r }]);
    seen.add(i);
  });
  if (spec.spots.length === 0) warn("no-spots", "NPC 자리가 없습니다 — 동료는 빈 칸에 알아서 섭니다");

  // 벽걸이 — 위쪽 벽의 앞면. 그 아래 줄에 컷이나 위로 솟는 소품이 있으면 걸 수 없고, 남쪽 방(위아래 뒤집힘)에서는
  // 문 칸도 피해야 한다. 배치기(layoutRoom)와 같은 규칙: 북쪽 방은 장면의 첫 줄이, 남쪽 방은 장면의 **마지막 줄**이
  // 위쪽 벽 아래에 온다.
  const risingNorth = new Set<number>();
  const risingSouth = new Set<number>();
  for (const p of spec.props) {
    const f = foot(p.kind);
    if (!f || f.wall || f.rise <= 0) continue;
    if (p.r === 0) for (let dc = 0; dc < f.w; dc += 1) risingNorth.add(p.c + dc);
    if (p.r + f.h === rows) for (let dc = 0; dc < f.w; dc += 1) risingSouth.add(p.c + dc);
  }
  if (st && st.r === 0) { risingNorth.add(st.c); risingNorth.add(st.c + 1); }
  const okCol = (c: number, south: boolean) => {
    if (c < 0 || c >= cols) return false;
    const under = south ? rows - 1 : 0;
    if (grid[idx(c, under)] === 1) return false;
    if ((south ? risingSouth : risingNorth).has(c)) return false;
    if (south && (c === d0 || c === d1)) return false;
    return true;
  };
  for (const south of [false, true]) {
    const taken = new Set<number>();
    spec.decor.forEach((d, n) => {
      const f = foot(d.kind);
      if (!f) { if (!south) err("decor-kind", `모르는 벽걸이 ${d.kind}`); return; }
      if (!f.wall) { if (!south) err("decor-floor", `${d.kind} 은 바닥 소품이라 벽에 걸 수 없습니다`); return; }
      if (!Number.isInteger(d.c) || d.c < 0 || d.c + f.w > cols) { if (!south) err("decor-bounds", `벽걸이 ${d.kind} 가 벽 밖입니다`); return; }
      let at: number | null = null;
      for (const off of [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 6, -6]) {
        const c = d.c + off;
        let ok = true;
        for (let dc = 0; dc < f.w; dc += 1) if (!okCol(c + dc, south) || taken.has(c + dc)) { ok = false; break; }
        if (ok) { at = c; break; }
      }
      if (at === null) {
        warn("decor-no-room", south ? `벽걸이 ${n + 1}(${d.kind}) 은 남쪽 줄(문이 위)에 놓이면 걸 자리가 없어 빠집니다` : `벽걸이 ${n + 1}(${d.kind}) 을 걸 자리가 없습니다 — 아래 칸의 키 큰 소품이나 벽을 옮기세요`);
        return;
      }
      for (let dc = 0; dc < f.w; dc += 1) taken.add(at + dc);
      if (at !== d.c && !south) warn("decor-moved", `벽걸이 ${n + 1}(${d.kind}) 은 ${d.c} 칸에 걸 수 없어 ${at} 칸으로 밀립니다`);
    });
  }

  // 바닥 타일
  for (const t of spec.tiles ?? []) {
    if (!inside(t.c, t.r)) { err("tile-bounds", "바닥 타일이 방 밖입니다"); continue; }
    if (!FLOOR_SET.has(t.floor)) err("tile-kind", `모르는 바닥 ${String(t.floor)}`, [{ c: t.c, r: t.r }]);
  }

  return out;
}

/** 오류만 — 저장·배치를 막는 것 */
export function sceneErrors(spec: SceneSpec): SceneProblem[] {
  return validateScene(spec).filter((p) => p.level === "error");
}

/** 잘못된 값이 와도 배치기가 죽지 않게 — 오류가 있으면 null */
export function safeScene(spec: unknown): SceneSpec | null {
  if (!spec || typeof spec !== "object") return null;
  const raw = spec as SceneSpec;
  if (!Array.isArray(raw.props) || !Array.isArray(raw.decor) || !Array.isArray(raw.spots) || !raw.start) return null;
  // 저장된 장면은 옛 팩의 이름을 쓰고 있을 수 있다 — 먼저 지금 이름으로 옮긴다
  const s = migrateScene(raw);
  try {
    return sceneErrors(s).length ? null : s;
  } catch {
    return null;
  }
}

export const FLOOR_KEY_SET: ReadonlySet<string> = FLOOR_SET;
export type { FloorKey };

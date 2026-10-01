/** 편집기 상태 — 조작이 장면을 어떻게 바꾸고 되돌리기가 어떻게 쌓이는가.
 *   node --test apps/web/components/office/ */
import assert from "node:assert/strict";
import test from "node:test";

import { SCENES, SCENE_LIMITS, doorColsOf } from "../scenes.ts";
import { validateScene } from "../scene-check.ts";
import {
  addSpot, blankScene, compact, faceSpot, fillRect, hitTest, hitDecor, initialState, moveProp, normalize, openEdge, paintTile,
  placeDecor, placeProp, reduce, removeProp, resize, sameDesign, setDoor, setStart, setWall,
} from "./state.ts";

test("normalize/compact: 컷은 1×1 로 풀리고 저장할 때 군더더기가 빠진다", () => {
  const n = normalize(SCENES.meeting);
  assert.equal(n.cuts?.length, 8, "2×2 컷 두 개 → 칸 8개");
  assert.ok(n.cuts?.every((k) => k.w === 1 && k.h === 1));
  const c = compact({ ...n, tiles: [{ c: 0, r: 2, floor: n.floor }, { c: 1, r: 2, floor: "oak" }, { c: 99, r: 0, floor: "oak" }], door: doorColsOf(n)[0] });
  assert.deepEqual(c.tiles, [{ c: 1, r: 2, floor: "oak" }]);
  assert.equal(c.door, undefined, "가운데 문은 저장하지 않는다");
  assert.deepEqual(validateScene(c).filter((p) => p.level === "error"), []);
});

test("타일·벽: 칠하고, 지우고, 문 칸은 벽이 되지 않는다", () => {
  let s = blankScene("x", "빈 방");
  s = paintTile(s, 1, 1, "oak");
  assert.deepEqual(s.tiles, [{ c: 1, r: 1, floor: "oak" }]);
  s = paintTile(s, 1, 1, s.floor); // 기본과 같으면 타일이 사라진다
  assert.deepEqual(s.tiles, []);
  s = fillRect(s, { c: 0, r: 0 }, { c: 2, r: 1 }, (x, c, r) => paintTile(x, c, r, "walnut"));
  assert.equal(s.tiles?.length, 6);
  s = setWall(s, 0, 0, true);
  assert.equal(s.tiles?.length, 5, "벽이 된 칸의 타일은 빠진다");
  assert.equal(s.cuts?.length, 1);
  const [d0] = doorColsOf(s);
  assert.equal(setWall(s, d0, s.rows - 1, true), s, "문 칸은 벽이 되지 않는다");
  assert.equal(paintTile(s, 99, 0, "oak"), s, "방 밖은 무시");
  s = setWall(s, 0, 0, false);
  assert.equal(s.cuts?.length, 0);
});

test("에셋: 놓기·옮기기·지우기·문·시작 지점·NPC", () => {
  let s = blankScene("x", "빈 방");
  s = placeProp(s, "sofa-blue", 0, 0);
  assert.equal(s.props.length, 1);
  assert.equal(placeProp(s, "sofa-blue", 7, 0), s, "두 칸 소파는 7에서 밖으로 나간다(cols 8)");
  assert.equal(placeProp(s, "clock-blue", 0, 0), s, "벽걸이는 바닥에 못 놓는다");
  s = moveProp(s, 0, 0, 2);
  assert.deepEqual(s.props[0], { kind: "sofa-blue", c: 0, r: 2 });
  assert.deepEqual(hitTest(s, 1, 3), { kind: "prop", index: 0 }, "소파 오른쪽 아래 칸을 눌러도 잡힌다");
  s = placeProp(s, "cooler-1", 6, 4);
  assert.deepEqual(hitTest(s, 6, 3), { kind: "prop", index: 1 }, "솟는 소품은 위 칸에서도 잡힌다");
  s = removeProp(s, 1);
  assert.equal(hitTest(s, 5, 2), null);
  s = placeDecor(s, "board-cork", 6);
  assert.equal(s.decor.length, 1);
  assert.equal(placeDecor(s, "board-cork", 7), s, "2칸 보드는 7에서 벽 밖");
  assert.deepEqual(hitDecor(s, 7), { kind: "decor", index: 0 });
  s = addSpot(s, 1, 4);
  s = faceSpot(s, 0, "left");
  assert.deepEqual(s.spots[0], { c: 1, r: 4, face: "left" });
  assert.deepEqual(hitTest(s, 1, 4), { kind: "spot", index: 0 });
  s = setStart(s, 5, 2);
  assert.deepEqual(s.start, { c: 5, r: 2 });
  assert.equal(setStart(s, 5, 5), s, "마지막 줄에는 시작 지점을 둘 수 없다");
  assert.deepEqual(hitTest(s, 6, 2), { kind: "start" });
  s = setDoor(s, 0);
  assert.equal(s.door, 0);
  s = setWall(s, 5, 5, true);
  assert.equal(setDoor(s, 5, ), s, "벽 칸 위로 문을 옮길 수 없다");
  assert.equal(setDoor(s, 99).door, 6, "범위 밖은 끝으로");
  s = removeProp(s, 0);
  assert.equal(s.props.length, 0);
  assert.deepEqual(validateScene(compact(s)).filter((p) => p.level === "error"), []);
});

test("resize: 밖으로 나가는 것은 버리고 시작 지점·문은 안으로", () => {
  let s = normalize(SCENES.lounge); // 컷은 전부 8×6 밖(오른쪽 위·왼쪽 아래 모서리)
  s = resize(s, 8, 6);
  assert.equal(s.cols, 8);
  assert.ok(s.props.every((p) => p.c < 8 && p.r < 6));
  assert.ok((s.cuts ?? []).length === 0, "컷은 밖");
  assert.ok(s.start.c <= 6 && s.start.r <= 4);
  assert.equal(resize(s, 99, 99).cols, SCENE_LIMITS.maxCols);
  assert.equal(resize(s, 99, 99).rows, SCENE_LIMITS.maxRows);
  assert.equal(resize(s, 1, 1).rows, 5);
});

test("reduce: 되돌리기·다시하기, 한 획은 이력 한 칸", () => {
  let st = initialState(blankScene("x", "빈 방"));
  assert.equal(st.dirty, false);
  st = reduce(st, { type: "commit", spec: paintTile(st.spec, 0, 0, "oak"), coalesce: "stroke-1" });
  st = reduce(st, { type: "commit", spec: paintTile(st.spec, 1, 0, "oak"), coalesce: "stroke-1" });
  st = reduce(st, { type: "commit", spec: paintTile(st.spec, 2, 0, "oak"), coalesce: "stroke-1" });
  assert.equal(st.past.length, 1, "같은 획은 한 칸");
  assert.equal(st.spec.tiles?.length, 3);
  assert.equal(st.dirty, true);
  st = reduce(st, { type: "commit", spec: placeProp(st.spec, "plant-small-1", 0, 0) });
  assert.equal(st.past.length, 2);
  st = reduce(st, { type: "undo" });
  assert.equal(st.spec.props.length, 0);
  st = reduce(st, { type: "undo" });
  assert.equal(st.spec.tiles?.length, 0, "획 전체가 한 번에 돌아간다");
  st = reduce(st, { type: "redo" });
  assert.equal(st.spec.tiles?.length, 3);
  st = reduce(st, { type: "redo" });
  assert.equal(st.spec.props.length, 1);
  assert.equal(reduce(st, { type: "redo" }), st);
  st = reduce(st, { type: "saved" });
  assert.equal(st.dirty, false);
  st = reduce(st, { type: "commit", spec: st.spec });
  assert.equal(st.dirty, false, "같은 장면은 커밋이 아니다");
  // 저장 뒤 되돌렸다 다시 하면 깨끗하다 — 저장한 그 장면으로 돌아왔으니까
  st = reduce(st, { type: "undo" });
  assert.equal(st.dirty, true);
  st = reduce(st, { type: "redo" });
  assert.equal(st.dirty, false, "저장한 장면으로 돌아오면 깨끗해야 한다");
  st = reduce(st, { type: "commit", spec: paintTile(st.spec, 5, 5, "walnut") });
  assert.equal(st.dirty, true);
  st = reduce(st, { type: "undo" });
  assert.equal(st.dirty, false, "커밋을 되돌려 저장 상태로 오면 깨끗하다");
});

test("sameDesign: 서버가 키 순서를 바꾸고 id·이름·null 문을 붙여 돌려줘도 같은 설계다", () => {
  const mine = placeDecor(placeProp(normalize(SCENES.meeting), "plant", 2, 3), "clock", 1);
  const server = JSON.parse(JSON.stringify({ ...compact(mine), id: "7d31dfbc-0000-0000-0000-000000000000", label: "저장된 이름", door: null }));
  // pydantic 처럼 키 순서를 뒤집는다
  server.props = server.props.map((p: { kind: string; c: number; r: number }) => ({ c: p.c, r: p.r, kind: p.kind }));
  assert.ok(sameDesign(server, mine));
  assert.ok(!sameDesign(server, paintTile(mine, 2, 2, "oak")));
  assert.ok(!sameDesign(server, { ...mine, door: 2 }));
});

test("둘레 벽 허물기: 방이 그쪽으로 한 칸 넓어지고 누른 칸만 뚫린다", () => {
  const base = normalize(SCENES.breakroom); // 가운데 문, 컷 없음
  const [d0] = doorColsOf(base);
  const errors = (s: typeof base) => validateScene(s).filter((p) => p.level === "error").map((p) => p.message);

  const top = openEdge(base, "top", 3);
  assert.ok(top);
  assert.equal(top.spec.rows, base.rows + 1);
  assert.deepEqual(top.cell, { c: 3, r: 0 });
  assert.equal(top.spec.props[0].r, base.props[0].r + 1, "안의 것이 한 줄 밀린다");
  assert.equal(top.spec.start.r, base.start.r + 1);
  assert.equal(top.spec.spots[0].r, base.spots[0].r + 1);
  assert.equal(doorColsOf(top.spec)[0], d0, "문은 제자리");
  assert.deepEqual(top.spec.cuts?.filter((k) => k.r === 0).map((k) => k.c), Array.from({ length: base.cols }, (_, c) => c).filter((c) => c !== 3), "새 줄은 누른 칸만 바닥");
  assert.deepEqual(errors(top.spec), []);

  const left = openEdge(base, "left", 2);
  assert.ok(left);
  assert.equal(left.spec.cols, base.cols + 1);
  assert.deepEqual(left.cell, { c: 0, r: 2 });
  assert.equal(doorColsOf(left.spec)[0], d0 + 1, "문도 같이 밀린다");
  assert.equal(left.spec.decor[0].c, base.decor[0].c + 1, "벽걸이도 같이 밀린다");
  assert.equal(left.spec.cuts?.filter((k) => k.c === 0).length, base.rows - 1);
  assert.deepEqual(errors(left.spec), []);

  const right = openEdge(base, "right", 1);
  assert.ok(right);
  assert.equal(right.spec.cols, base.cols + 1);
  assert.equal(doorColsOf(right.spec)[0], d0, "너비가 바뀌어도 가운데 문이 옮겨 가지 않는다");
  assert.equal(right.spec.props[0].c, base.props[0].c, "오른쪽으로 넓히면 아무것도 밀리지 않는다");
  assert.deepEqual(errors(right.spec), []);

  const bottom = openEdge(base, "bottom", 1);
  assert.ok(bottom);
  assert.equal(bottom.spec.rows, base.rows + 1);
  const last = new Set(bottom.spec.cuts?.filter((k) => k.r === base.rows).map((k) => k.c));
  assert.ok(!last.has(1) && !last.has(d0) && !last.has(d0 + 1), "누른 칸과 문 칸은 새 아래 줄에서도 열려 있다");
  assert.deepEqual(errors(bottom.spec), []);

  // 저장 모양으로 돌렸다 풀어도 같은 설계다(문 위치를 박아 둔 것이 가운데와 같으면 compact 가 지운다)
  assert.ok(sameDesign(normalize(compact(right.spec)), right.spec));

  assert.equal(openEdge({ ...base, cols: SCENE_LIMITS.maxCols }, "left", 0), null, "최대 너비");
  assert.equal(openEdge({ ...base, rows: SCENE_LIMITS.maxRows }, "top", 0), null, "최대 높이");
  assert.equal(openEdge(base, "top", base.cols), null, "벽 길이 밖");
});

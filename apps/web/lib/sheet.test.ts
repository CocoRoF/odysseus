import assert from "node:assert/strict";
import { test } from "node:test";
import {
  bounds,
  clearRange,
  clipboardToGrid,
  deleteCols,
  deleteRows,
  fillDown,
  insertCols,
  insertRows,
  jumpEdge,
  pasteAt,
  rangeToClipboard,
  rectangular,
  sortRows,
  summarize,
  trimGrid,
} from "./sheet.ts";
import { History, undoRedoIntent } from "./history.ts";

const G = () => [
  ["이름", "값", "비고"],
  ["가", "10", ""],
  ["나", "20", "메모"],
  ["다", "5", ""],
];

test("고른 영역은 끄는 방향과 무관하게 같은 경계다", () => {
  const a = bounds({ anchor: { r: 3, c: 2 }, focus: { r: 1, c: 0 } });
  const b = bounds({ anchor: { r: 1, c: 0 }, focus: { r: 3, c: 2 } });
  assert.deepEqual(a, b);
  assert.deepEqual(a, { r1: 1, c1: 0, r2: 3, c2: 2 });
});

test("줄마다 길이가 달라도 격자로 맞춘다", () => {
  const ragged = [["a"], ["b", "c", "d"], []];
  assert.deepEqual(rectangular(ragged), [
    ["a", "", ""],
    ["b", "c", "d"],
    ["", "", ""],
  ]);
});

test("화면에서 늘려 둔 빈칸은 파일에 남지 않는다", () => {
  const padded = [
    ["a", "b", "", ""],
    ["c", "", "", ""],
    ["", "", "", ""],
  ];
  assert.deepEqual(trimGrid(padded), [
    ["a", "b"],
    ["c", ""],
  ]);
  // 전부 비면 한 칸짜리 표로 — 파일이 사라지지는 않는다
  assert.deepEqual(trimGrid([["", ""], ["", ""]]), [[""]]);
});

test("행·열 넣기와 지우기", () => {
  assert.deepEqual(insertRows(G(), 1)[1], ["", "", ""]);
  assert.deepEqual(deleteRows(G(), 0)[0], ["가", "10", ""]);
  assert.deepEqual(insertCols(G(), 1)[0], ["이름", "", "값", "비고"]);
  assert.deepEqual(deleteCols(G(), 1)[0], ["이름", "비고"]);
  // 마지막 한 줄·한 칸은 남긴다 — 표가 사라지면 저장할 것이 없어진다
  assert.equal(deleteRows([["x"]], 0).length, 1);
  assert.deepEqual(deleteCols([["x"]], 0), [[""]]);
});

test("지우기는 값만 비우고 칸은 남긴다", () => {
  const out = clearRange(G(), { anchor: { r: 1, c: 1 }, focus: { r: 2, c: 2 } });
  assert.deepEqual(out[1], ["가", "", ""]);
  assert.deepEqual(out[2], ["나", "", ""]);
  assert.deepEqual(out[3], ["다", "5", ""]);
});

test("Ctrl+D 는 맨 위 칸을 아래로 채운다", () => {
  const out = fillDown(G(), { anchor: { r: 1, c: 1 }, focus: { r: 3, c: 1 } });
  assert.deepEqual(out.map((r) => r[1]), ["값", "10", "10", "10"]);
  // 한 칸만 골랐으면 아무 일도 없다
  assert.deepEqual(fillDown(G(), { anchor: { r: 1, c: 1 }, focus: { r: 1, c: 1 } }), G());
});

test("정렬은 머리글을 건드리지 않고, 숫자는 숫자로 비교한다", () => {
  const asc = sortRows(G(), 1, "asc");
  assert.equal(asc[0][0], "이름");
  assert.deepEqual(asc.slice(1).map((r) => r[1]), ["5", "10", "20"]);
  const desc = sortRows(G(), 1, "desc");
  assert.deepEqual(desc.slice(1).map((r) => r[1]), ["20", "10", "5"]);
});

test("복사는 엑셀이 읽는 탭 구분 글로 나간다", () => {
  const text = rangeToClipboard(G(), { anchor: { r: 0, c: 0 }, focus: { r: 1, c: 1 } });
  assert.equal(text, "이름\t값\n가\t10");
  // 값 안의 탭·줄바꿈은 따옴표로 지킨다
  const tricky = [["가\t나", "다\n라"]];
  assert.equal(rangeToClipboard(tricky, { anchor: { r: 0, c: 0 }, focus: { r: 0, c: 1 } }), '"가\t나"\t"다\n라"');
});

test("붙여넣기 글은 탭이 먼저, 탭이 없고 쉼표가 있으면 CSV 로 읽는다", () => {
  assert.deepEqual(clipboardToGrid("a\tb\nc\td"), [["a", "b"], ["c", "d"]]);
  assert.deepEqual(clipboardToGrid("a,b\nc,d"), [["a", "b"], ["c", "d"]]);
  // 쉼표가 값 안에 있는 CSV — 따옴표를 지킨다
  assert.deepEqual(clipboardToGrid('"서울, 강남",2\n대전,3'), [["서울, 강남", "2"], ["대전", "3"]]);
  // 탭이 하나라도 있으면 탭이 구분자다 (쉼표가 값인 경우)
  assert.deepEqual(clipboardToGrid("서울, 강남\t2"), [["서울, 강남", "2"]]);
});

test("붙여넣기는 모자라면 표를 넓힌다", () => {
  const { grid, range } = pasteAt([["a"]], { r: 1, c: 1 }, [["x", "y"], ["z", "w"]]);
  assert.deepEqual(grid, [
    ["a", "", ""],
    ["", "x", "y"],
    ["", "z", "w"],
  ]);
  assert.deepEqual(range, { anchor: { r: 1, c: 1 }, focus: { r: 2, c: 2 } });
});

test("Ctrl+방향키는 값이 끊기는 자리까지 뛴다", () => {
  const g = [
    ["a", "b", "", "d"],
    ["", "", "", ""],
    ["e", "", "", ""],
  ];
  // 값 위를 달린다 → 끊기기 직전
  assert.deepEqual(jumpEdge(g, { r: 0, c: 0 }, 0, 1, 3, 4), { r: 0, c: 1 });
  // 빈 곳을 향한다 → 다음 값
  assert.deepEqual(jumpEdge(g, { r: 0, c: 1 }, 0, 1, 3, 4), { r: 0, c: 3 });
  // 끝까지 비어 있으면 가장자리
  assert.deepEqual(jumpEdge(g, { r: 0, c: 3 }, 1, 0, 3, 4), { r: 2, c: 3 });
});

test("상태 표시줄은 고른 영역만 센다", () => {
  const s = summarize(G(), { anchor: { r: 1, c: 1 }, focus: { r: 3, c: 1 } });
  assert.deepEqual(s, { cells: 3, numbers: 3, sum: 35, avg: 35 / 3 });
  // 글자는 개수에만 들어간다
  const t = summarize(G(), { anchor: { r: 0, c: 0 }, focus: { r: 1, c: 1 } });
  assert.deepEqual({ cells: t.cells, numbers: t.numbers, sum: t.sum }, { cells: 4, numbers: 1, sum: 10 });
});

// ── 되돌리기 ──────────────────────────────────────────────────────

test("한 칸에 이어 친 글자는 되돌리기 한 번에 되돌아간다", () => {
  let t = 0;
  const h = new History("", { now: () => t, coalesceMs: 600 });
  for (const v of ["1", "12", "123", "1234"]) {
    t += 50;
    h.push(v, "cell:1,1");
  }
  assert.equal(h.value, "1234");
  assert.equal(h.undo(), "");
});

test("자리가 바뀌면 걸음도 나뉜다", () => {
  let t = 0;
  const h = new History("", { now: () => t });
  t += 10; h.push("a", "cell:0,0");
  t += 10; h.push("ab", "cell:0,0");
  t += 10; h.push("ab|x", "cell:0,1");
  assert.equal(h.undo(), "ab");
  assert.equal(h.undo(), "");
  assert.equal(h.canUndo, false);
  assert.equal(h.redo(), "ab");
  assert.equal(h.redo(), "ab|x");
});

test("시간이 벌어지면 같은 자리라도 나뉜다", () => {
  let t = 0;
  const h = new History("", { now: () => t, coalesceMs: 500 });
  t += 10; h.push("a", "cell:0,0");
  t += 900; h.push("ab", "cell:0,0");
  assert.equal(h.undo(), "a");
});

test("새 걸음을 올리면 다시하기는 사라진다", () => {
  const h = new History("v0");
  h.push("v1", "x");
  h.undo();
  h.push("v2", "y");
  assert.equal(h.canRedo, false);
  assert.equal(h.value, "v2");
});

test("되돌리기 단축키는 윈도우·맥 관습을 모두 받는다", () => {
  const k = (key: string, mod: Partial<{ ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }> = {}) => ({
    key,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...mod,
  });
  assert.equal(undoRedoIntent(k("z", { ctrlKey: true })), "undo");
  assert.equal(undoRedoIntent(k("Z", { ctrlKey: true, shiftKey: true })), "redo");
  assert.equal(undoRedoIntent(k("y", { ctrlKey: true })), "redo");
  assert.equal(undoRedoIntent(k("z", { metaKey: true })), "undo");
  assert.equal(undoRedoIntent(k("z", { metaKey: true, shiftKey: true })), "redo");
  assert.equal(undoRedoIntent(k("z")), null);
  assert.equal(undoRedoIntent(k("s", { ctrlKey: true })), null);
});

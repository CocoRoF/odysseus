import assert from "node:assert/strict";
import { test } from "node:test";
import { caretPosition, lineRange, listMarker, mirrorScroll, onEnter, onTab } from "./markdown-edit.ts";

test("줄 범위는 커서가 놓인 줄을 집는다", () => {
  const t = "첫 줄\n둘째 줄\n셋째";
  assert.deepEqual(lineRange(t, 0), { start: 0, end: 3 });
  assert.deepEqual(lineRange(t, 5), { start: 4, end: 8 });
  assert.deepEqual(lineRange(t, t.length), { start: 9, end: t.length });
});

test("목록 표식 읽기", () => {
  assert.deepEqual(listMarker("- 항목"), { indent: "", marker: "- ", filled: true });
  assert.deepEqual(listMarker("  * 항목"), { indent: "  ", marker: "* ", filled: true });
  assert.deepEqual(listMarker("3. 셋째"), { indent: "", marker: "4. ", filled: true });
  assert.deepEqual(listMarker("> 인용"), { indent: "", marker: "> ", filled: true });
  // 체크 목록은 빈 상자로 이어 준다 — 회의록의 액션 아이템
  assert.deepEqual(listMarker("- [x] 끝난 일"), { indent: "", marker: "- [ ] ", filled: true });
  // 표식만 있고 내용이 없다
  assert.equal(listMarker("- ")?.filled, false);
  assert.equal(listMarker("그냥 문장"), null);
  assert.equal(listMarker(""), null);
});

test("Enter 는 목록을 이어 준다", () => {
  const t = "- 첫째";
  const r = onEnter(t, t.length);
  assert.equal(r?.text, "- 첫째\n- ");
  assert.equal(r?.caret, "- 첫째\n- ".length);
});

test("Enter 는 번호를 스스로 센다", () => {
  const t = "1. 하나\n2. 둘";
  const r = onEnter(t, t.length);
  assert.equal(r?.text, "1. 하나\n2. 둘\n3. ");
});

test("빈 항목에서 Enter 는 목록을 끝낸다", () => {
  const t = "- 첫째\n- ";
  const r = onEnter(t, t.length);
  assert.equal(r?.text, "- 첫째\n");
  assert.equal(r?.caret, "- 첫째\n".length);
});

test("목록이 아니면 Enter 는 평소대로", () => {
  assert.equal(onEnter("그냥 문장", 5), null);
});

test("들여쓰기한 목록도 그 깊이를 잇는다", () => {
  const t = "- 위\n  - 아래";
  const r = onEnter(t, t.length);
  assert.equal(r?.text, "- 위\n  - 아래\n  - ");
});

test("Tab 은 고른 줄 전체를 들여쓴다", () => {
  const t = "첫째\n둘째\n셋째";
  const r = onTab(t, 0, 6, false); // 첫째~둘째
  assert.equal(r.text, "  첫째\n  둘째\n셋째");
  assert.equal(r.caret, 2);
  assert.equal(r.selectionEnd, 10);
});

test("Shift+Tab 은 내어쓴다 (공백이 없으면 그대로)", () => {
  const t = "  첫째\n둘째";
  const r = onTab(t, 0, t.length, true);
  assert.equal(r.text, "첫째\n둘째");
});

test("고른 것이 없으면 Tab 은 그 자리에 공백을 넣는다 — 포커스를 뺏지 않는다", () => {
  const r = onTab("가나", 1, 1, false);
  assert.equal(r.text, "가  나");
  assert.equal(r.caret, 3);
});

test("목록 안이면 커서가 어디에 있든 항목 전체가 들어간다", () => {
  const t = "- 항목";
  // 줄 끝에서 Tab — 공백이 뒤에 붙는 것이 아니라 항목이 한 단 들어가야 한다
  assert.equal(onTab(t, t.length, t.length, false).text, "  - 항목");
  // 번호 목록도, 인용도 같다
  assert.equal(onTab("1. 하나", 5, 5, false).text, "  1. 하나");
  assert.equal(onTab("> 인용", 4, 4, false).text, "  > 인용");
  // 목록이 아니면 예전대로 그 자리에 공백
  assert.equal(onTab("문장", 2, 2, false).text, "문장  ");
});

test("미리보기는 비율로 따라간다", () => {
  assert.equal(mirrorScroll({ scrollTop: 0, scrollHeight: 1000, clientHeight: 500 }), 0);
  assert.equal(mirrorScroll({ scrollTop: 250, scrollHeight: 1000, clientHeight: 500 }), 0.5);
  // 내용이 화면보다 짧으면 따라갈 곳이 없다 (0으로 나누지 않는다)
  assert.equal(mirrorScroll({ scrollTop: 0, scrollHeight: 300, clientHeight: 500 }), 0);
});

test("커서 자리는 1부터 센다 — 편집기의 관습", () => {
  const t = "첫 줄\n둘째";
  assert.deepEqual(caretPosition(t, 0), { line: 1, column: 1 });
  assert.deepEqual(caretPosition(t, 3), { line: 1, column: 4 });
  assert.deepEqual(caretPosition(t, 4), { line: 2, column: 1 });
});

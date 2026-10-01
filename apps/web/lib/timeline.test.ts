import assert from "node:assert/strict";
import { test } from "node:test";
import { describeEvent, groupEvents, hasRawDetail, humanMs } from "./timeline.ts";

test("타임라인 줄은 payload 대신 사람이 읽는 말로 적힌다", () => {
  assert.equal(describeEvent("app_open", { app: "docs::1", seq: 7, client_id: "x" }), "문서");
  assert.equal(describeEvent("window_focus", { away_ms: 15901 }), "16초 만에 돌아옴");
  assert.equal(describeEvent("window_focus", { away_ms: 4720 }), "4.7초 만에 돌아옴");
  assert.equal(describeEvent("file_save", { path: "output/report.md" }), "output/report.md");
  assert.equal(describeEvent("file_save", { path: "output/report.md", actor: "docs" }), "output/report.md · 문서");
  assert.equal(describeEvent("file_open", { path: "notes/규정.md", actor: "viewer" }), "notes/규정.md · 뷰어");
  // 옛 기록의 기본값은 이름을 붙이지 않는다
  assert.equal(describeEvent("file_save", { path: "a.md", actor: "ide" }), "a.md");
  assert.equal(
    describeEvent("mail_sent", { to: "김하늘, 박준영", subject: "RE: 납기 지연", cc: "정소민", words: 210, quoted: true }),
    "김하늘, 박준영 → RE: 납기 지연 · 참조 정소민 · 210단어 · 원문 인용",
  );
  assert.equal(describeEvent("mail_sent", { to: "", subject: "보고", words: 0 }), "(수신자 미정) → 보고 · 0단어");
  assert.equal(describeEvent("run_done", { cmd: "python3 a.py", exit_code: 1, ms: 2400 }), "python3 a.py · 실패 (코드 1) · 2.4초");
  assert.equal(describeEvent("msg_received", { character: "이유나", error: "AI_TIMEOUT" }), "이유나 · 답변 실패 (AI_TIMEOUT)");
  // 내부 식별자만 있는 이벤트는 할 말이 없다 — 빈 줄이 JSON 보다 낫다
  assert.equal(describeEvent("window_blur", { seq: 13, client_id: "wk4unxtg" }), "");
  assert.equal(describeEvent("page_enter", { seq: 1, client_id: "wk4unxtg" }), "");
});

test("연달아 같은 일이 벌어지면 한 줄로 묶는다", () => {
  const at = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();
  const rows = groupEvents([
    { id: 1, type: "window_blur", payload: { seq: 1 }, created_at: at(0), source: "client_untrusted" },
    { id: 2, type: "window_focus", payload: { away_ms: 4720 }, created_at: at(1) },
    { id: 3, type: "window_blur", payload: { seq: 2 }, created_at: at(2) },
    { id: 4, type: "window_blur", payload: { seq: 3 }, created_at: at(3) },
    // 한참 뒤의 같은 종류는 따로 센다
    { id: 5, type: "window_blur", payload: { seq: 4 }, created_at: at(600) },
  ]);
  assert.deepEqual(rows.map((r) => [r.type, r.count]), [
    ["window_blur", 1],
    ["window_focus", 1],
    ["window_blur", 2],
    ["window_blur", 1],
  ]);
  assert.equal(rows[0].untrusted, true);
  assert.equal(rows[1].untrusted, false);
  // 원본은 버리지 않는다 — [자세히] 에서 편다
  assert.equal(rows[2].payloads.length, 2);
});

test("길이는 사람이 읽는 단위로", () => {
  assert.equal(humanMs(900), "900ms");
  assert.equal(humanMs(4720), "4.7초");
  assert.equal(humanMs(65000), "1분 5초");
  assert.equal(humanMs(120000), "2분");
});

test("참고 자료 요청은 종류마다 다른 말이 된다", () => {
  assert.equal(describeEvent("reference_request", { source: "github", q: "vllm", page: 1 }), "“vllm” 검색");
  assert.equal(describeEvent("reference_request", { source: "github", repo: "vllm/vllm", file: "README.md" }), "vllm/vllm · README.md");
  assert.equal(describeEvent("reference_request", { source: "web", url: "https://a.dev/x" }), "https://a.dev/x");
  assert.equal(describeEvent("reference_search", { source: "github", q: "odysseus", results: 12 }), "“odysseus” 검색 · 결과 12건");
  assert.equal(describeEvent("reference_open", { source: "github", repo: "a/b", file: "src/main.py" }), "a/b · src/main.py");
  assert.equal(describeEvent("reference_failed", { source: "web", url: "https://a.dev/x", status: 404 }), "https://a.dev/x · 실패 (404)");
  assert.equal(describeEvent("attempt_grant", { agent_turns: 5, messenger_turns: 0, extra_minutes: 30, reason: "AI 장애" }), "에이전트 +5회 · 시간 +30분 · AI 장애");
  assert.equal(describeEvent("file_rename", { from: "a.md", to: "b.md" }), "a.md → b.md");
  assert.equal(describeEvent("scenario_completed", { ordinal: 1, total: 3 }), "2번째 / 전체 3개");
});

test("내부 식별자뿐인 줄에는 펴 볼 원본이 없다", () => {
  assert.equal(hasRawDetail([{ seq: 3, client_id: "wk4unxtg" }]), false);
  assert.equal(hasRawDetail([{ execution_id: "e1", by: "u1" }]), false);
  assert.equal(hasRawDetail([{ seq: 3 }, { away_ms: 900 }]), true);
});

test("끝난 자료 요청은 시작 줄을 접고, 답 없이 끝난 요청만 남긴다", () => {
  const at = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();
  const rows = groupEvents([
    { id: 1, type: "reference_request", payload: { source: "github", q: "vllm" }, created_at: at(0) },
    { id: 2, type: "reference_search", payload: { source: "github", q: "vllm", results: 20 }, created_at: at(1) },
    // 답이 오지 않은 요청은 그대로 보여야 한다
    { id: 3, type: "reference_request", payload: { source: "web", url: "https://a.dev" }, created_at: at(9) },
    { id: 4, type: "app_open", payload: { app: "browser" }, created_at: at(10) },
  ]);
  assert.deepEqual(rows.map((r) => r.type), ["reference_search", "reference_request", "app_open"]);
});

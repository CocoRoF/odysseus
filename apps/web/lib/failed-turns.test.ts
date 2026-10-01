/** 실패한 턴의 안내와 다시 보내기 — 누른 곳과 다른 질문이 나가지 않는다.
 *   node --test lib/ */
import assert from "node:assert/strict";
import test from "node:test";

import { aiErrorNotice, candidateEndedNote, isCandidateEnded } from "./ai-errors.ts";
import { awaitingTurnRecord, isReply, retryableFailureId, retryQuestion } from "./failed-turns.ts";

const q = (id: string, content: string) => ({ id, sender: "candidate", content });
const reply = (id: string, content: string) => ({ id, sender: "npc", content });
const fail = (id: string) => ({ id, sender: "npc", content: "(시스템) …", meta: { error: "AI_TIMEOUT" } });

test("다시 보내기: 마지막 실패에만, 그 실패가 받던 질문으로", () => {
  const thread = [q("1", "마감이 언제죠?"), fail("2")];
  assert.equal(retryableFailureId(thread), "2");
  assert.equal(retryQuestion(thread, "2"), "마감이 언제죠?");
});

test("다시 보내기: 뒤에 성공한 교환이 있으면 지난 실패로는 아무것도 보내지 않는다", () => {
  const thread = [q("1", "마감이 언제죠?"), fail("2"), q("3", "마감이 언제죠?"), reply("4", "금요일이요")];
  assert.equal(retryableFailureId(thread), null);
  assert.equal(retryQuestion(thread, "2"), null);
});

test("다시 보내기: 실패가 두 번이면 앞의 실패 버튼은 뒤의 질문을 보내지 않는다", () => {
  const thread = [q("1", "첫 질문"), fail("2"), q("3", "다른 질문"), fail("4")];
  assert.equal(retryableFailureId(thread), "4");
  assert.equal(retryQuestion(thread, "2"), null, "누른 실패(2)와 다른 질문(3)이 나가면 안 된다");
  assert.equal(retryQuestion(thread, "4"), "다른 질문");
});

test("다시 보내기: 보내는 중(낙관적 메시지가 뒤에 붙음)이면 버튼이 없다", () => {
  const thread = [q("1", "질문"), fail("2"), q("temp-1", "질문")];
  assert.equal(retryableFailureId(thread), null);
});

test("읽지 않음: 실패 안내는 답장으로 세지 않는다", () => {
  assert.equal(isReply(reply("1", "네")), true);
  assert.equal(isReply(fail("2")), false);
  assert.equal(isReply(q("3", "질문")), false);
});

test("안내 문구: 환불 문장은 서버가 돌려준 턴에만 붙는다", () => {
  const base = { error: "AI_RATE_LIMIT", error_message: "AI 공급자의 호출 한도에 걸렸습니다. 잠시 후 다시 시도하세요" };
  assert.equal(aiErrorNotice({ ...base, refunded: true }), `${base.error_message} — 이 질문은 남은 횟수에 포함되지 않습니다.`);
  // 코드가 환불 대상이어도 서버가 돌려주지 않았으면(도구가 돌았다 등) 말하지 않는다
  assert.equal(aiErrorNotice(base), base.error_message);
});

test("안내 문구: 코드 없는 HTTP 실패는 서버의 설명을 그대로 쓴다 (빈 문장 금지)", () => {
  assert.equal(
    aiErrorNotice({ error_message: "이미 진행 중인 에이전트 요청이 있습니다. 끝난 뒤 다시 보내세요" }),
    "이미 진행 중인 에이전트 요청이 있습니다. 끝난 뒤 다시 보내세요",
  );
  assert.equal(aiErrorNotice({ error: "AI_BACKEND_ERROR" }), "AI 처리 중 오류가 났습니다");
  assert.equal(aiErrorNotice({}), null);
});

test("안내 문구: 응시자 쪽 끊김 뒤에 받은 내용이 있으면 '중간에 멈췄다' 고 말한다", () => {
  const meta = { error: "AI_DISCONNECTED", error_message: "연결이 끊겨 답변을 받지 못했습니다" };
  assert.equal(aiErrorNotice(meta), "연결이 끊겨 답변을 받지 못했습니다");
  assert.equal(aiErrorNotice(meta, { partial: true }), "연결이 끊겨 답변이 중간에 멈췄습니다");
});

test("응시자 쪽에서 끝난 턴: 세 코드 모두 장애가 아니고, 평가자 메모는 누가 어떻게 끝냈는지 말한다", () => {
  for (const error of ["AI_CANCELLED", "AI_DISCONNECTED", "AI_INTERRUPTED"]) {
    assert.equal(isCandidateEnded({ error }), true, error);
  }
  assert.equal(isCandidateEnded({ error: "AI_TIMEOUT" }), false);
  assert.equal(candidateEndedNote({ error: "AI_TIMEOUT" }, false), null);
  assert.equal(
    candidateEndedNote({ error: "AI_CANCELLED", refunded: true }, false),
    "응시자가 요청을 중단했습니다 — AI 장애가 아닙니다 · 질문 횟수에 포함되지 않음",
  );
  // 도구가 돌기 시작한 뒤 멈춘 턴은 소모된다 — "포함되지 않음" 을 붙이지 않는다
  assert.equal(
    candidateEndedNote({ error: "AI_INTERRUPTED" }, false),
    "응시자 쪽에서 도구 실행 중에 멈췄습니다 — AI 장애가 아닙니다",
  );
  assert.equal(
    candidateEndedNote({ error: "AI_INTERRUPTED" }, true),
    "응시자 쪽에서 답변이 끝나기 전에 멈췄습니다 — AI 장애가 아닙니다",
  );
});

test("중단 직후 다시 읽기: 답 없는 질문으로 끝나면 서버 기록을 조금 더 기다린다", () => {
  assert.equal(awaitingTurnRecord([]), false);
  assert.equal(awaitingTurnRecord([{ role: "user" }]), true);
  assert.equal(awaitingTurnRecord([{ role: "user" }, { role: "assistant" }]), false);
});

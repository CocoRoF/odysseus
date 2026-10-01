/** 메신저 스레드의 실패한 턴 — 무엇을, 어디서 다시 보낼 수 있는가.
 *
 *  다시 보내기 버튼은 **스레드의 마지막 메시지가 실패일 때 그 실패에만** 붙는다. 뒤에 다른
 *  교환이 이어졌으면 그 질문은 이미 다시 물었거나 대화가 넘어간 것이다. 예전에는 지난 실패마다
 *  버튼이 남아 있었고, 어느 버튼을 눌러도 마지막 실패의 질문이 나갔다 — 누른 곳과 다른 질문이
 *  나가고 횟수까지 소모됐다. */

interface ThreadItem {
  id: string;
  sender: string;
  content: string;
  meta?: { error?: string } | null;
}

/** 다시 보낼 수 있는 실패의 id — 없으면 null */
export function retryableFailureId(thread: readonly ThreadItem[]): string | null {
  const last = thread.at(-1);
  return last && last.sender !== "candidate" && last.meta?.error ? last.id : null;
}

/** 그 실패가 받던 질문 — 실패 바로 앞의 내 메시지. 조건이 하나라도 어긋나면 null (다른 질문은 보내지 않는다). */
export function retryQuestion(thread: readonly ThreadItem[], failedId: string): string | null {
  if (retryableFailureId(thread) !== failedId) return null;
  const question = thread.at(-2);
  return question && question.sender === "candidate" ? question.content : null;
}

/** 읽지 않음에 셀 상대의 메시지 — 실패 안내는 답장이 아니다 */
export function isReply(item: ThreadItem): boolean {
  return item.sender !== "candidate" && !item.meta?.error;
}

/** 에이전트 대화가 답 없는 질문으로 끝나는가 — 중단·끊김 직후 서버의 기록이 아직 오지 않은 상태.
 *
 *  멈춘 턴의 기록은 서버가 연결이 닫힌 것을 알아챈 뒤에 남긴다. 화면이 곧바로 다시 읽으면 그 기록보다
 *  먼저 도착해, 질문만 있고 결과(중단됨·횟수 미차감)가 없는 화면이 된다. 이 경우만 조금 뒤 다시 읽는다. */
export function awaitingTurnRecord(items: readonly { role: string }[]): boolean {
  return items.at(-1)?.role === "user";
}

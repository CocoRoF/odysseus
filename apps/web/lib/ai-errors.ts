import type { AiErrorMeta } from "./types";

/** 응시자 쪽에서 끝난 턴 — 중단·연결 끊김. AI 장애가 아니다 (서버 ai_incidents.CANDIDATE_ENDED_CODES). */
const CANDIDATE_ENDED = new Set(["AI_CANCELLED", "AI_DISCONNECTED", "AI_INTERRUPTED"]);

export function isCandidateEnded(meta?: AiErrorMeta | null): boolean {
  return CANDIDATE_ENDED.has(String(meta?.error ?? ""));
}

/** 평가자 화면의 한 줄 — 응시자 쪽에서 끝난 턴을 누가 어떻게 끝냈는지로 적는다. 장애가 아니면 null. */
export function candidateEndedNote(meta: AiErrorMeta | null | undefined, hasContent: boolean): string | null {
  if (!isCandidateEnded(meta)) return null;
  const how =
    meta?.error === "AI_CANCELLED"
      ? "응시자가 요청을 중단했습니다"
      : meta?.error === "AI_DISCONNECTED"
        ? "응시자 쪽 연결이 끊겨 답변이 끝나지 않았습니다"
        : hasContent
          ? "응시자 쪽에서 답변이 끝나기 전에 멈췄습니다"
          : "응시자 쪽에서 도구 실행 중에 멈췄습니다";
  return `${how} — AI 장애가 아닙니다${meta?.refunded ? " · 질문 횟수에 포함되지 않음" : ""}`;
}

/** 실패한 응답에 붙일 한 줄.
 *
 *  환불 여부는 서버가 기록할 때 정한 `refunded` 만 본다. 화면이 코드 목록으로 따로 추측하면
 *  같은 실패를 서버와 다르게 안내하게 되고, 그 안내는 응시자의 질문 전략을 틀리게 만든다.
 *
 *  코드가 없는 실패(409·429·502 같은 HTTP 오류)는 서버가 준 설명을 그대로 쓴다 — 코드가 없다고
 *  빈 문장을 내보내면 응시자는 왜 막혔는지 알 수 없다. `partial` 은 답이 일부라도 온 경우다. */
export function aiErrorNotice(meta?: AiErrorMeta | null, opts: { partial?: boolean } = {}): string | null {
  if (!meta) return null;
  // 화면이 스스로 알아챈 끊김(서버 기록 전) — 받은 만큼은 남아 있다
  if (opts.partial && meta.error === "AI_DISCONNECTED") return "연결이 끊겨 답변이 중간에 멈췄습니다";
  const base = meta.error_message?.trim() || (meta.error ? "AI 처리 중 오류가 났습니다" : "");
  if (!base) return null;
  return meta.refunded ? `${base} — 이 질문은 남은 횟수에 포함되지 않습니다.` : base;
}

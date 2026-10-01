"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { isReply, retryQuestion } from "@/lib/failed-turns";
import type { AttemptCharacter, MessengerMessage, MessengerUsage } from "@/lib/types";

/** 메신저 세션 — 메신저 창이 닫혀도 살아 있는 대화 상태.
 *
 *  창(Window)은 닫으면 앱을 내린다. 대화 목록·읽음 상태·"답장 기다리는 중"이
 *  앱 안에 있으면 창을 닫았다 여는 순간 전부 사라져, 이미 읽은 대화가 새 메시지로
 *  보이고 진행 중이던 답장은 어디에도 표시되지 않는다. 그래서 이 상태는 데스크톱
 *  수명(시나리오 단위)을 갖는 이 프로바이더가 소유하고, 창은 그것을 보여 주기만 한다.
 *
 *  읽음 상태는 sessionStorage 에도 적어 둔다 — 새로고침 뒤에도 읽은 대화가 다시
 *  새 메시지로 튀지 않도록. 읽음의 기준은 **상대(NPC)가 보낸 메시지 수**다. 내가
 *  보낸 말은 읽지 않은 것이 될 수 없다.
 */

export interface MessengerSessionValue {
  attemptId: string;
  scenarioId: string;
  characters: AttemptCharacter[];
  readOnly: boolean;
  messages: MessengerMessage[] | null;
  error: string;
  /** 답장을 기다리는 인물 키 — 대화별이다. 한 사람이 답하는 동안 다른 사람에게 말을 걸 수 있다 */
  typingKeys: ReadonlySet<string>;
  /** 어느 대화든 답장을 기다리는 중인가 (작업 표시줄 진행 표시용) */
  pending: boolean;
  /** 남은 질문 수 — 에이전트와 같은 모양. 대화가 평가 대상이라 전략의 일부다 */
  usage: MessengerUsage | null;
  unreadOf: (key: string) => number;
  unreadTotal: number;
  reload: () => Promise<void>;
  /** 전송 성공 여부를 돌려준다 — 실패하면 호출자가 입력을 되살릴 수 있다 */
  send: (key: string, content: string) => Promise<boolean>;
  /** 답을 못 받은 질문을 그대로 다시 보낸다 — 그 실패가 스레드의 마지막일 때만 (lib/failed-turns) */
  retry: (key: string, failedId: string) => Promise<boolean>;
  /** 이 대화를 지금 보고 있다 — 상대 메시지를 전부 읽은 것으로 표시 */
  markSeen: (key: string) => void;
}

const Ctx = createContext<MessengerSessionValue | null>(null);

function seenStorageKey(attemptId: string, scenarioId: string): string {
  return `odysseus:msg-seen:${attemptId}:${scenarioId}`;
}

function loadSeen(key: string): Record<string, number> {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed)) if (typeof v === "number") out[k] = v;
    return out;
  } catch {
    return {};
  }
}

/** 읽음의 기준 — 상대가 보낸 **답장** 수. 실패 안내는 답장이 아니므로 배지를 올리지 않는다. */
function npcCount(messages: MessengerMessage[] | null, key: string): number {
  if (!messages) return 0;
  let n = 0;
  for (const m of messages) if (m.character_key === key && isReply(m)) n += 1;
  return n;
}

export function MessengerSessionProvider({
  attemptId,
  scenarioId,
  characters,
  readOnly = false,
  onReply,
  onActivity,
  children,
}: {
  attemptId: string;
  scenarioId: string;
  characters: AttemptCharacter[];
  readOnly?: boolean;
  /** 답장이 도착했을 때 — 창이 닫혀 있으면 데스크톱이 알림을 띄운다 */
  onReply?: (character: AttemptCharacter, message: MessengerMessage) => void;
  onActivity?: () => void;
  children: React.ReactNode;
}) {
  const storageKey = seenStorageKey(attemptId, scenarioId);
  const [messages, setMessages] = useState<MessengerMessage[] | null>(null);
  const [usage, setUsage] = useState<MessengerUsage | null>(null);
  const [error, setError] = useState("");
  const [typingKeys, setTypingKeys] = useState<Set<string>>(() => new Set());
  const [seen, setSeen] = useState<Record<string, number>>(() => (readOnly ? {} : loadSeen(storageKey)));
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const onReplyRef = useRef(onReply);
  onReplyRef.current = onReply;
  const onActivityRef = useRef(onActivity);
  onActivityRef.current = onActivity;

  const base = `/attempts/${attemptId}/scenarios/${scenarioId}`;

  const reload = useCallback(async () => {
    const rows = await api.get<MessengerMessage[]>(`${base}/messenger`);
    setMessages(rows);
  }, [base]);

  /** 남은 질문 수는 서버가 센다 — 장애로 돌려받은 분까지 반영된 값이라 화면이 따로 계산하지 않는다. */
  const refreshUsage = useCallback(() => {
    api
      .get<MessengerUsage>(`/attempts/${attemptId}/messenger/usage`)
      .then(setUsage)
      .catch(() => undefined);
  }, [attemptId]);

  useEffect(() => {
    if (readOnly) return;
    refreshUsage();
  }, [readOnly, refreshUsage]);

  useEffect(() => {
    reload().catch((e) => setError(e instanceof ApiError ? e.message : String(e?.message ?? e)));
  }, [reload]);

  // 읽음 상태는 세션 저장소에 미러링 — 리뷰 화면(readOnly)에서는 남기지 않는다
  useEffect(() => {
    if (readOnly) return;
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(seen));
    } catch {
      /* 저장 실패는 무시 */
    }
  }, [seen, storageKey, readOnly]);

  const markSeen = useCallback((key: string) => {
    const count = npcCount(messagesRef.current, key);
    setSeen((s) => (s[key] === count ? s : { ...s, [key]: count }));
  }, []);

  const send = useCallback(
    async (key: string, content: string) => {
      const text = content.trim();
      const character = characters.find((c) => c.key === key);
      if (!text || readOnly || !character || typingKeys.has(key)) return false;
      setError("");
      const tempId = `temp-${Date.now()}`;
      setMessages((m) => [
        ...(m ?? []),
        { id: tempId, character_key: key, sender: "candidate", content: text, created_at: new Date().toISOString() },
      ]);
      setTypingKeys((s) => new Set(s).add(key));
      onActivityRef.current?.();
      try {
        const pair = await api.post<MessengerMessage[]>(`${base}/messenger/${key}`, { content: text });
        setMessages((m) => [...(m ?? []).filter((x) => x.id !== tempId), ...pair]);
        refreshUsage();
        const reply = pair.find((x) => x.sender !== "candidate");
        // 실패는 "○○님이 답장했습니다" 가 아니다 — 알림을 띄우면 장애를 인물의 반응으로 읽는다
        if (reply && isReply(reply)) onReplyRef.current?.(character, reply);
        return true;
      } catch (e) {
        setError(e instanceof ApiError ? e.message : "전송에 실패했습니다");
        setMessages((m) => (m ?? []).filter((x) => x.id !== tempId));
        return false;
      } finally {
        setTypingKeys((s) => {
          const next = new Set(s);
          next.delete(key);
          return next;
        });
      }
    },
    [base, characters, readOnly, typingKeys, refreshUsage],
  );

  /** 실패한 답변이 받던 질문을 그대로 다시 보낸다.
   *  응시자가 질문을 다시 타이핑하게 만들면, 장애의 비용을 응시자가 또 치르는 셈이 된다.
   *  누른 실패와 다른 질문은 절대 보내지 않는다 — 조건이 어긋나면 아무것도 보내지 않는다. */
  const retry = useCallback(
    async (key: string, failedId: string) => {
      const thread = (messagesRef.current ?? []).filter((m) => m.character_key === key);
      const question = retryQuestion(thread, failedId);
      return question === null ? false : send(key, question);
    },
    [send],
  );

  const unreadOf = useCallback(
    (key: string) => Math.max(0, npcCount(messages, key) - (seen[key] ?? 0)),
    [messages, seen],
  );
  const unreadTotal = useMemo(
    () => characters.reduce((sum, c) => sum + unreadOf(c.key), 0),
    [characters, unreadOf],
  );

  const value = useMemo<MessengerSessionValue>(
    () => ({
      attemptId,
      scenarioId,
      characters,
      readOnly,
      messages,
      usage,
      error,
      typingKeys,
      pending: typingKeys.size > 0,
      unreadOf,
      unreadTotal,
      reload,
      send,
      retry,
      markSeen,
    }),
    [attemptId, scenarioId, characters, readOnly, messages, usage, error, typingKeys, unreadOf, unreadTotal, reload, send, retry, markSeen],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useMessengerSession(): MessengerSessionValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useMessengerSession must be used within MessengerSessionProvider");
  return v;
}

/** 프로바이더 밖에서는 null — 작업 표시줄처럼 있을 수도 없을 수도 있는 곳에서 쓴다. */
export function useMessengerSessionOptional(): MessengerSessionValue | null {
  return useContext(Ctx);
}

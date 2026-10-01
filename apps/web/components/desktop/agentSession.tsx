"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { api, streamAgentChat } from "@/lib/api";
import { awaitingTurnRecord } from "@/lib/failed-turns";
import type { AgentMessage, AgentStep, AgentUsage, AiErrorMeta } from "@/lib/types";
import { useWorkspace } from "./workspace";

export interface AgentChatItem {
  id: string;
  role: "user" | "assistant";
  content: string;
  steps: AgentStep[];
  streaming?: boolean;
  /** 실패했을 때의 코드·문구·상관 ID. 스트리밍 중이든 새로고침 뒤든 같은 모양이라야
   *  화면이 "환불되었는가" 를 한 가지 방법으로 판단한다. */
  error?: AiErrorMeta;
}

interface AgentSessionValue {
  items: AgentChatItem[];
  usage: AgentUsage | null;
  busy: boolean;
  /** 시나리오가 에이전트를 허용하고, 공급자도 붙어 있는가 */
  available: boolean;
  exhausted: boolean;
  send: (content: string) => Promise<void>;
  /** 진행 중인 요청을 멈춘다 — 터미널의 Ctrl+C 에 해당한다 */
  stop: () => void;
  reload: () => Promise<unknown>;
}

const Ctx = createContext<AgentSessionValue | null>(null);

/** 에이전트 대화 세션 — 데스크톱 앱과 IDE 패널이 **하나의 대화**를 공유한다.
 *
 * 위치만 둘일 뿐 세션은 하나다: 상태를 이 프로바이더가 소유하므로 어느 쪽에서
 * 보내도 양쪽에 동시에 반영되고, 진행 중 턴이 있으면 양쪽 모두 입력이 잠긴다. */
export function AgentSessionProvider({
  attemptId,
  scenarioId,
  enabled,
  children,
}: {
  attemptId: string;
  scenarioId: string;
  enabled: boolean;
  children: React.ReactNode;
}) {
  const ws = useWorkspace();
  const [items, setItems] = useState<AgentChatItem[]>([]);
  const [usage, setUsage] = useState<AgentUsage | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  const reload = useCallback(async (): Promise<AgentChatItem[]> => {
    const [msgs, u] = await Promise.all([
      api.get<AgentMessage[]>(`/attempts/${attemptId}/scenarios/${scenarioId}/agent/messages`),
      api.get<AgentUsage>(`/attempts/${attemptId}/agent/usage`),
    ]);
    const next: AgentChatItem[] = msgs.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        steps: m.meta?.steps ?? [],
        error: m.meta?.error
          ? {
              error: m.meta.error,
              error_message: m.meta.error_message,
              correlation_id: m.meta.correlation_id,
              refunded: m.meta.refunded === true,
            }
          : undefined,
      }));
    setItems(next);
    setUsage(u);
    return next;
  }, [attemptId, scenarioId]);

  useEffect(() => {
    if (!enabled) return;
    reload().catch(() => undefined);
  }, [enabled, reload]);

  const send = useCallback(
    async (content: string) => {
      const text = content.trim();
      if (!text || busyRef.current) return;
      busyRef.current = true;
      setBusy(true);

      const userItem: AgentChatItem = { id: `u-${Date.now()}`, role: "user", content: text, steps: [] };
      const botId = `a-${Date.now()}`;
      setItems((it) => [...it, userItem, { id: botId, role: "assistant", content: "", steps: [], streaming: true }]);

      const patch = (fn: (item: AgentChatItem) => AgentChatItem) =>
        setItems((it) => it.map((x) => (x.id === botId ? fn(x) : x)));

      const ac = new AbortController();
      abortRef.current = ac;
      let touchedFiles = false;
      // 실패로 끝난 턴도 도구가 돌았을 수 있다 — CLI 는 도구 이벤트를 늦게 내보내 끊기면 화면에 오지 않는다
      let failed = false;
      // 응시자 쪽에서 끝났는가(중단·끊김) — 소모 여부는 서버가 기록할 때 정하므로 그 기록을 다시 읽는다
      let endedHere = false;
      try {
        await streamAgentChat(attemptId, scenarioId, text, {
          onDelta: (chunk) => patch((x) => ({ ...x, content: x.content + chunk })),
          onTool: (name, detail) => {
            if (["write_file", "delete_file", "run_command", "copy_file", "move_file"].includes(name)) {
              touchedFiles = true;
            }
            patch((x) => ({ ...x, steps: [...x.steps, { tool: name, detail }] }));
          },
          // 코드가 없는 실패(HTTP 단계)도 서버의 설명을 그대로 담는다 — 빈 안내가 되지 않게
          onError: (message, info) => {
            failed = true;
            if (info?.code === "AI_DISCONNECTED") endedHere = true;
            patch((x) => ({
              ...x,
              error: {
                error: info?.code,
                error_message: message,
                correlation_id: info?.correlationId,
                refunded: info?.refunded === true,
              },
            }));
          },
          onDone: () => undefined,
        }, ac.signal);
      } finally {
        abortRef.current = null;
        // 어떤 실패로 끝나도 — 응답이 오기 전에 멈춘 경우도 — 입력 잠금은 풀려야 한다
        patch((x) => ({ ...x, streaming: false }));
        busyRef.current = false;
        setBusy(false);
      }
      if (ac.signal.aborted || endedHere) {
        failed = true;
        // 기록은 서버가 끊김을 알아챈 뒤에 남는다. 먼저 도착하면 잠시 뒤 다시 읽는다 (몇 번만).
        for (let i = 0; i < 5; i += 1) {
          const now = await reload().catch(() => null);
          if (now && !awaitingTurnRecord(now)) break;
          await new Promise((r) => setTimeout(r, 400));
        }
      } else {
        api
          .get<AgentUsage>(`/attempts/${attemptId}/agent/usage`)
          .then(setUsage)
          .catch(() => undefined);
      }
      // 목록이 새 버전을 알려 주면 열린 편집기가 맞춘다 — 편집하지 않은 탭은 새로 읽고, 편집 중이면 충돌로 둔다
      if (touchedFiles || failed) ws.refresh().catch(() => undefined);
    },
    [attemptId, scenarioId, ws, reload],
  );

  /** 중단 — 서버에 "의도된 중단" 을 먼저 알리고 스트림을 끊는다.
   *
   *  표시를 먼저 남겨야 평가 기록이 "응시자가 멈췄다" 로 남는다(없으면 "연결 끊김"). 소모 여부는
   *  표시와 무관하게 서버가 정한다 — 답이 한 글자라도 왔거나 도구가 돌기 시작했으면 소모된다.
   *  에이전트가 파일을 고치는 것을 보고 멈추는 것이 공짜 작업이 되면 안 된다. */
  const stop = useCallback(() => {
    if (!busyRef.current) return;
    const ac = abortRef.current;
    api
      .post(`/attempts/${attemptId}/agent/cancel`)
      .catch(() => undefined)
      .finally(() => ac?.abort());
  }, [attemptId]);

  const value = useMemo<AgentSessionValue>(
    () => ({
      items,
      usage,
      busy,
      available: enabled && Boolean(usage?.enabled) && Boolean(usage?.configured),
      exhausted: usage ? usage.remaining <= 0 : false,
      send,
      stop,
      reload,
    }),
    [items, usage, busy, enabled, send, stop, reload],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** 프로바이더 밖(리뷰 화면 등)에서는 null — 호출부가 조건부로 처리한다. */
export function useAgentSession(): AgentSessionValue | null {
  return useContext(Ctx);
}

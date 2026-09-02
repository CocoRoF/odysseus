"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { api, streamAgentChat } from "@/lib/api";
import type { AgentMessage, AgentStep, AgentUsage } from "@/lib/types";
import { useWorkspace } from "./workspace";

export interface AgentChatItem {
  id: string;
  role: "user" | "assistant";
  content: string;
  steps: AgentStep[];
  streaming?: boolean;
  error?: string;
}

interface AgentSessionValue {
  items: AgentChatItem[];
  usage: AgentUsage | null;
  busy: boolean;
  /** 시나리오가 에이전트를 허용하고, 공급자도 붙어 있는가 */
  available: boolean;
  exhausted: boolean;
  send: (content: string) => Promise<void>;
  reload: () => Promise<void>;
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

  const reload = useCallback(async () => {
    const [msgs, u] = await Promise.all([
      api.get<AgentMessage[]>(`/attempts/${attemptId}/scenarios/${scenarioId}/agent/messages`),
      api.get<AgentUsage>(`/attempts/${attemptId}/agent/usage`),
    ]);
    setItems(
      msgs.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        steps: m.meta?.steps ?? [],
        error: m.meta?.error,
      })),
    );
    setUsage(u);
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

      let touchedFiles = false;
      await streamAgentChat(attemptId, scenarioId, text, {
        onDelta: (chunk) => patch((x) => ({ ...x, content: x.content + chunk })),
        onTool: (name, detail) => {
          if (["write_file", "delete_file", "run_command", "copy_file", "move_file"].includes(name)) {
            touchedFiles = true;
          }
          patch((x) => ({ ...x, steps: [...x.steps, { tool: name, detail }] }));
        },
        onError: (message) => patch((x) => ({ ...x, error: message })),
        onDone: () => undefined,
      });

      patch((x) => ({ ...x, streaming: false }));
      busyRef.current = false;
      setBusy(false);
      api
        .get<AgentUsage>(`/attempts/${attemptId}/agent/usage`)
        .then(setUsage)
        .catch(() => undefined);
      if (touchedFiles) ws.refresh().catch(() => undefined);
    },
    [attemptId, scenarioId, ws],
  );

  const value = useMemo<AgentSessionValue>(
    () => ({
      items,
      usage,
      busy,
      available: enabled && Boolean(usage?.enabled) && Boolean(usage?.configured),
      exhausted: usage ? usage.remaining <= 0 : false,
      send,
      reload,
    }),
    [items, usage, busy, enabled, send, reload],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** 프로바이더 밖(리뷰 화면 등)에서는 null — 호출부가 조건부로 처리한다. */
export function useAgentSession(): AgentSessionValue | null {
  return useContext(Ctx);
}

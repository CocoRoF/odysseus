"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "@/lib/api";
import type { AttemptCharacter, MessengerMessage } from "@/lib/types";
import { fmtTime } from "@/lib/format";
import { Markdown } from "@/components/Markdown";
import { IconSend } from "@/components/icons";

function Avatar({ ch, size = 40 }: { ch: AttemptCharacter; size?: number }) {
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-full font-bold text-white"
      style={{ backgroundColor: ch.color, width: size, height: size, fontSize: size * 0.4 }}
    >
      {ch.name.slice(0, 1)}
    </div>
  );
}

/** 사내 메신저 — 등장인물별 스레드. 문제 파악의 유일한 통로. */
export function MessengerApp({
  attemptId,
  scenarioId,
  characters,
  readOnly = false,
  onActivity,
}: {
  attemptId: string;
  scenarioId: string;
  characters: AttemptCharacter[];
  readOnly?: boolean;
  onActivity?: () => void;
}) {
  const [messages, setMessages] = useState<MessengerMessage[] | null>(null);
  const [activeKey, setActiveKey] = useState<string>(characters[0]?.key ?? "");
  const [input, setInput] = useState("");
  const [typing, setTyping] = useState(false);
  const [error, setError] = useState("");
  const [seen, setSeen] = useState<Record<string, number>>({});
  const scrollRef = useRef<HTMLDivElement>(null);
  const base = `/attempts/${attemptId}/scenarios/${scenarioId}`;

  const load = useCallback(async () => {
    const rows = await api.get<MessengerMessage[]>(`${base}/messenger`);
    setMessages(rows);
  }, [base]);

  useEffect(() => {
    load().catch((e) => setError(String(e?.message ?? e)));
  }, [load]);

  // 스레드 진입 시 읽음 처리
  useEffect(() => {
    if (!messages) return;
    const count = messages.filter((m) => m.character_key === activeKey).length;
    setSeen((s) => ({ ...s, [activeKey]: count }));
  }, [messages, activeKey]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, typing, activeKey]);

  const active = characters.find((c) => c.key === activeKey);
  const thread = (messages ?? []).filter((m) => m.character_key === activeKey);

  const send = async () => {
    const content = input.trim();
    if (!content || typing || !active || readOnly) return;
    setInput("");
    setError("");
    // 낙관적 추가
    const tempId = `temp-${Date.now()}`;
    setMessages((m) => [
      ...(m ?? []),
      {
        id: tempId,
        character_key: activeKey,
        sender: "candidate",
        content,
        created_at: new Date().toISOString(),
      },
    ]);
    setTyping(true);
    onActivity?.();
    try {
      const pair = await api.post<MessengerMessage[]>(`${base}/messenger/${activeKey}`, { content });
      setMessages((m) => [...(m ?? []).filter((x) => x.id !== tempId), ...pair]);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "전송에 실패했습니다");
      setMessages((m) => (m ?? []).filter((x) => x.id !== tempId));
      setInput(content);
    } finally {
      setTyping(false);
    }
  };

  return (
    <div className="flex h-full min-h-0">
      {/* 대화 상대 목록 */}
      <div className="flex w-56 shrink-0 flex-col border-r border-slate-200 bg-slate-50/70">
        <div className="border-b border-slate-200 px-4 py-3">
          <p className="text-xs font-bold uppercase tracking-wide text-slate-400">대화</p>
        </div>
        <div className="thin-scroll min-h-0 flex-1 overflow-y-auto p-2">
          {characters.map((ch) => {
            const count = (messages ?? []).filter((m) => m.character_key === ch.key).length;
            const unread = Math.max(0, count - (seen[ch.key] ?? 0));
            const last = (messages ?? []).filter((m) => m.character_key === ch.key).at(-1);
            return (
              <button
                key={ch.key}
                onClick={() => setActiveKey(ch.key)}
                className={`flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition ${
                  activeKey === ch.key ? "bg-white shadow-sm" : "hover:bg-white/60"
                }`}
              >
                <Avatar ch={ch} size={36} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-1">
                    <span className="truncate text-sm font-semibold text-slate-800">{ch.name}</span>
                    {unread > 0 && activeKey !== ch.key && (
                      <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">
                        {unread}
                      </span>
                    )}
                  </div>
                  <p className="truncate text-xs text-slate-400">{last ? last.content : ch.role}</p>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* 스레드 */}
      <div className="flex min-w-0 flex-1 flex-col bg-white">
        {active ? (
          <>
            <div className="flex items-center gap-3 border-b border-slate-200 px-4 py-2.5">
              <Avatar ch={active} size={32} />
              <div className="min-w-0">
                <p className="text-sm font-bold text-slate-800">{active.name}</p>
                <p className="truncate text-xs text-slate-400">{active.role}</p>
              </div>
            </div>
            <div ref={scrollRef} className="thin-scroll min-h-0 flex-1 space-y-3 overflow-y-auto bg-slate-50/50 p-4">
              {thread.length === 0 && (
                <p className="pt-8 text-center text-xs text-slate-400">
                  아직 대화가 없습니다. 먼저 말을 걸어 보세요.
                </p>
              )}
              {thread.map((m) =>
                m.sender === "candidate" ? (
                  <div key={m.id} className="msg-in flex justify-end gap-2">
                    <span className="mt-auto shrink-0 text-[10px] text-slate-300">{fmtTime(m.created_at)}</span>
                    <div className="max-w-[75%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-sky-600 px-3.5 py-2 text-sm text-white">
                      {m.content}
                    </div>
                  </div>
                ) : (
                  <div key={m.id} className="msg-in flex items-start gap-2.5">
                    <Avatar ch={active} size={30} />
                    <div className="min-w-0">
                      <div className="max-w-full rounded-2xl rounded-tl-md border border-slate-200 bg-white px-3.5 py-2 text-sm text-slate-800 shadow-sm">
                        <Markdown>{m.content}</Markdown>
                      </div>
                      <span className="mt-0.5 block text-[10px] text-slate-300">{fmtTime(m.created_at)}</span>
                    </div>
                  </div>
                ),
              )}
              {typing && (
                <div className="flex items-start gap-2.5">
                  <Avatar ch={active} size={30} />
                  <div className="flex items-center gap-1 rounded-2xl rounded-tl-md border border-slate-200 bg-white px-3.5 py-3 shadow-sm">
                    <span className="typing-dot h-1.5 w-1.5 rounded-full bg-slate-400" />
                    <span className="typing-dot h-1.5 w-1.5 rounded-full bg-slate-400" />
                    <span className="typing-dot h-1.5 w-1.5 rounded-full bg-slate-400" />
                  </div>
                </div>
              )}
            </div>
            {error && <p className="border-t border-red-100 bg-red-50 px-4 py-1.5 text-xs text-red-600">{error}</p>}
            {!readOnly && (
              <div className="flex items-end gap-2 border-t border-slate-200 p-3">
                <textarea
                  className="thin-scroll max-h-32 min-h-[42px] flex-1 resize-none rounded-xl border border-slate-300 px-3.5 py-2.5 text-sm focus:border-sky-500 focus:outline-none"
                  placeholder={`${active.name}에게 메시지 보내기...`}
                  value={input}
                  rows={1}
                  onChange={(e) => {
                    setInput(e.target.value);
                    e.target.style.height = "auto";
                    e.target.style.height = `${Math.min(e.target.scrollHeight, 128)}px`;
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      send();
                    }
                  }}
                />
                <button
                  onClick={send}
                  disabled={!input.trim() || typing}
                  className="flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-xl bg-sky-600 text-white transition hover:bg-sky-500 disabled:bg-slate-200 disabled:text-slate-400"
                >
                  <IconSend size={16} />
                </button>
              </div>
            )}
          </>
        ) : (
          <p className="m-auto text-sm text-slate-400">등장인물이 없습니다</p>
        )}
      </div>
    </div>
  );
}

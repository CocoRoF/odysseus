"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "@/lib/api";
import type { AttemptCharacter, MessengerMessage } from "@/lib/types";
import { fmtTime } from "@/lib/format";
import { Markdown } from "@/components/Markdown";
import { IconCheck, IconCopy, IconSend } from "@/components/icons";
import { copyText, selectedText } from "@/lib/clipboard";
import { useToast } from "@/components/toast";
import { ContextMenuView, MenuEntry, useContextMenu } from "../ContextMenu";

function CopyButton({ text, tone = "light" }: { text: string; tone?: "light" | "dark" }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      title="메시지 복사"
      onClick={async (e) => {
        e.stopPropagation();
        if (await copyText(text)) {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        }
      }}
      className={`flex h-6 w-6 shrink-0 items-center justify-center self-center rounded-md opacity-0 transition group-hover:opacity-100 ${
        tone === "dark"
          ? "text-slate-300 hover:bg-white/15 hover:text-white"
          : "text-slate-400 hover:bg-slate-200/70 hover:text-slate-600"
      }`}
    >
      {done ? <IconCheck size={13} /> : <IconCopy size={13} />}
    </button>
  );
}

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
  // 답장 대기는 **대화별**이다 — 전역 플래그로 두면 다른 사람 방으로 옮겨도
  // "답장 중"이 따라다니고, 그 사이 다른 사람에게 말을 걸 수도 없다.
  const [typingKeys, setTypingKeys] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState("");
  const [seen, setSeen] = useState<Record<string, number>>({});
  const scrollRef = useRef<HTMLDivElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const activeKeyRef = useRef(activeKey);
  activeKeyRef.current = activeKey;
  const base = `/attempts/${attemptId}/scenarios/${scenarioId}`;
  const { menu, open: openMenu, close: closeMenu } = useContextMenu();
  const { toast } = useToast();

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
  }, [messages, typingKeys, activeKey]);

  const active = characters.find((c) => c.key === activeKey);
  const typing = typingKeys.has(activeKey);
  const thread = (messages ?? []).filter((m) => m.character_key === activeKey);

  const threadText = () =>
    thread
      .map((m) => `[${m.sender === "candidate" ? "나" : active?.name ?? m.character_key}] ${m.content}`)
      .join("\n\n");

  // 창을 열자마자 단축키가 먹도록 대화 영역에 포커스를 준다
  useEffect(() => {
    threadRef.current?.focus({ preventScroll: true });
  }, [activeKey]);

  const selectThread = () => {
    const el = threadRef.current;
    if (!el) return;
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    el.focus();
  };

  const messageMenu = (text: string): MenuEntry[] => {
    const sel = selectedText();
    const entries: MenuEntry[] = [];
    if (sel) entries.push({ label: "선택 영역 복사", shortcut: "Ctrl+C", onClick: () => copyText(sel) });
    entries.push({ label: "메시지 복사", onClick: () => copyText(text) });
    entries.push("separator");
    entries.push({ label: "대화 전체 복사", onClick: () => copyText(threadText()) });
    return entries;
  };

  const send = async () => {
    const content = input.trim();
    if (!content || typing || !active || readOnly) return;
    const target = activeKey; // 응답을 기다리는 동안 대화를 옮겨도 이 방으로 돌아와야 한다
    setInput("");
    setError("");
    // 낙관적 추가
    const tempId = `temp-${Date.now()}`;
    setMessages((m) => [
      ...(m ?? []),
      {
        id: tempId,
        character_key: target,
        sender: "candidate",
        content,
        created_at: new Date().toISOString(),
      },
    ]);
    setTypingKeys((s) => new Set(s).add(target));
    onActivity?.();
    try {
      const pair = await api.post<MessengerMessage[]>(`${base}/messenger/${target}`, { content });
      setMessages((m) => [...(m ?? []).filter((x) => x.id !== tempId), ...pair]);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "전송에 실패했습니다");
      setMessages((m) => (m ?? []).filter((x) => x.id !== tempId));
      if (target === activeKeyRef.current) setInput(content);
    } finally {
      setTypingKeys((s) => {
        const next = new Set(s);
        next.delete(target);
        return next;
      });
    }
  };

  return (
    <div
      className="flex h-full min-h-0"
      onKeyDown={(e) => {
        // 메신저 창 어디서든 Ctrl+A 는 **지금 보고 있는 대화만** 선택한다.
        // 페이지 전체가 잡히면 사이드바·작업 표시줄까지 복사돼 쓸 수 없다.
        // 입력창 안에서는 원래 동작(입력 내용 전체 선택)을 그대로 둔다.
        const el = e.target as HTMLElement;
        if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") return;
        if ((e.ctrlKey || e.metaKey) && (e.key === "a" || e.key === "A")) {
          e.preventDefault();
          selectThread();
          return;
        }
        if ((e.ctrlKey || e.metaKey) && (e.key === "c" || e.key === "C")) {
          const picked = selectedText();
          if (picked) {
            e.preventDefault();
            void copyText(picked).then((okCopy) =>
              toast(okCopy ? "복사했습니다" : "복사에 실패했습니다", okCopy ? "success" : "error"),
            );
          }
        }
      }}
    >
      <ContextMenuView menu={menu} onClose={closeMenu} />
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
                  {typingKeys.has(ch.key) ? (
                    <p className="truncate text-xs font-medium text-sky-600">답장을 기다리는 중…</p>
                  ) : (
                    <p className="truncate text-xs text-slate-400">{last ? last.content : ch.role}</p>
                  )}
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
            <div
              ref={(el) => {
                scrollRef.current = el;
                threadRef.current = el;
              }}
              data-thread
              tabIndex={-1}
              className="thin-scroll min-h-0 flex-1 space-y-3 overflow-y-auto bg-slate-50/50 p-4 outline-none"
              onContextMenu={(e) => {
                const sel = selectedText();
                openMenu(e, [
                  ...(sel
                    ? ([{ label: "선택 영역 복사", shortcut: "Ctrl+C", onClick: () => copyText(sel) }] as MenuEntry[])
                    : []),
                  { label: "대화 전체 선택", shortcut: "Ctrl+A", onClick: selectThread },
                  { label: "대화 전체 복사", onClick: () => copyText(threadText()) },
                ]);
              }}
            >
              {thread.length === 0 && (
                <p className="pt-8 text-center text-xs text-slate-400">
                  아직 대화가 없습니다. 먼저 말을 걸어 보세요.
                </p>
              )}
              {thread.map((m) =>
                m.sender === "candidate" ? (
                  <div
                    key={m.id}
                    className="msg-in group flex justify-end gap-1.5"
                    onContextMenu={(e) => openMenu(e, messageMenu(m.content))}
                  >
                    <CopyButton text={m.content} />
                    <span className="mt-auto shrink-0 text-[10px] text-slate-300">{fmtTime(m.created_at)}</span>
                    <div className="max-w-[75%] select-text whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-sky-600 px-3.5 py-2 text-sm text-white">
                      {m.content}
                    </div>
                  </div>
                ) : (
                  <div
                    key={m.id}
                    className="msg-in group flex items-start gap-2.5"
                    onContextMenu={(e) => openMenu(e, messageMenu(m.content))}
                  >
                    <Avatar ch={active} size={30} />
                    <div className="min-w-0">
                      <div className="max-w-full select-text rounded-2xl rounded-tl-md border border-slate-200 bg-white px-3.5 py-2 text-sm text-slate-800 shadow-sm">
                        <Markdown>{m.content}</Markdown>
                      </div>
                      <span className="mt-0.5 block text-[10px] text-slate-300">{fmtTime(m.created_at)}</span>
                    </div>
                    <CopyButton text={m.content} />
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

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, streamAgentChat } from "@/lib/api";
import type { AgentMessage, AgentStep, AgentUsage } from "@/lib/types";
import { Markdown } from "@/components/Markdown";
import { IconAgent, IconCheck, IconCopy, IconSend } from "@/components/icons";
import { copyText, selectedText } from "@/lib/clipboard";
import { useWorkspace } from "../workspace";
import { ContextMenuView, MenuEntry, useContextMenu } from "../ContextMenu";

const TOOL_LABEL: Record<string, string> = {
  list_files: "파일 목록",
  read_file: "파일 읽기",
  write_file: "파일 쓰기",
  delete_file: "파일 삭제",
  search_files: "파일 검색",
  copy_file: "파일 복사",
  move_file: "파일 이동",
  run_command: "명령 실행",
};

/** 메시지 우상단 복사 버튼 — 호버 시 나타난다 */
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
      className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md opacity-0 transition group-hover:opacity-100 ${
        tone === "dark"
          ? "text-slate-300 hover:bg-white/15 hover:text-white"
          : "text-slate-400 hover:bg-slate-200/70 hover:text-slate-600"
      }`}
    >
      {done ? <IconCheck size={13} /> : <IconCopy size={13} />}
    </button>
  );
}

interface ChatItem {
  id: string;
  role: "user" | "assistant";
  content: string;
  steps: AgentStep[];
  streaming?: boolean;
  error?: string;
}

function ToolChip({ step }: { step: AgentStep }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded-full border border-sky-200 bg-sky-50 px-2 py-0.5 text-[11px] text-sky-700">
      <span className="font-semibold">{TOOL_LABEL[step.tool] ?? step.tool}</span>
      {step.detail && <span className="truncate opacity-70">{step.detail}</span>}
    </span>
  );
}

/** 응시자 전용 AI 에이전트 — 워크스페이스를 직접 조작하는 CLI풍 어시스턴트. */
export function AgentApp({ readOnly = false, onActivity }: { readOnly?: boolean; onActivity?: () => void }) {
  const ws = useWorkspace();
  const [items, setItems] = useState<ChatItem[]>([]);
  const [usage, setUsage] = useState<AgentUsage | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const { menu, open: openMenu, close: closeMenu } = useContextMenu();

  const transcript = () =>
    items
      .map((m) => `[${m.role === "user" ? "나" : "에이전트"}] ${m.content}`)
      .join("\n\n");

  const messageMenu = (text: string): MenuEntry[] => {
    const sel = selectedText();
    const entries: MenuEntry[] = [];
    if (sel) entries.push({ label: "선택 영역 복사", shortcut: "Ctrl+C", onClick: () => copyText(sel) });
    entries.push({ label: "메시지 복사", onClick: () => copyText(text) });
    entries.push("separator");
    entries.push({ label: "대화 전체 복사", onClick: () => copyText(transcript()) });
    return entries;
  };

  const loadHistory = useCallback(async () => {
    const [msgs, u] = await Promise.all([
      api.get<AgentMessage[]>(`/attempts/${ws.attemptId}/scenarios/${ws.scenarioId}/agent/messages`),
      api.get<AgentUsage>(`/attempts/${ws.attemptId}/agent/usage`),
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
  }, [ws.attemptId, ws.scenarioId]);

  useEffect(() => {
    loadHistory().catch(() => undefined);
  }, [loadHistory]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [items, busy]);

  const send = async () => {
    const content = input.trim();
    if (!content || busy || readOnly) return;
    setInput("");
    setBusy(true);
    onActivity?.();
    const userItem: ChatItem = { id: `u-${Date.now()}`, role: "user", content, steps: [] };
    const botId = `a-${Date.now()}`;
    setItems((it) => [...it, userItem, { id: botId, role: "assistant", content: "", steps: [], streaming: true }]);

    let touchedFiles = false;
    const patch = (fn: (item: ChatItem) => ChatItem) =>
      setItems((it) => it.map((x) => (x.id === botId ? fn(x) : x)));

    await streamAgentChat(ws.attemptId, ws.scenarioId, content, {
      onDelta: (text) => patch((x) => ({ ...x, content: x.content + text })),
      onTool: (name, detail) => {
        if (["write_file", "delete_file", "run_command"].includes(name)) touchedFiles = true;
        patch((x) => ({ ...x, steps: [...x.steps, { tool: name, detail }] }));
      },
      onError: (message) => patch((x) => ({ ...x, error: message })),
      onDone: () => undefined,
    });

    patch((x) => ({ ...x, streaming: false }));
    setBusy(false);
    api.get<AgentUsage>(`/attempts/${ws.attemptId}/agent/usage`).then(setUsage).catch(() => undefined);
    if (touchedFiles) ws.refresh().catch(() => undefined);
  };

  const exhausted = usage ? usage.remaining <= 0 : false;

  return (
    <div className="flex h-full min-h-0 flex-col bg-white">
      {/* 상태 바 */}
      <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50/70 px-4 py-2">
        <span className="flex items-center gap-1.5 text-xs text-slate-500">
          <IconAgent size={13} className="text-sky-500" />
          {usage && !usage.tools_available
            ? "대화 전용 — 이 모델은 파일 조작 도구를 사용할 수 없습니다"
            : "워크스페이스 파일을 읽고·쓰고·검색하고·실행할 수 있는 어시스턴트"}
        </span>
        {usage && (
          <span
            className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${
              exhausted ? "bg-red-100 text-red-600" : "bg-slate-200/70 text-slate-600"
            }`}
          >
            남은 질문 {usage.remaining}/{usage.max}
          </span>
        )}
      </div>

      <ContextMenuView menu={menu} onClose={closeMenu} />
      <div
        ref={scrollRef}
        className="thin-scroll min-h-0 flex-1 space-y-4 overflow-y-auto p-4"
        onContextMenu={(e) => {
          const sel = selectedText();
          openMenu(e, [
            ...(sel ? ([{ label: "선택 영역 복사", onClick: () => copyText(sel) }] as MenuEntry[]) : []),
            { label: "대화 전체 복사", onClick: () => copyText(transcript()) },
          ]);
        }}
      >
        {items.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <IconAgent size={28} className="text-slate-300" />
            <p className="text-sm font-semibold text-slate-600">AI 에이전트</p>
            <p className="max-w-xs text-xs text-slate-400">
              시나리오 정보는 모르는 상태로 시작합니다. 파악한 내용을 알려주고 작업을 맡겨 보세요.
            </p>
            {usage?.tools_available && (
              <p className="max-w-xs text-[11px] text-slate-300">
                예: &ldquo;워크스페이스에 어떤 파일이 있는지 찾아줘&rdquo; · &ldquo;src/main.py 만들어줘&rdquo;
              </p>
            )}
          </div>
        )}
        {items.map((m) =>
          m.role === "user" ? (
            <div
              key={m.id}
              className="group flex items-start justify-end gap-1"
              onContextMenu={(e) => openMenu(e, messageMenu(m.content))}
            >
              <CopyButton text={m.content} />
              <div className="max-w-[85%] select-text whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-slate-800 px-3.5 py-2 text-sm text-white">
                {m.content}
              </div>
            </div>
          ) : (
            <div
              key={m.id}
              className="group space-y-1.5"
              onContextMenu={(e) => openMenu(e, messageMenu(m.content))}
            >
              {m.steps.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {m.steps.map((s, i) => (
                    <ToolChip key={i} step={s} />
                  ))}
                </div>
              )}
              {(m.content || m.streaming) && (
                <div className="flex items-start gap-1">
                  <div className="max-w-[95%] select-text rounded-2xl rounded-tl-md border border-slate-200 bg-slate-50 px-3.5 py-2 text-sm">
                    <Markdown>{m.content || ""}</Markdown>
                    {m.streaming && <span className="ml-0.5 inline-block animate-pulse text-sky-500">▍</span>}
                  </div>
                  {!m.streaming && <CopyButton text={m.content} />}
                </div>
              )}
              {m.error && (
                <p className="rounded-lg bg-red-50 px-3 py-1.5 text-xs text-red-600">오류 — {m.error}</p>
              )}
            </div>
          ),
        )}
      </div>

      {!readOnly && (
        <div className="flex items-end gap-2 border-t border-slate-200 p-3">
          <textarea
            className="thin-scroll max-h-36 min-h-[42px] flex-1 resize-none rounded-xl border border-slate-300 px-3.5 py-2.5 text-sm focus:border-sky-500 focus:outline-none"
            placeholder={exhausted ? "질문 한도를 모두 사용했습니다" : "에이전트에게 작업 요청... (Enter 전송)"}
            value={input}
            rows={1}
            disabled={busy || exhausted}
            onChange={(e) => {
              setInput(e.target.value);
              e.target.style.height = "auto";
              e.target.style.height = `${Math.min(e.target.scrollHeight, 144)}px`;
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
            disabled={!input.trim() || busy || exhausted}
            className="flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-xl bg-slate-900 text-white transition hover:bg-slate-700 disabled:bg-slate-200 disabled:text-slate-400"
          >
            <IconSend size={16} />
          </button>
        </div>
      )}
    </div>
  );
}

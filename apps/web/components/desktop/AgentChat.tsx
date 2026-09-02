"use client";

import { useEffect, useRef, useState } from "react";
import { Markdown } from "@/components/Markdown";
import { IconAgent, IconCheck, IconCopy, IconSend } from "@/components/icons";
import { copyText, selectedText } from "@/lib/clipboard";
import { ContextMenuView, MenuEntry, useContextMenu } from "./ContextMenu";
import { useAgentSession } from "./agentSession";

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

interface Skin {
  root: string;
  header: string;
  headerText: string;
  badge: string;
  badgeDanger: string;
  userBubble: string;
  botBubble: string;
  chip: string;
  input: string;
  sendBtn: string;
  copyBtn: string;
  emptyTitle: string;
  emptyText: string;
  errorBox: string;
  dark: boolean;
}

const SKINS: Record<"light" | "dark", Skin> = {
  light: {
    root: "bg-white",
    header: "border-slate-200 bg-slate-50/70",
    headerText: "text-slate-500",
    badge: "bg-slate-200/70 text-slate-600",
    badgeDanger: "bg-red-100 text-red-600",
    userBubble: "bg-slate-800 text-white",
    botBubble: "border border-slate-200 bg-slate-50",
    chip: "border-sky-200 bg-sky-50 text-sky-700",
    input: "border-slate-300 focus:border-sky-500",
    sendBtn: "bg-slate-900 text-white hover:bg-slate-700 disabled:bg-slate-200 disabled:text-slate-400",
    copyBtn: "text-slate-400 hover:bg-slate-200/70 hover:text-slate-600",
    emptyTitle: "text-slate-600",
    emptyText: "text-slate-400",
    errorBox: "bg-red-50 text-red-600",
    dark: false,
  },
  dark: {
    root: "bg-[#1e1e1e]",
    header: "border-black/40 bg-[#252526]",
    headerText: "text-[#a0a0a0]",
    badge: "bg-white/10 text-[#cccccc]",
    badgeDanger: "bg-red-500/20 text-red-300",
    userBubble: "bg-[#04395e] text-[#e7e7e7]",
    botBubble: "border border-white/10 bg-[#252526]",
    chip: "border-sky-400/30 bg-sky-400/10 text-sky-300",
    input: "border-white/15 bg-[#1e1e1e] text-[#cccccc] placeholder-[#6a6a6a] focus:border-[#0078d4]",
    sendBtn: "bg-[#0078d4] text-white hover:bg-[#0a6cbd] disabled:bg-white/10 disabled:text-[#6a6a6a]",
    copyBtn: "text-[#8a8a8a] hover:bg-white/10 hover:text-white",
    emptyTitle: "text-[#cccccc]",
    emptyText: "text-[#8a8a8a]",
    errorBox: "bg-red-500/15 text-red-300",
    dark: true,
  },
};

function CopyButton({ text, skin }: { text: string; skin: Skin }) {
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
      className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md opacity-0 transition group-hover:opacity-100 ${skin.copyBtn}`}
    >
      {done ? <IconCheck size={13} /> : <IconCopy size={13} />}
    </button>
  );
}

/** 에이전트 대화 UI — 데스크톱 창(light)과 IDE 사이드바(dark)가 공유한다.
 *  상태는 AgentSessionProvider 하나가 소유하므로 어디서 보내든 같은 대화다. */
export function AgentChat({
  theme = "light",
  showHeader = true,
}: {
  theme?: "light" | "dark";
  showHeader?: boolean;
}) {
  const session = useAgentSession();
  const skin = SKINS[theme];
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const { menu, open: openMenu, close: closeMenu } = useContextMenu();

  const items = session?.items ?? [];
  const busy = session?.busy ?? false;
  const usage = session?.usage ?? null;
  const exhausted = session?.exhausted ?? false;

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [items, busy]);

  if (!session) return null;

  const transcript = () =>
    items.map((m) => `[${m.role === "user" ? "나" : "에이전트"}] ${m.content}`).join("\n\n");

  const messageMenu = (text: string): MenuEntry[] => {
    const sel = selectedText();
    const entries: MenuEntry[] = [];
    if (sel) entries.push({ label: "선택 영역 복사", shortcut: "Ctrl+C", onClick: () => copyText(sel) });
    entries.push({ label: "메시지 복사", onClick: () => copyText(text) });
    entries.push("separator");
    entries.push({ label: "대화 전체 복사", onClick: () => copyText(transcript()) });
    return entries;
  };

  const submit = () => {
    const text = input.trim();
    if (!text || busy || exhausted) return;
    setInput("");
    session.send(text);
  };

  return (
    <div className={`flex h-full min-h-0 flex-col ${skin.root}`}>
      <ContextMenuView menu={menu} onClose={closeMenu} />

      {showHeader && (
        <div className={`flex shrink-0 items-center justify-between gap-2 border-b px-3 py-2 ${skin.header}`}>
          <span className={`flex min-w-0 items-center gap-1.5 text-xs ${skin.headerText}`}>
            <IconAgent size={13} className="shrink-0 text-sky-500" />
            <span className="truncate">
              {usage && !usage.tools_available
                ? "대화 전용 — 이 모델은 파일 조작 도구를 쓸 수 없습니다"
                : "워크스페이스 파일을 읽고·쓰고·검색하고·실행할 수 있는 어시스턴트"}
            </span>
          </span>
          {usage && (
            <span
              className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                exhausted ? skin.badgeDanger : skin.badge
              }`}
            >
              남은 질문 {usage.remaining}/{usage.max}
            </span>
          )}
        </div>
      )}

      <div
        ref={scrollRef}
        className="thin-scroll min-h-0 flex-1 space-y-4 overflow-y-auto p-3"
        onContextMenu={(e) => {
          const sel = selectedText();
          openMenu(
            e,
            [
              ...(sel ? ([{ label: "선택 영역 복사", onClick: () => copyText(sel) }] as MenuEntry[]) : []),
              { label: "대화 전체 복사", onClick: () => copyText(transcript()) },
            ],
            { dark: skin.dark },
          );
        }}
      >
        {items.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-3 text-center">
            <IconAgent size={26} className={skin.emptyText} />
            <p className={`text-sm font-semibold ${skin.emptyTitle}`}>AI 에이전트</p>
            <p className={`max-w-xs text-xs ${skin.emptyText}`}>
              시나리오 정보는 모르는 상태로 시작합니다. 파악한 내용을 알려주고 작업을 맡겨 보세요.
            </p>
            {usage?.tools_available && (
              <p className={`max-w-xs text-[11px] ${skin.emptyText} opacity-80`}>
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
              onContextMenu={(e) => openMenu(e, messageMenu(m.content), { dark: skin.dark })}
            >
              <CopyButton text={m.content} skin={skin} />
              <div
                className={`max-w-[85%] select-text whitespace-pre-wrap break-words rounded-2xl rounded-br-md px-3.5 py-2 text-sm ${skin.userBubble}`}
              >
                {m.content}
              </div>
            </div>
          ) : (
            <div
              key={m.id}
              className="group space-y-1.5"
              onContextMenu={(e) => openMenu(e, messageMenu(m.content), { dark: skin.dark })}
            >
              {m.steps.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {m.steps.map((s, i) => (
                    <span
                      key={i}
                      className={`inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] ${skin.chip}`}
                    >
                      <span className="font-semibold">{TOOL_LABEL[s.tool] ?? s.tool}</span>
                      {s.detail && <span className="truncate opacity-70">{s.detail}</span>}
                    </span>
                  ))}
                </div>
              )}
              {(m.content || m.streaming) && (
                <div className="flex items-start gap-1">
                  <div
                    className={`max-w-[95%] select-text rounded-2xl rounded-tl-md px-3.5 py-2 text-sm ${skin.botBubble}`}
                  >
                    <Markdown dark={skin.dark}>{m.content || ""}</Markdown>
                    {m.streaming && <span className="ml-0.5 inline-block animate-pulse text-sky-400">▍</span>}
                  </div>
                  {!m.streaming && <CopyButton text={m.content} skin={skin} />}
                </div>
              )}
              {m.error && (
                <p className={`rounded-lg px-3 py-1.5 text-xs ${skin.errorBox}`}>오류 — {m.error}</p>
              )}
            </div>
          ),
        )}
      </div>

      <div className={`flex items-end gap-2 border-t p-2.5 ${skin.header}`}>
        <textarea
          className={`thin-scroll max-h-32 min-h-[40px] flex-1 resize-none rounded-xl border px-3 py-2 text-sm outline-none ${skin.input}`}
          placeholder={
            exhausted ? "질문 한도를 모두 사용했습니다" : busy ? "응답을 기다리는 중..." : "에이전트에게 작업 요청... (Enter 전송)"
          }
          value={input}
          rows={1}
          disabled={busy || exhausted}
          onChange={(e) => {
            setInput(e.target.value);
            e.target.style.height = "auto";
            e.target.style.height = `${Math.min(e.target.scrollHeight, 128)}px`;
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <button
          onClick={submit}
          disabled={!input.trim() || busy || exhausted}
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl transition ${skin.sendBtn}`}
        >
          <IconSend size={15} />
        </button>
      </div>
    </div>
  );
}

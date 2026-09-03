"use client";

import { useEffect, useRef } from "react";
import { useToast } from "@/components/toast";
import { copyText, selectedText } from "@/lib/clipboard";
import { ContextMenuView, useContextMenu } from "./ContextMenu";
import { useTerminalSession } from "./terminalSession";

/** 프롬프트 — bash 의 기본 PS1 색 배치를 따른다. */
export function Ps1({ cwd }: { cwd: string }) {
  return (
    <span className="shrink-0 whitespace-pre">
      <span className="font-bold text-[#3fb950]">user@odysseus</span>
      <span className="text-[#cccccc]">:</span>
      <span className="font-bold text-[#58a6ff]">{cwd ? `~/${cwd}` : "~"}</span>
      <span className="text-[#cccccc]">$ </span>
    </span>
  );
}

/** 터미널 화면 — IDE 패널과 [터미널] 앱이 같은 세션을 이 컴포넌트로 렌더한다. */
export function TerminalView({ readOnly = false }: { readOnly?: boolean }) {
  const term = useTerminalSession();
  const { toast } = useToast();
  const { menu, open: openMenu, close: closeMenu } = useContextMenu();
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [term.lines, term.running]);

  return (
    <>
      <div
        ref={scrollRef}
        className="h-full overflow-auto bg-[#181818] px-3 py-2 font-mono text-[12.5px] leading-[1.55] text-[#cccccc]"
        onClick={() => inputRef.current?.focus()}
        onContextMenu={(e) =>
          openMenu(
            e,
            [
              {
                label: "붙여넣기",
                onClick: async () => {
                  try {
                    const text = await navigator.clipboard.readText();
                    if (text) term.setInput(term.input + text.replace(/\n/g, " "));
                    inputRef.current?.focus();
                  } catch {
                    toast("클립보드를 읽을 수 없습니다 (Ctrl+V를 사용하세요)", "info");
                  }
                },
              },
              {
                label: "선택 영역 복사",
                disabled: !selectedText(),
                onClick: () => copyText(selectedText()),
              },
              {
                label: "출력 복사",
                onClick: async () => {
                  const text = term.lines
                    .map((l) => (l.kind === "cmd" ? `$ ${l.text}` : l.text))
                    .join("\n");
                  if (await copyText(text)) toast("터미널 출력을 복사했습니다", "success");
                  else toast("복사에 실패했습니다", "error");
                },
              },
              "separator",
              { label: "터미널 지우기", shortcut: "Ctrl+L", onClick: term.clear },
            ],
            { dark: true },
          )
        }
      >
        {term.lines.map((l, i) =>
          l.kind === "cmd" ? (
            <div key={i} className="whitespace-pre-wrap break-all">
              <Ps1 cwd={l.cwd} />
              <span className="text-[#cccccc]">{l.text}</span>
            </div>
          ) : (
            <div
              key={i}
              className={`whitespace-pre-wrap break-all ${l.kind === "err" ? "text-[#f48771]" : "text-[#cccccc]"}`}
            >
              {l.text || " "}
            </div>
          ),
        )}
        {!readOnly && (
          <div className="flex items-center whitespace-pre">
            {!term.running && <Ps1 cwd={term.cwd} />}
            <input
              ref={inputRef}
              className="min-w-0 flex-1 border-0 bg-transparent p-0 font-mono text-[12.5px] text-[#cccccc] caret-[#cccccc] outline-none"
              value={term.running ? "" : term.input}
              onChange={(e) => term.setInput(e.target.value)}
              onKeyDown={term.handleKey}
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              aria-label="terminal"
            />
            {term.running && <span className="animate-pulse text-[#cccccc]">▍</span>}
          </div>
        )}
      </div>
      <ContextMenuView menu={menu} onClose={closeMenu} />
    </>
  );
}

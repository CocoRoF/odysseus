"use client";

import { IconTerminal } from "@/components/icons";
import { TerminalView } from "../TerminalView";
import { useTerminalSession } from "../terminalSession";

/** 바탕화면의 [터미널] — IDE 안의 터미널 패널과 **같은 셸**이다. */
export function TerminalApp({ readOnly = false }: { readOnly?: boolean }) {
  const term = useTerminalSession();
  return (
    <div className="flex h-full flex-col bg-[#181818]">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-black/50 bg-[#252526] px-3 text-[11px] text-[#9a9a9a]">
        <IconTerminal size={12} />
        <span className="font-semibold text-[#cccccc]">bash</span>
        <span className="text-[#6a6a6a]">— {term.cwd ? `~/${term.cwd}` : "~"}</span>
        <span className="ml-auto text-[#6a6a6a]">IDE 터미널과 같은 세션</span>
      </div>
      <div className="min-h-0 flex-1">
        <TerminalView readOnly={readOnly} />
      </div>
    </div>
  );
}

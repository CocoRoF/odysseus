"use client";

import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { copyText } from "@/lib/clipboard";
import { IconCheck, IconCopy } from "./icons";

/** 코드 블록 — 우상단 복사 버튼 (VSCode/ChatGPT 규약) */
function CodeBlock({ children, ...props }: React.HTMLAttributes<HTMLPreElement>) {
  const [copied, setCopied] = useState(false);

  const copy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const el = (e.currentTarget as HTMLElement).parentElement?.querySelector("code");
    const text = el?.textContent ?? "";
    if (await copyText(text)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  return (
    <div className="group/code relative">
      <button
        type="button"
        onClick={copy}
        title="코드 복사"
        className="absolute right-2 top-2 z-10 flex h-7 items-center gap-1 rounded-md border border-white/15 bg-slate-800/90 px-2 text-[11px] text-slate-200 opacity-0 transition hover:bg-slate-700 group-hover/code:opacity-100"
      >
        {copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
        {copied ? "복사됨" : "복사"}
      </button>
      <pre {...props}>{children}</pre>
    </div>
  );
}

export function Markdown({ children, dark = false }: { children: string; dark?: boolean }) {
  return (
    <div
      className={`prose prose-sm max-w-none ${
        dark ? "prose-invert prose-headings:text-slate-100 prose-p:text-slate-300" : ""
      }`}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ pre: CodeBlock }}>
        {children}
      </ReactMarkdown>
    </div>
  );
}

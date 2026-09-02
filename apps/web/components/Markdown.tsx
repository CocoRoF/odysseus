"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function Markdown({ children, dark = false }: { children: string; dark?: boolean }) {
  return (
    <div
      className={`prose prose-sm max-w-none ${
        dark ? "prose-invert prose-headings:text-slate-100 prose-p:text-slate-300" : ""
      }`}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  );
}

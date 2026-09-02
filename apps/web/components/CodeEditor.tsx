"use client";

import { useRef } from "react";
import Editor, { loader, DiffEditor } from "@monaco-editor/react";

// Monaco 셀프호스팅 (Dockerfile에서 public/monaco/vs로 복사)
if (typeof window !== "undefined") {
  loader.config({ paths: { vs: "/monaco/vs" } });
}

const MONACO_LANG: Record<string, string> = {
  python: "python",
  cpp: "cpp",
  java: "java",
  go: "go",
  markdown: "markdown",
};

export function CodeEditor({
  language,
  value,
  onChange,
  onPaste,
  readOnly = false,
  height = "100%",
  theme = "vs-dark",
}: {
  language: string;
  value: string;
  onChange?: (code: string) => void;
  onPaste?: (pastedText: string) => void;
  readOnly?: boolean;
  height?: string;
  theme?: "vs-dark" | "light";
}) {
  const pasteHandlerRef = useRef(onPaste);
  pasteHandlerRef.current = onPaste;

  return (
    <Editor
      height={height}
      language={MONACO_LANG[language] || language}
      value={value}
      theme={theme}
      onChange={(v) => onChange?.(v ?? "")}
      onMount={(editor) => {
        editor.onDidPaste((e) => {
          const text = editor.getModel()?.getValueInRange(e.range) ?? "";
          if (text.length > 0) pasteHandlerRef.current?.(text);
        });
      }}
      options={{
        readOnly,
        fontSize: 14,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        automaticLayout: true,
        tabSize: 4,
        padding: { top: 12 },
        contextmenu: false,
      }}
      loading={<div className="p-4 text-sm text-slate-400">에디터 로딩 중...</div>}
    />
  );
}

export function CodeDiff({
  language,
  original,
  modified,
  height = "100%",
}: {
  language: string;
  original: string;
  modified: string;
  height?: string;
}) {
  return (
    <DiffEditor
      height={height}
      language={MONACO_LANG[language] || language}
      original={original}
      modified={modified}
      theme="vs-dark"
      options={{
        readOnly: true,
        fontSize: 13,
        minimap: { enabled: false },
        renderSideBySide: true,
        automaticLayout: true,
      }}
    />
  );
}

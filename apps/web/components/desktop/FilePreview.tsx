"use client";

import { CodeEditor } from "@/components/CodeEditor";
import { Markdown } from "@/components/Markdown";
import { languageOf } from "./workspace";
import { extOf } from "./fileicons";

function csvToRows(content: string): string[][] {
  return content
    .trim()
    .split("\n")
    .slice(0, 300)
    .map((line) => line.split(","));
}

/** 읽기 전용 파일 렌더러 — 탐색기 미리보기 패널과 뷰어 앱이 공유. */
export function FilePreview({ path, content }: { path: string; content: string }) {
  const ext = extOf(path);
  if (ext === "md") {
    return (
      <div className="thin-scroll h-full overflow-y-auto p-4">
        <Markdown>{content}</Markdown>
      </div>
    );
  }
  if (ext === "csv") {
    const rows = csvToRows(content);
    return (
      <div className="thin-scroll h-full overflow-auto p-3">
        <table className="w-full border-collapse text-xs">
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className={i === 0 ? "bg-slate-100 font-semibold" : "odd:bg-slate-50/60"}>
                {r.map((c, j) => (
                  <td key={j} className="whitespace-nowrap border border-slate-200 px-2 py-1">
                    {c}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  return <CodeEditor language={languageOf(path)} value={content} readOnly theme="light" />;
}

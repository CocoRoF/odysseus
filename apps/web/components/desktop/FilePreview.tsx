"use client";

import { CodeEditor } from "@/components/CodeEditor";
import { parseCsv } from "@/lib/csv";
import { Markdown } from "@/components/Markdown";
import { languageOf } from "./workspace";
import { extOf } from "./fileicons";

function csvToRows(content: string): string[][] {
  // 쉼표를 그냥 자르면 따옴표 안의 쉼표("서울, 강남구")가 칸을 쪼갠다 — OdyCell 이 읽는 규칙과
  // 같은 파서를 쓴다. 같은 파일이 미리보기와 표에서 다르게 보이면 둘 중 하나는 거짓말이다.
  return parseCsv(content).slice(0, 300);
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

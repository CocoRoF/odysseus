"use client";

import { useEffect, useMemo, useState } from "react";
import { parseCsv, columnLabel } from "@/lib/csv";
import { isInboxPath } from "@/lib/mail";
import { fmtDateTime } from "@/lib/format";
import { Markdown } from "@/components/Markdown";
import { useWorkspace } from "@/components/desktop/workspace";
import { EmptyState, Spinner } from "@/components/ui";

/** 채점 화면의 [문서]·[OdyCell] — 응시자가 그 앱으로 만든 것을, 만든 모양 그대로 본다.
 *
 *  워크스페이스 탭에도 같은 파일이 있다. 그런데 거기서는 파일이 전부 한 트리에 섞여 있어,
 *  채점자는 어떤 것이 시나리오가 준 자료이고 어떤 것이 응시자의 산출물인지 매번 가려내야 한다.
 *  문서를 요구한 과제에서 봐야 하는 것은 폴더가 아니라 **그 사람이 쓴 글**이다.
 *
 *  그래서 확장자로 그 앱의 파일만 모으고, 각 파일에 출처를 붙인다 — 시나리오가 준 것을 그대로
 *  둔 것인지, 고친 것인지, 직접 만든 것인지. 자동 평가가 증거를 나누는 기준과 같다(autoeval).
 */

export type WorkKind = "docs" | "sheet";

const KIND: Record<WorkKind, { exts: string[]; empty: string }> = {
  docs: { exts: ["md", "markdown", "txt"], empty: "문서 앱으로 만든 파일이 없습니다." },
  sheet: { exts: ["csv", "tsv"], empty: "OdyCell 로 만든 파일이 없습니다." },
};

export function FileWorkReview({ kind, exclude }: { kind: WorkKind; exclude?: Set<string> }) {
  const ws = useWorkspace();
  const [picked, setPicked] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState("");

  const files = useMemo(() => {
    const exts = KIND[kind].exts;
    return ws.files
      .filter((f) => exts.includes(f.path.split(".").pop()?.toLowerCase() ?? ""))
      // 메일은 [메일] 탭의 것이다. 받은 편지함이 [문서] 목록의 절반을 차지하면 정작 응시자가 쓴
      // 글을 찾기 어렵고, 보낸 메일은 머리글이 있어 마크다운으로 그리면 한 줄로 뭉개진다.
      .filter((f) => !isInboxPath(f.path) && !exclude?.has(f.path))
      // 응시자가 만든 것을 먼저 — 채점자가 찾는 것이 그것이다.
      .sort((a, b) => Number(ws.isInitial(a.path)) - Number(ws.isInitial(b.path)) || a.path.localeCompare(b.path));
  }, [ws, kind, exclude]);

  useEffect(() => {
    if (!picked && files.length) setPicked(files[0].path);
  }, [files, picked]);

  // 시나리오를 바꾸면 고른 파일이 더는 없을 수 있다
  useEffect(() => {
    if (picked && files.length && !files.some((f) => f.path === picked)) setPicked(files[0].path);
  }, [files, picked]);

  useEffect(() => {
    if (!picked) return;
    setContent(null);
    setError("");
    ws.loadContent(picked)
      .then((c) => setContent(c.content))
      .catch(() => setError("파일을 불러올 수 없습니다"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picked]);

  if (ws.loading && files.length === 0) return <Spinner />;
  if (files.length === 0) return <EmptyState message={KIND[kind].empty} />;

  const meta = files.find((f) => f.path === picked);

  return (
    <div className="flex h-full min-h-0">
      <div className="thin-scroll w-72 shrink-0 overflow-y-auto border-r border-slate-200 bg-slate-50">
        {files.map((f) => (
          <button
            key={f.path}
            onClick={() => setPicked(f.path)}
            className={`block w-full border-b border-slate-200/70 px-3 py-2 text-left ${
              picked === f.path ? "bg-white" : "hover:bg-white/60"
            }`}
          >
            <span className="block truncate text-xs font-medium text-slate-800">{f.path.split("/").pop()}</span>
            <span className="mt-0.5 block truncate text-[11px] text-slate-400">{f.path}</span>
            <span className="mt-1 flex items-center gap-1.5 text-[11px]">
              <Origin initial={ws.isInitial(f.path)} />
              <span className="text-slate-400">{fmtBytes(f.size)}</span>
            </span>
          </button>
        ))}
      </div>

      <div className="thin-scroll min-w-0 flex-1 overflow-auto bg-white">
        {error ? (
          <div className="flex h-full items-center justify-center text-sm text-red-500">{error}</div>
        ) : content === null ? (
          <div className="p-6">
            <Spinner />
          </div>
        ) : (
          <div>
            <div className="sticky top-0 z-10 flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-slate-200 bg-white/95 px-4 py-2 text-[11px] text-slate-500">
              <code className="font-mono text-slate-600">{picked}</code>
              {meta && <span>{fmtDateTime(meta.updated_at)} 마지막 저장</span>}
              <span>{kind === "sheet" ? sheetShape(content) : `${countChars(content)}자`}</span>
            </div>
            {kind === "sheet" ? <SheetView text={content} /> : <DocView text={content} path={picked ?? ""} />}
          </div>
        )}
      </div>
    </div>
  );
}

function DocView({ text, path }: { text: string; path: string }) {
  // .txt 는 마크다운이 아니다 — 쓴 그대로 보여 주어야 줄바꿈이 뜻을 잃지 않는다.
  if (!/\.(md|markdown)$/i.test(path)) {
    return <pre className="whitespace-pre-wrap break-words p-5 text-sm leading-7 text-slate-700">{text}</pre>;
  }
  return (
    <div className="p-5">
      <Markdown>{text}</Markdown>
    </div>
  );
}

/** OdyCell 과 같은 격자로 — 채점자가 응시자가 본 화면을 그대로 읽는다. */
function SheetView({ text }: { text: string }) {
  const rows = useMemo(() => parseCsv(text).slice(0, 500), [text]);
  const cols = rows.reduce((m, r) => Math.max(m, r.length), 0);
  return (
    <div className="p-3">
      <table className="border-collapse text-xs">
        <thead>
          <tr>
            <th className="sticky left-0 z-10 border border-slate-200 bg-slate-100 px-2 py-1 text-slate-400" />
            {Array.from({ length: cols }, (_, c) => (
              <th key={c} className="border border-slate-200 bg-slate-100 px-2 py-1 font-medium text-slate-500">
                {columnLabel(c)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <th className="sticky left-0 z-10 border border-slate-200 bg-slate-100 px-2 py-1 text-right font-normal text-slate-400">
                {i + 1}
              </th>
              {Array.from({ length: cols }, (_, c) => (
                <td key={c} className="max-w-64 truncate border border-slate-200 px-2 py-1 text-slate-700">
                  {r[c] ?? ""}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {parseCsv(text).length > 500 && (
        <p className="mt-2 text-[11px] text-slate-400">앞 500줄만 보여 줍니다. 전체는 워크스페이스 탭에서 받으세요.</p>
      )}
    </div>
  );
}

function Origin({ initial }: { initial: boolean }) {
  return initial ? (
    <span className="rounded bg-slate-200 px-1.5 py-0.5 text-slate-600">제공된 자료</span>
  ) : (
    <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-emerald-700">응시자 작성</span>
  );
}

function sheetShape(text: string): string {
  const rows = parseCsv(text);
  const cols = rows.reduce((m, r) => Math.max(m, r.length), 0);
  return `${rows.length}행 × ${cols}열`;
}

function countChars(text: string): number {
  return text.replace(/\s+/g, " ").trim().length;
}

function fmtBytes(n: number): string {
  return n < 1024 ? `${n}B` : `${(n / 1024).toFixed(1)}KB`;
}

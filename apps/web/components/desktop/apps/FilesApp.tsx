"use client";

import { useEffect, useState } from "react";
import { ApiError } from "@/lib/api";
import { fmtBytes, fmtTime } from "@/lib/format";
import { CodeEditor } from "@/components/CodeEditor";
import { Markdown } from "@/components/Markdown";
import { useToast } from "@/components/toast";
import {
  IconDelete,
  IconFile,
  IconFolder,
  IconIde,
  IconRefresh,
} from "@/components/icons";
import { buildTree, languageOf, TreeNode, useWorkspace } from "../workspace";

function csvToRows(content: string): string[][] {
  return content
    .trim()
    .split("\n")
    .slice(0, 200)
    .map((line) => line.split(","));
}

function Preview({ path, content }: { path: string; content: string }) {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
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

function TreeView({
  nodes,
  depth,
  selected,
  collapsed,
  onToggle,
  onSelect,
}: {
  nodes: TreeNode[];
  depth: number;
  selected: string | null;
  collapsed: Set<string>;
  onToggle: (p: string) => void;
  onSelect: (p: string) => void;
}) {
  return (
    <>
      {nodes.map((n) => (
        <div key={(n.isDir ? "d:" : "f:") + n.path}>
          <button
            className={`flex w-full items-center gap-1.5 rounded-lg py-1 pr-2 text-left text-[13px] ${
              selected === n.path ? "bg-amber-100 text-amber-900" : "text-slate-700 hover:bg-slate-100"
            }`}
            style={{ paddingLeft: 8 + depth * 16 }}
            onClick={() => (n.isDir ? onToggle(n.path) : onSelect(n.path))}
          >
            {n.isDir ? (
              <IconFolder size={14} className="shrink-0 text-amber-500" />
            ) : (
              <IconFile size={14} className="shrink-0 text-slate-400" />
            )}
            <span className="min-w-0 flex-1 truncate">{n.name}</span>
            {!n.isDir && n.size !== undefined && (
              <span className="shrink-0 text-[10px] text-slate-400">{fmtBytes(n.size)}</span>
            )}
          </button>
          {n.isDir && !collapsed.has(n.path) && (
            <TreeView
              nodes={n.children}
              depth={depth + 1}
              selected={selected}
              collapsed={collapsed}
              onToggle={onToggle}
              onSelect={onSelect}
            />
          )}
        </div>
      ))}
    </>
  );
}

/** 폴더(탐색기) — 워크스페이스 열람 + 미리보기. 편집은 IDE로 넘긴다. */
export function FilesApp({ readOnly = false }: { readOnly?: boolean }) {
  const ws = useWorkspace();
  const { toast, confirm } = useToast();
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const tree = buildTree(ws.files);
  const selectedEntry = ws.files.find((f) => f.path === selected);

  useEffect(() => {
    if (!selected) return;
    setContent(null);
    ws.loadContent(selected)
      .then((fc) => setContent(fc.content))
      .catch(() => setContent("(파일을 불러올 수 없습니다)"));
    // 파일이 갱신되면 다시 로드
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, selectedEntry?.updated_at]);

  const remove = async () => {
    if (!selected) return;
    if (!(await confirm({ title: "파일을 삭제할까요?", message: selected, danger: true, confirmLabel: "삭제" })))
      return;
    try {
      await ws.deleteFile(selected);
      setSelected(null);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "삭제 실패", "error");
    }
  };

  return (
    <div className="flex h-full min-h-0 bg-white">
      {/* 트리 */}
      <div className="flex w-64 shrink-0 flex-col border-r border-slate-200 bg-slate-50/60">
        <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2">
          <span className="text-xs font-bold uppercase tracking-wide text-slate-400">워크스페이스</span>
          <button
            title="새로고침"
            onClick={() => ws.refresh()}
            className="flex h-6 w-6 items-center justify-center rounded text-slate-400 hover:bg-slate-200 hover:text-slate-600"
          >
            <IconRefresh size={12} />
          </button>
        </div>
        <div className="thin-scroll min-h-0 flex-1 overflow-y-auto p-1.5">
          <TreeView
            nodes={tree}
            depth={0}
            selected={selected}
            collapsed={collapsed}
            onToggle={(p) =>
              setCollapsed((s) => {
                const n = new Set(s);
                if (n.has(p)) n.delete(p);
                else n.add(p);
                return n;
              })
            }
            onSelect={setSelected}
          />
          {ws.files.length === 0 && !ws.loading && (
            <p className="px-2 pt-4 text-xs text-slate-400">파일이 없습니다</p>
          )}
        </div>
        <div className="border-t border-slate-200 px-3 py-1.5 text-[11px] text-slate-400">
          파일 {ws.files.length}개
        </div>
      </div>

      {/* 미리보기 */}
      <div className="flex min-w-0 flex-1 flex-col">
        {selected ? (
          <>
            <div className="flex items-center justify-between gap-2 border-b border-slate-200 px-3 py-1.5">
              <span className="min-w-0 truncate font-mono text-xs text-slate-600">{selected}</span>
              <div className="flex shrink-0 items-center gap-1">
                {selectedEntry && (
                  <span className="mr-1 text-[11px] text-slate-400">
                    {fmtBytes(selectedEntry.size)} · {fmtTime(selectedEntry.updated_at)}
                  </span>
                )}
                <button
                  title="IDE에서 열기"
                  onClick={() => ws.requestOpenInIde(selected)}
                  className="flex h-7 items-center gap-1 rounded-lg border border-slate-200 px-2 text-xs text-slate-600 hover:bg-slate-50"
                >
                  <IconIde size={12} /> IDE에서 열기
                </button>
                {!readOnly && (
                  <button
                    title="삭제"
                    onClick={remove}
                    className="flex h-7 w-7 items-center justify-center rounded-lg text-slate-400 hover:bg-red-50 hover:text-red-500"
                  >
                    <IconDelete size={13} />
                  </button>
                )}
              </div>
            </div>
            <div className="min-h-0 flex-1">
              {content === null ? (
                <p className="p-4 text-xs text-slate-400">불러오는 중...</p>
              ) : (
                <Preview path={selected} content={content} />
              )}
            </div>
          </>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-slate-300">
            <IconFolder size={36} />
            <p className="text-sm">파일을 선택하면 미리보기가 표시됩니다</p>
          </div>
        )}
      </div>
    </div>
  );
}

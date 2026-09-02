"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "@/lib/api";
import type { Execution } from "@/lib/types";
import { CodeEditor } from "@/components/CodeEditor";
import { Divider } from "@/components/Divider";
import { useToast } from "@/components/toast";
import {
  IconAdd,
  IconClose,
  IconDelete,
  IconFile,
  IconFolder,
  IconRefresh,
  IconRun,
  IconTerminal,
} from "@/components/icons";
import { buildTree, languageOf, TreeNode, useWorkspace } from "../workspace";

interface Tab {
  path: string;
  content: string;
  dirty: boolean;
}

function TreeView({
  nodes,
  depth,
  activePath,
  collapsed,
  onToggle,
  onOpen,
  onDelete,
  readOnly,
}: {
  nodes: TreeNode[];
  depth: number;
  activePath: string | null;
  collapsed: Set<string>;
  onToggle: (path: string) => void;
  onOpen: (path: string) => void;
  onDelete: (path: string) => void;
  readOnly: boolean;
}) {
  return (
    <>
      {nodes.map((n) => (
        <div key={(n.isDir ? "d:" : "f:") + n.path}>
          <div
            className={`group flex cursor-pointer items-center gap-1.5 rounded-md py-[3px] pr-1 text-[13px] ${
              activePath === n.path ? "bg-sky-100 text-sky-800" : "text-slate-600 hover:bg-slate-100"
            }`}
            style={{ paddingLeft: 8 + depth * 14 }}
            onClick={() => (n.isDir ? onToggle(n.path) : onOpen(n.path))}
          >
            {n.isDir ? (
              <IconFolder size={13} className="shrink-0 text-amber-500" />
            ) : (
              <IconFile size={13} className="shrink-0 text-slate-400" />
            )}
            <span className="min-w-0 flex-1 truncate">{n.name}</span>
            {!n.isDir && !readOnly && (
              <button
                title="삭제"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(n.path);
                }}
                className="hidden h-5 w-5 shrink-0 items-center justify-center rounded text-slate-300 hover:text-red-500 group-hover:flex"
              >
                <IconDelete size={11} />
              </button>
            )}
          </div>
          {n.isDir && !collapsed.has(n.path) && (
            <TreeView
              nodes={n.children}
              depth={depth + 1}
              activePath={activePath}
              collapsed={collapsed}
              onToggle={onToggle}
              onOpen={onOpen}
              onDelete={onDelete}
              readOnly={readOnly}
            />
          )}
        </div>
      ))}
    </>
  );
}

interface TermEntry {
  id: string;
  command: string;
  status: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  changed: string[];
}

/** VSCode풍 IDE — 파일 트리 + Monaco 탭 + 터미널(실행). */
export function IdeApp({ readOnly = false, onActivity }: { readOnly?: boolean; onActivity?: () => void }) {
  const ws = useWorkspace();
  const { toast, confirm } = useToast();
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [sidebarW, setSidebarW] = useState(200);
  const [termH, setTermH] = useState(180);
  const [termOpen, setTermOpen] = useState(true);
  const [command, setCommand] = useState("");
  const [running, setRunning] = useState(false);
  const [termLog, setTermLog] = useState<TermEntry[]>([]);
  const rootRef = useRef<HTMLDivElement>(null);
  const termScrollRef = useRef<HTMLDivElement>(null);

  const tree = buildTree(ws.files);
  const active = tabs.find((t) => t.path === activePath) ?? null;

  const openFile = useCallback(
    async (path: string) => {
      const existing = tabs.find((t) => t.path === path);
      if (existing) {
        setActivePath(path);
        return;
      }
      try {
        const fc = await ws.loadContent(path);
        setTabs((t) => [...t, { path, content: fc.content, dirty: false }]);
        setActivePath(path);
      } catch (e) {
        toast(e instanceof ApiError ? e.message : "파일을 열 수 없습니다", "error");
      }
    },
    [tabs, ws, toast],
  );

  // 폴더 앱에서 넘어온 열기 요청 소비
  useEffect(() => {
    if (ws.pendingIdeOpen) {
      const p = ws.pendingIdeOpen;
      ws.consumeIdeOpen();
      openFile(p);
    }
  }, [ws.pendingIdeOpen, ws, openFile]);

  const closeTab = (path: string) => {
    setTabs((t) => t.filter((x) => x.path !== path));
    if (activePath === path) {
      const rest = tabs.filter((x) => x.path !== path);
      setActivePath(rest.at(-1)?.path ?? null);
    }
  };

  const save = useCallback(
    async (tab: Tab | null) => {
      if (!tab || readOnly) return;
      try {
        await ws.saveContent(tab.path, tab.content);
        setTabs((t) => t.map((x) => (x.path === tab.path ? { ...x, dirty: false } : x)));
        onActivity?.();
      } catch (e) {
        toast(e instanceof ApiError ? e.message : "저장에 실패했습니다", "error");
      }
    },
    [ws, toast, readOnly, onActivity],
  );

  // Ctrl/Cmd+S 저장
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        if (rootRef.current?.contains(document.activeElement) || tabs.some((t) => t.dirty)) {
          e.preventDefault();
          save(tabs.find((t) => t.path === activePath) ?? null);
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [tabs, activePath, save]);

  const newFile = async () => {
    const path = window.prompt("새 파일 경로 (예: src/solution.py)");
    if (!path?.trim()) return;
    try {
      await ws.saveContent(path.trim(), "");
      await openFile(path.trim().replace(/^\/+/, ""));
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "생성에 실패했습니다", "error");
    }
  };

  const removeFile = async (path: string) => {
    if (!(await confirm({ title: "파일을 삭제할까요?", message: path, danger: true, confirmLabel: "삭제" }))) return;
    try {
      await ws.deleteFile(path);
      closeTab(path);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "삭제에 실패했습니다", "error");
    }
  };

  useEffect(() => {
    termScrollRef.current?.scrollTo({ top: termScrollRef.current.scrollHeight });
  }, [termLog, running]);

  const run = async () => {
    const cmd = command.trim();
    if (!cmd || running || readOnly) return;
    // 열린 더티 탭은 실행 전 저장 (실행은 서버 파일 기준)
    for (const t of tabs.filter((x) => x.dirty)) await save(t);
    setRunning(true);
    setTermOpen(true);
    setCommand("");
    onActivity?.();
    const entryId = `run-${Date.now()}`;
    setTermLog((l) => [
      ...l,
      { id: entryId, command: cmd, status: "running", exitCode: null, stdout: "", stderr: "", changed: [] },
    ]);
    try {
      const exec = await api.post<Execution>(
        `/attempts/${ws.attemptId}/scenarios/${ws.scenarioId}/run`,
        { command: cmd },
      );
      // 완료 폴링
      let done: Execution = exec;
      for (let i = 0; i < 90; i++) {
        await new Promise((r) => setTimeout(r, 700));
        done = await api.get<Execution>(`/executions/${exec.id}`);
        if (done.status === "done" || done.status === "error") break;
      }
      setTermLog((l) =>
        l.map((e) =>
          e.id === entryId
            ? {
                ...e,
                status: done.status,
                exitCode: done.exit_code,
                stdout: done.stdout ?? "",
                stderr: done.stderr ?? "",
                changed: (done.changed_files ?? []).map((c) => c.path),
              }
            : e,
        ),
      );
      if ((done.changed_files ?? []).length > 0) {
        await ws.refresh();
        // 열린 탭 중 실행으로 변경된 파일은 다시 로드 (더티 탭은 보존)
        for (const ch of done.changed_files ?? []) {
          const tab = tabs.find((t) => t.path === ch.path);
          if (tab && !tab.dirty) {
            const fc = await ws.loadContent(ch.path).catch(() => null);
            if (fc) {
              setTabs((t) => t.map((x) => (x.path === ch.path ? { ...x, content: fc.content } : x)));
            }
          }
        }
      }
    } catch (e) {
      setTermLog((l) =>
        l.map((x) =>
          x.id === entryId
            ? { ...x, status: "error", stderr: e instanceof ApiError ? e.message : "실행 요청 실패" }
            : x,
        ),
      );
    } finally {
      setRunning(false);
    }
  };

  return (
    <div ref={rootRef} className="flex h-full min-h-0 flex-col bg-[#1e1e1e]">
      <div className="flex min-h-0 flex-1">
        {/* 사이드바: 파일 트리 */}
        <div className="flex shrink-0 flex-col border-r border-black/40 bg-[#252526]" style={{ width: sidebarW }}>
          <div className="flex items-center justify-between px-3 py-2">
            <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">탐색기</span>
            <div className="flex items-center gap-0.5">
              {!readOnly && (
                <button title="새 파일" onClick={newFile} className="flex h-6 w-6 items-center justify-center rounded text-slate-400 hover:bg-white/10 hover:text-white">
                  <IconAdd size={13} />
                </button>
              )}
              <button title="새로고침" onClick={() => ws.refresh()} className="flex h-6 w-6 items-center justify-center rounded text-slate-400 hover:bg-white/10 hover:text-white">
                <IconRefresh size={12} />
              </button>
            </div>
          </div>
          <div className="thin-scroll min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
            <div className="[&_*]:!text-slate-300 [&_.bg-sky-100]:!bg-sky-500/20">
              <TreeView
                nodes={tree}
                depth={0}
                activePath={activePath}
                collapsed={collapsed}
                onToggle={(p) =>
                  setCollapsed((s) => {
                    const n = new Set(s);
                    if (n.has(p)) n.delete(p);
                    else n.add(p);
                    return n;
                  })
                }
                onOpen={openFile}
                onDelete={removeFile}
                readOnly={readOnly}
              />
            </div>
            {ws.files.length === 0 && !ws.loading && (
              <p className="px-2 pt-4 text-xs text-slate-500">워크스페이스가 비어 있습니다</p>
            )}
          </div>
        </div>
        <Divider orientation="vertical" onMove={(x) => {
          const left = rootRef.current?.getBoundingClientRect().left ?? 0;
          setSidebarW(Math.max(140, Math.min(x - left, 420)));
        }} />

        {/* 에디터 영역 */}
        <div className="flex min-w-0 flex-1 flex-col">
          {/* 탭 바 */}
          <div className="thin-scroll flex h-9 shrink-0 items-center overflow-x-auto bg-[#2d2d2d]">
            {tabs.map((t) => (
              <button
                key={t.path}
                onClick={() => setActivePath(t.path)}
                className={`group flex h-full shrink-0 items-center gap-1.5 border-r border-black/30 px-3 text-xs ${
                  activePath === t.path ? "bg-[#1e1e1e] text-white" : "bg-transparent text-slate-400 hover:text-slate-200"
                }`}
              >
                <span className="max-w-[160px] truncate">{t.path.split("/").pop()}</span>
                {t.dirty && <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />}
                <span
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(t.path);
                  }}
                  className="flex h-4 w-4 items-center justify-center rounded text-slate-500 hover:bg-white/20 hover:text-white"
                >
                  <IconClose size={11} />
                </span>
              </button>
            ))}
            {tabs.length === 0 && <span className="px-3 text-xs text-slate-500">파일을 열어 시작하세요</span>}
          </div>
          {/* 에디터 */}
          <div className="min-h-0 flex-1">
            {active ? (
              <CodeEditor
                language={languageOf(active.path)}
                value={active.content}
                readOnly={readOnly}
                onChange={(code) =>
                  setTabs((t) => t.map((x) => (x.path === active.path ? { ...x, content: code, dirty: true } : x)))
                }
              />
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-slate-600">
                왼쪽 탐색기에서 파일을 선택하세요
              </div>
            )}
          </div>

          {/* 터미널 */}
          {termOpen && (
            <>
              <Divider orientation="horizontal" onMove={(_x, y) => {
                const rect = rootRef.current?.getBoundingClientRect();
                if (rect) setTermH(Math.max(90, Math.min(rect.bottom - y, rect.height - 140)));
              }} />
              <div className="flex shrink-0 flex-col bg-[#181818]" style={{ height: termH }}>
                <div className="flex items-center justify-between border-b border-black/40 px-3 py-1">
                  <span className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-400">
                    <IconTerminal size={11} /> 터미널
                  </span>
                  <button onClick={() => setTermOpen(false)} className="text-slate-500 hover:text-white">
                    <IconClose size={13} />
                  </button>
                </div>
                <div ref={termScrollRef} className="thin-scroll min-h-0 flex-1 overflow-y-auto p-2 font-mono text-xs">
                  {termLog.length === 0 && (
                    <p className="text-slate-600">python3 파일명 형태로 명령을 실행할 수 있습니다 (예: python3 report.py)</p>
                  )}
                  {termLog.map((e) => (
                    <div key={e.id} className="mb-2">
                      <p className="text-emerald-400">
                        $ {e.command}
                        {e.status === "running" && <span className="ml-2 animate-pulse text-slate-500">실행 중...</span>}
                      </p>
                      {e.stdout && <pre className="whitespace-pre-wrap text-slate-300">{e.stdout}</pre>}
                      {e.stderr && <pre className="whitespace-pre-wrap text-red-400">{e.stderr}</pre>}
                      {e.status !== "running" && (
                        <p className="text-slate-500">
                          exit {e.exitCode ?? "?"}
                          {e.changed.length > 0 && ` · 파일 변경: ${e.changed.join(", ")}`}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
                {!readOnly && (
                  <div className="flex items-center gap-2 border-t border-black/40 px-2 py-1.5">
                    <span className="font-mono text-xs text-emerald-400">$</span>
                    <input
                      className="flex-1 bg-transparent font-mono text-xs text-slate-200 placeholder-slate-600 focus:outline-none"
                      placeholder="명령 입력 후 Enter (예: python3 report.py)"
                      value={command}
                      onChange={(e) => setCommand(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.nativeEvent.isComposing) run();
                      }}
                      disabled={running}
                    />
                    <button
                      onClick={run}
                      disabled={running || !command.trim()}
                      className="flex h-6 w-6 items-center justify-center rounded text-emerald-400 hover:bg-white/10 disabled:text-slate-600"
                    >
                      <IconRun size={13} />
                    </button>
                  </div>
                )}
              </div>
            </>
          )}
          {!termOpen && (
            <button
              onClick={() => setTermOpen(true)}
              className="flex h-7 shrink-0 items-center gap-1.5 border-t border-black/40 bg-[#181818] px-3 text-[11px] font-bold uppercase tracking-wider text-slate-500 hover:text-slate-300"
            >
              <IconTerminal size={11} /> 터미널 열기
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "@/lib/api";
import type { Execution } from "@/lib/types";
import { CodeEditor } from "@/components/CodeEditor";
import { Divider } from "@/components/Divider";
import { useToast } from "@/components/toast";
import {
  IconAdd,
  IconChevronRight,
  IconClose,
  IconDelete,
  IconRefresh,
  IconTerminal,
} from "@/components/icons";
import { FiCopy, FiSettings } from "react-icons/fi";
import { buildTree, languageOf, TreeNode, useWorkspace } from "../workspace";
import { FileGlyph, FolderGlyph } from "../fileicons";

interface Tab {
  path: string;
  content: string;
  dirty: boolean;
}

// ── 탐색기 트리 (VSCode 스타일: 셰브론 + 파일 글리프) ─────────

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
      {nodes.map((n) => {
        const open = n.isDir && !collapsed.has(n.path);
        return (
          <div key={(n.isDir ? "d:" : "f:") + n.path}>
            <div
              className={`group flex h-[22px] cursor-pointer items-center gap-1 pr-1 text-[13px] ${
                activePath === n.path
                  ? "bg-[#37373d] text-white"
                  : "text-[#cccccc] hover:bg-[#2a2d2e]"
              }`}
              style={{ paddingLeft: 6 + depth * 12 }}
              onClick={() => (n.isDir ? onToggle(n.path) : onOpen(n.path))}
            >
              <span className={`flex w-4 shrink-0 justify-center text-[#8a8a8a] transition-transform ${n.isDir ? (open ? "rotate-90" : "") : "opacity-0"}`}>
                <IconChevronRight size={12} />
              </span>
              {n.isDir ? (
                <FolderGlyph size={14} open={open} />
              ) : (
                <FileGlyph path={n.path} size={12} dark />
              )}
              <span className="min-w-0 flex-1 truncate">{n.name}</span>
              {!n.isDir && !readOnly && (
                <button
                  title="삭제"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(n.path);
                  }}
                  className="hidden h-4 w-4 shrink-0 items-center justify-center rounded-sm text-[#8a8a8a] hover:bg-white/10 hover:text-red-400 group-hover:flex"
                >
                  <IconDelete size={10} />
                </button>
              )}
            </div>
            {open && (
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
        );
      })}
    </>
  );
}

// ── 터미널 ───────────────────────────────────────────────────

type TermLine =
  | { kind: "cmd"; cwd: string; text: string }
  | { kind: "out"; text: string }
  | { kind: "err"; text: string };

const VHOME = "/home/user";

function Ps1({ cwd }: { cwd: string }) {
  return (
    <span className="shrink-0 whitespace-pre">
      <span className="font-bold text-[#3fb950]">user@odysseus</span>
      <span className="text-[#cccccc]">:</span>
      <span className="font-bold text-[#58a6ff]">{cwd ? `~/${cwd}` : "~"}</span>
      <span className="text-[#cccccc]">$ </span>
    </span>
  );
}

/** cd 인자 해석 — 실제 bash와 같은 오류 문구를 낸다. */
function resolveCd(
  cwd: string,
  rawArg: string,
  dirs: Set<string>,
  filePaths: Set<string>,
): { cwd?: string; error?: string } {
  const arg = rawArg.trim();
  if (!arg || arg === "~" || arg === "$HOME") return { cwd: "" };
  let base: string[];
  let rest = arg;
  if (arg.startsWith("~/")) {
    base = [];
    rest = arg.slice(2);
  } else if (arg.startsWith("/")) {
    return { error: `bash: cd: ${arg}: No such file or directory` };
  } else {
    base = cwd ? cwd.split("/") : [];
  }
  for (const seg of rest.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (base.length === 0) return { error: `bash: cd: ${arg}: No such file or directory` };
      base.pop();
      continue;
    }
    base.push(seg);
  }
  const target = base.join("/");
  if (!target) return { cwd: "" };
  if (dirs.has(target)) return { cwd: target };
  if (filePaths.has(target)) return { error: `bash: cd: ${arg}: Not a directory` };
  return { error: `bash: cd: ${arg}: No such file or directory` };
}

function shellQuote(path: string): string {
  return `'${path.replace(/'/g, `'\\''`)}'`;
}

// ── IDE 본체 ─────────────────────────────────────────────────

/** VSCode풍 IDE — 액티비티 바 + 탐색기 + 탭/브레드크럼 + Monaco + 터미널 + 상태 바. */
export function IdeApp({ readOnly = false, onActivity }: { readOnly?: boolean; onActivity?: () => void }) {
  const ws = useWorkspace();
  const { toast, confirm } = useToast();
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarW, setSidebarW] = useState(200);
  const [termOpen, setTermOpen] = useState(true);
  const [termH, setTermH] = useState(190);
  const [cursor, setCursor] = useState({ ln: 1, col: 1 });

  // 터미널 상태
  const [lines, setLines] = useState<TermLine[]>([]);
  const [input, setInput] = useState("");
  const [cwd, setCwd] = useState("");
  const [running, setRunning] = useState(false);
  const historyRef = useRef<string[]>([]);
  const histPosRef = useRef(-1);
  const cancelRef = useRef<string | null>(null); // 취소된 실행 id
  const runIdRef = useRef<string | null>(null);

  const rootRef = useRef<HTMLDivElement>(null);
  const termScrollRef = useRef<HTMLDivElement>(null);
  const termInputRef = useRef<HTMLInputElement>(null);

  const tree = buildTree(ws.files);
  const active = tabs.find((t) => t.path === activePath) ?? null;
  const dirSet = useMemo(() => {
    const set = new Set<string>();
    for (const f of ws.files) {
      const parts = f.path.split("/");
      for (let i = 1; i < parts.length; i++) set.add(parts.slice(0, i).join("/"));
    }
    return set;
  }, [ws.files]);
  const fileSet = useMemo(() => new Set(ws.files.map((f) => f.path)), [ws.files]);

  // ── 파일 열기/저장 ──
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

  // ── 터미널 ──
  useEffect(() => {
    termScrollRef.current?.scrollTo({ top: termScrollRef.current.scrollHeight });
  }, [lines, running, termOpen]);

  const print = useCallback((entries: TermLine[]) => {
    setLines((l) => [...l, ...entries]);
  }, []);

  const runServerCommand = useCallback(
    async (command: string, atCwd: string) => {
      // 실행은 서버 파일 기준 — 더티 탭은 먼저 저장
      for (const t of tabs.filter((x) => x.dirty)) await save(t);
      setRunning(true);
      onActivity?.();
      const wrapped = atCwd ? `cd ${shellQuote(atCwd)} && (${command})` : command;
      try {
        const exec = await api.post<Execution>(
          `/attempts/${ws.attemptId}/scenarios/${ws.scenarioId}/run`,
          { command: wrapped },
        );
        runIdRef.current = exec.id;
        let done: Execution = exec;
        for (let i = 0; i < 90; i++) {
          await new Promise((r) => setTimeout(r, 650));
          if (cancelRef.current === exec.id) return; // ^C — 결과 무시
          done = await api.get<Execution>(`/executions/${exec.id}`);
          if (done.status === "done" || done.status === "error") break;
        }
        if (cancelRef.current === exec.id) return;
        const out: TermLine[] = [];
        if (done.stdout) out.push(...done.stdout.replace(/\n$/, "").split("\n").map((t) => ({ kind: "out" as const, text: t })));
        if (done.stderr) out.push(...done.stderr.replace(/\n$/, "").split("\n").map((t) => ({ kind: "err" as const, text: t })));
        if (done.status !== "done" && done.status !== "error") out.push({ kind: "err", text: "bash: 실행이 완료되지 않았습니다" });
        print(out);
        if ((done.changed_files ?? []).length > 0) {
          await ws.refresh();
          for (const ch of done.changed_files ?? []) {
            const tab = tabs.find((t) => t.path === ch.path);
            if (tab && !tab.dirty) {
              const fc = await ws.loadContent(ch.path).catch(() => null);
              if (fc) setTabs((t) => t.map((x) => (x.path === ch.path ? { ...x, content: fc.content } : x)));
            }
          }
        }
      } catch (e) {
        print([{ kind: "err", text: e instanceof ApiError ? `bash: ${e.message}` : "bash: 실행 요청 실패" }]);
      } finally {
        runIdRef.current = null;
        setRunning(false);
      }
    },
    [tabs, save, ws, print, onActivity],
  );

  const submitCommand = useCallback(
    async (raw: string) => {
      const command = raw.trim();
      print([{ kind: "cmd", cwd, text: raw }]);
      if (command) {
        historyRef.current = [...historyRef.current.filter((c) => c !== command), command].slice(-100);
      }
      histPosRef.current = -1;
      if (!command) return;

      if (command === "clear" || command === "reset") {
        setLines([]);
        return;
      }
      if (command === "pwd") {
        print([{ kind: "out", text: cwd ? `${VHOME}/${cwd}` : VHOME }]);
        return;
      }
      if (command === "cd" || command.startsWith("cd ")) {
        const r = resolveCd(cwd, command === "cd" ? "" : command.slice(3), dirSet, fileSet);
        if (r.error) print([{ kind: "err", text: r.error }]);
        else setCwd(r.cwd ?? "");
        return;
      }
      await runServerCommand(command, cwd);
    },
    [cwd, dirSet, fileSet, print, runServerCommand],
  );

  const onTermKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.ctrlKey && (e.key === "c" || e.key === "C")) {
      e.preventDefault();
      if (running && runIdRef.current) {
        cancelRef.current = runIdRef.current;
        runIdRef.current = null;
        setRunning(false);
        print([{ kind: "out", text: "^C" }]);
      } else {
        print([{ kind: "cmd", cwd, text: `${input}^C` }]);
        setInput("");
        histPosRef.current = -1;
      }
      return;
    }
    if (e.ctrlKey && (e.key === "l" || e.key === "L")) {
      e.preventDefault();
      setLines([]);
      return;
    }
    if (running) return;
    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      const v = input;
      setInput("");
      submitCommand(v);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      const h = historyRef.current;
      if (h.length === 0) return;
      const pos = histPosRef.current === -1 ? h.length - 1 : Math.max(0, histPosRef.current - 1);
      histPosRef.current = pos;
      setInput(h[pos]);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      const h = historyRef.current;
      if (histPosRef.current === -1) return;
      const pos = histPosRef.current + 1;
      if (pos >= h.length) {
        histPosRef.current = -1;
        setInput("");
      } else {
        histPosRef.current = pos;
        setInput(h[pos]);
      }
    }
  };

  const crumbs = active ? active.path.split("/") : [];
  const langName = active ? languageOf(active.path) : "";

  const activityBtn = (activeState: boolean) =>
    `relative flex h-11 w-full items-center justify-center transition-colors ${
      activeState ? "text-white" : "text-[#7a7a7a] hover:text-white"
    }`;

  return (
    <div ref={rootRef} className="flex h-full min-h-0 flex-col bg-[#1e1e1e]">
      <div className="flex min-h-0 flex-1">
        {/* 액티비티 바 */}
        <div className="flex w-11 shrink-0 flex-col items-center border-r border-black/40 bg-[#333333] py-1">
          <button title="탐색기" className={activityBtn(sidebarOpen)} onClick={() => setSidebarOpen((v) => !v)}>
            {sidebarOpen && <span className="absolute left-0 top-1.5 h-8 w-[2px] bg-white" />}
            <FiCopy size={20} />
          </button>
          <button title="터미널" className={activityBtn(termOpen)} onClick={() => setTermOpen((v) => !v)}>
            {termOpen && <span className="absolute left-0 top-1.5 h-8 w-[2px] bg-white" />}
            <IconTerminal size={20} />
          </button>
          <div className="mt-auto">
            <span className="flex h-11 w-11 items-center justify-center text-[#5a5a5a]">
              <FiSettings size={19} />
            </span>
          </div>
        </div>

        {/* 사이드바: 탐색기 */}
        {sidebarOpen && (
          <>
            <div className="flex shrink-0 flex-col bg-[#252526]" style={{ width: sidebarW }}>
              <div className="flex h-8 items-center justify-between pl-4 pr-2">
                <span className="text-[11px] uppercase tracking-wide text-[#bbbbbb]">탐색기</span>
              </div>
              <div className="group/head flex h-[22px] items-center gap-1 bg-[#2d2d30] pl-1 pr-1.5">
                <span className="flex w-4 justify-center text-[#8a8a8a]">
                  <IconChevronRight size={12} className="rotate-90" />
                </span>
                <span className="flex-1 truncate text-[11px] font-bold uppercase tracking-wide text-[#cccccc]">
                  워크스페이스
                </span>
                {!readOnly && (
                  <button title="새 파일" onClick={newFile} className="flex h-5 w-5 items-center justify-center rounded-sm text-[#aaaaaa] hover:bg-white/10 hover:text-white">
                    <IconAdd size={12} />
                  </button>
                )}
                <button title="새로고침" onClick={() => ws.refresh()} className="flex h-5 w-5 items-center justify-center rounded-sm text-[#aaaaaa] hover:bg-white/10 hover:text-white">
                  <IconRefresh size={11} />
                </button>
              </div>
              <div className="thin-scroll min-h-0 flex-1 overflow-y-auto py-0.5">
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
                {ws.files.length === 0 && !ws.loading && (
                  <p className="px-4 pt-3 text-xs text-[#8a8a8a]">워크스페이스가 비어 있습니다</p>
                )}
              </div>
            </div>
            <Divider
              orientation="vertical"
              onMove={(x) => {
                const left = rootRef.current?.getBoundingClientRect().left ?? 0;
                setSidebarW(Math.max(140, Math.min(x - left - 44, 420)));
              }}
            />
          </>
        )}

        {/* 에디터 영역 */}
        <div className="flex min-w-0 flex-1 flex-col">
          {/* 탭 바 */}
          <div className="thin-scroll flex h-9 shrink-0 items-end overflow-x-auto bg-[#252526]">
            {tabs.map((t) => {
              const isActive = activePath === t.path;
              return (
                <button
                  key={t.path}
                  onClick={() => setActivePath(t.path)}
                  className={`group flex h-full shrink-0 items-center gap-1.5 border-r border-black/30 px-3 text-[13px] ${
                    isActive
                      ? "border-t border-t-[#0078d4] bg-[#1e1e1e] text-white"
                      : "border-t border-t-transparent text-[#969696] hover:text-[#cccccc]"
                  }`}
                >
                  <FileGlyph path={t.path} size={11} dark />
                  <span className="max-w-[160px] truncate">{t.path.split("/").pop()}</span>
                  <span
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTab(t.path);
                    }}
                    className={`flex h-4 w-4 items-center justify-center rounded-sm hover:bg-white/20 hover:text-white ${
                      t.dirty ? "" : isActive ? "text-[#cccccc]" : "text-transparent group-hover:text-[#969696]"
                    }`}
                  >
                    {t.dirty ? <span className="h-2 w-2 rounded-full bg-[#cccccc]" /> : <IconClose size={11} />}
                  </span>
                </button>
              );
            })}
          </div>
          {/* 브레드크럼 */}
          {active && (
            <div className="flex h-[22px] shrink-0 items-center gap-0.5 border-b border-black/20 bg-[#1e1e1e] px-3 text-[11px] text-[#a0a0a0]">
              {crumbs.map((seg, i) => (
                <span key={i} className="flex items-center gap-0.5">
                  {i > 0 && <IconChevronRight size={10} className="text-[#5a5a5a]" />}
                  {i === crumbs.length - 1 && <FileGlyph path={active.path} size={10} dark />}
                  <span className={i === crumbs.length - 1 ? "text-[#cccccc]" : ""}>{seg}</span>
                </span>
              ))}
            </div>
          )}
          {/* 에디터 */}
          <div className="min-h-0 flex-1">
            {active ? (
              <CodeEditor
                language={languageOf(active.path)}
                value={active.content}
                readOnly={readOnly}
                onCursorChange={(ln, col) => setCursor({ ln, col })}
                onChange={(code) =>
                  setTabs((t) => t.map((x) => (x.path === active.path ? { ...x, content: code, dirty: true } : x)))
                }
              />
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-[#6a6a6a]">
                <FiCopy size={40} className="opacity-40" />
                <p className="text-sm">탐색기에서 파일을 선택하세요</p>
                <p className="text-xs opacity-70">Ctrl+S 저장 · 터미널에서 실행</p>
              </div>
            )}
          </div>

          {/* 터미널 패널 */}
          {termOpen && (
            <>
              <Divider
                orientation="horizontal"
                onMove={(_x, y) => {
                  const rect = rootRef.current?.getBoundingClientRect();
                  if (rect) setTermH(Math.max(90, Math.min(rect.bottom - y - 22, rect.height - 160)));
                }}
              />
              <div className="flex shrink-0 flex-col bg-[#181818]" style={{ height: termH }}>
                <div className="flex h-[30px] shrink-0 items-center justify-between border-b border-black/40 px-3">
                  <span className="border-b border-[#cccccc] pb-[5px] pt-[6px] text-[11px] uppercase tracking-wide text-[#cccccc]">
                    터미널
                  </span>
                  <div className="flex items-center gap-0.5">
                    <button title="터미널 지우기" onClick={() => setLines([])} className="flex h-6 w-6 items-center justify-center rounded-sm text-[#8a8a8a] hover:bg-white/10 hover:text-white">
                      <IconDelete size={12} />
                    </button>
                    <button title="패널 닫기" onClick={() => setTermOpen(false)} className="flex h-6 w-6 items-center justify-center rounded-sm text-[#8a8a8a] hover:bg-white/10 hover:text-white">
                      <IconClose size={13} />
                    </button>
                  </div>
                </div>
                <div
                  ref={termScrollRef}
                  className="thin-scroll min-h-0 flex-1 cursor-text overflow-y-auto px-2 py-1 font-mono text-[12.5px] leading-[1.45]"
                  onClick={() => termInputRef.current?.focus()}
                >
                  {lines.map((l, i) =>
                    l.kind === "cmd" ? (
                      <div key={i} className="whitespace-pre-wrap break-all">
                        <Ps1 cwd={l.cwd} />
                        <span className="text-[#cccccc]">{l.text}</span>
                      </div>
                    ) : (
                      <div key={i} className={`whitespace-pre-wrap break-all ${l.kind === "err" ? "text-[#f48771]" : "text-[#cccccc]"}`}>
                        {l.text || " "}
                      </div>
                    ),
                  )}
                  {/* 프롬프트 (실행 중에는 커서만) */}
                  {!readOnly && (
                    <div className="flex items-center whitespace-pre">
                      {!running && <Ps1 cwd={cwd} />}
                      <input
                        ref={termInputRef}
                        className="min-w-0 flex-1 border-0 bg-transparent p-0 font-mono text-[12.5px] text-[#cccccc] caret-[#cccccc] outline-none"
                        value={running ? "" : input}
                        onChange={(e) => setInput(e.target.value)}
                        onKeyDown={onTermKey}
                        autoComplete="off"
                        autoCapitalize="off"
                        autoCorrect="off"
                        spellCheck={false}
                        aria-label="terminal"
                      />
                      {running && <span className="animate-pulse text-[#cccccc]">▍</span>}
                    </div>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* 상태 바 */}
      <div className="flex h-[22px] shrink-0 items-center justify-between bg-[#0078d4] px-2 text-[11px] text-white">
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1 bg-white/15 px-2 py-[1px]">Odysseus</span>
          <span className="opacity-90">워크스페이스</span>
        </div>
        <div className="flex items-center gap-3">
          {active && (
            <>
              <span>
                Ln {cursor.ln}, Col {cursor.col}
              </span>
              <span>UTF-8</span>
              <span>LF</span>
              <span className="capitalize">{langName === "plaintext" ? "Plain Text" : langName}</span>
              {active.dirty && <span className="opacity-90">● 저장되지 않음</span>}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

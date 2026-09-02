"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "@/lib/api";
import type { Execution } from "@/lib/types";
import { CodeEditor } from "@/components/CodeEditor";
import { Divider } from "@/components/Divider";
import { useToast } from "@/components/toast";
import {
  IconChevronRight,
  IconClose,
  IconDelete,
  IconNewFile,
  IconNewFolder,
  IconRefresh,
  IconTerminal,
} from "@/components/icons";
import { FiCopy, FiSettings } from "react-icons/fi";
import { buildTree, isKeepPath, languageOf, TreeNode, useWorkspace } from "../workspace";
import { FileGlyph, FolderGlyph } from "../fileicons";
import { ContextMenuView, MenuEntry, useContextMenu } from "../ContextMenu";

interface Tab {
  path: string;
  content: string;
  dirty: boolean;
}

// ── 탐색기 ───────────────────────────────────────────────────

interface Row {
  path: string;
  name: string;
  isDir: boolean;
  depth: number;
}

/** 접힘 상태를 반영해 트리를 평탄화 — 인라인 입력행 삽입과 컨텍스트 메뉴 처리가 쉬워진다. */
function flattenTree(nodes: TreeNode[], collapsed: Set<string>, depth = 0, out: Row[] = []): Row[] {
  for (const n of nodes) {
    out.push({ path: n.path, name: n.name, isDir: n.isDir, depth });
    if (n.isDir && !collapsed.has(n.path)) flattenTree(n.children, collapsed, depth + 1, out);
  }
  return out;
}

function dirOf(path: string): string {
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
}

function baseOf(path: string): string {
  return path.split("/").pop() ?? path;
}

function joinPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

/** "report.py" → "report copy.py" (중복이면 copy 2, copy 3 …) — VSCode 규약 */
function duplicateName(path: string, taken: Set<string>): string {
  const dir = dirOf(path);
  const base = baseOf(path);
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : "";
  for (let i = 1; i < 100; i++) {
    const candidate = joinPath(dir, `${stem} copy${i === 1 ? "" : ` ${i}`}${ext}`);
    if (!taken.has(candidate)) return candidate;
  }
  return joinPath(dir, `${stem} copy ${Date.now()}${ext}`);
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
  // 탐색기: 선택 항목 + 인라인 새 파일/폴더/이름 바꾸기 초안
  const [treeSel, setTreeSel] = useState<string | null>(null);
  const [draft, setDraft] = useState<
    { kind: "file" | "folder" | "rename"; parent: string; target?: string; value: string } | null
  >(null);
  const [draftError, setDraftError] = useState("");
  const { menu, open: openMenu, close: closeMenu } = useContextMenu();

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
  const rows = flattenTree(tree, collapsed);
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

  // ── 탐색기 조작 (인라인 생성/이름 바꾸기 · 복사 · 삭제) ──
  const expand = (dir: string) =>
    setCollapsed((s) => {
      if (!dir || !s.has(dir)) return s;
      const n = new Set(s);
      n.delete(dir);
      return n;
    });

  const beginCreate = (kind: "file" | "folder", parent: string) => {
    if (readOnly) return;
    expand(parent);
    setDraftError("");
    setDraft({ kind, parent, value: "" });
  };

  const beginRename = (path: string) => {
    if (readOnly) return;
    setDraftError("");
    setDraft({ kind: "rename", parent: dirOf(path), target: path, value: baseOf(path) });
  };

  /** 이름 변경/삭제 후 열린 탭 경로를 따라가게 한다 (폴더 이동이면 프리픽스 전체). */
  const remapTabs = (from: string, to: string | null) => {
    setTabs((list) =>
      list.flatMap((t) => {
        const isSelf = t.path === from;
        const isChild = t.path.startsWith(`${from}/`);
        if (!isSelf && !isChild) return [t];
        if (to === null) return [];
        const next = isSelf ? to : `${to}/${t.path.slice(from.length + 1)}`;
        return [{ ...t, path: next }];
      }),
    );
    setActivePath((cur) => {
      if (!cur) return cur;
      const isSelf = cur === from;
      const isChild = cur.startsWith(`${from}/`);
      if (!isSelf && !isChild) return cur;
      if (to === null) return null;
      return isSelf ? to : `${to}/${cur.slice(from.length + 1)}`;
    });
  };

  const commitDraft = async () => {
    if (!draft) return;
    const name = draft.value.trim().replace(/^\/+|\/+$/g, "");
    if (!name) {
      setDraft(null);
      return;
    }
    try {
      if (draft.kind === "rename" && draft.target) {
        const target = joinPath(dirOf(draft.target), name);
        if (target !== draft.target) {
          await ws.renameFile(draft.target, target);
          remapTabs(draft.target, target);
        }
      } else if (draft.kind === "folder") {
        await ws.createFolder(joinPath(draft.parent, name));
      } else {
        const path = joinPath(draft.parent, name);
        await ws.saveContent(path, "");
        await openFile(path);
      }
      setDraft(null);
      setDraftError("");
    } catch (e) {
      setDraftError(e instanceof ApiError ? e.message : "작업에 실패했습니다");
    }
  };

  const removePath = async (path: string, isDir: boolean) => {
    if (readOnly) return;
    const okToGo = await confirm({
      title: isDir ? "폴더를 삭제할까요?" : "파일을 삭제할까요?",
      message: isDir ? `${path} — 하위 파일이 모두 삭제됩니다.` : path,
      danger: true,
      confirmLabel: "삭제",
    });
    if (!okToGo) return;
    try {
      await ws.deleteFile(path);
      remapTabs(path, null);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "삭제에 실패했습니다", "error");
    }
  };

  const duplicatePath = async (path: string) => {
    if (readOnly) return;
    const taken = new Set(ws.files.map((f) => f.path));
    try {
      const to = duplicateName(path, taken);
      await ws.copyPath(path, to);
      toast(`복사됨 — ${to}`, "success");
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "복사에 실패했습니다", "error");
    }
  };

  const copyPathText = async (path: string) => {
    try {
      await navigator.clipboard.writeText(path);
      toast("경로를 클립보드에 복사했습니다", "success");
    } catch {
      toast(path, "info");
    }
  };

  const rowMenu = (row: Row): MenuEntry[] => {
    const dirTarget = row.isDir ? row.path : dirOf(row.path);
    const items: MenuEntry[] = [];
    if (!row.isDir) items.push({ label: "열기", onClick: () => openFile(row.path) });
    if (!readOnly) {
      items.push({ label: "새 파일", onClick: () => beginCreate("file", dirTarget) });
      items.push({ label: "새 폴더", onClick: () => beginCreate("folder", dirTarget) });
      items.push("separator");
      items.push({ label: "이름 바꾸기", shortcut: "F2", onClick: () => beginRename(row.path) });
      items.push({ label: "복사본 만들기", onClick: () => duplicatePath(row.path) });
    }
    items.push({ label: "경로 복사", onClick: () => copyPathText(row.path) });
    if (!readOnly) {
      items.push("separator");
      items.push({ label: "삭제", shortcut: "Del", danger: true, onClick: () => removePath(row.path, row.isDir) });
    }
    return items;
  };

  /** 인라인 입력행 — 새 파일/새 폴더/이름 바꾸기 공용 (VSCode와 동일한 위치에 렌더) */
  const draftInput = (depth: number) => (
    <div className="flex h-[22px] items-center gap-1 pr-1" style={{ paddingLeft: 6 + depth * 12 }}>
      <span className="w-4 shrink-0" />
      {draft?.kind === "folder" ? (
        <FolderGlyph size={14} />
      ) : (
        <FileGlyph path={draft?.value || "new"} size={12} dark />
      )}
      <input
        autoFocus
        value={draft?.value ?? ""}
        onChange={(e) => {
          setDraftError("");
          setDraft((d) => (d ? { ...d, value: e.target.value } : d));
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing) commitDraft();
          if (e.key === "Escape") {
            setDraft(null);
            setDraftError("");
          }
        }}
        onBlur={() => commitDraft()}
        placeholder={draft?.kind === "folder" ? "폴더 이름" : "파일 이름"}
        className={`min-w-0 flex-1 rounded-sm border bg-[#1e1e1e] px-1 py-[1px] text-[13px] text-[#cccccc] outline-none ${
          draftError ? "border-red-500" : "border-[#0078d4]"
        }`}
        aria-label="explorer-draft"
      />
      {draftError && (
        <span className="absolute z-10 mt-8 rounded bg-red-900/90 px-2 py-0.5 text-[11px] text-red-100">
          {draftError}
        </span>
      )}
    </div>
  );

  const rootMenu = (): MenuEntry[] => {
    const items: MenuEntry[] = [];
    if (!readOnly) {
      items.push({ label: "새 파일", onClick: () => beginCreate("file", "") });
      items.push({ label: "새 폴더", onClick: () => beginCreate("folder", "") });
      items.push("separator");
    }
    items.push({ label: "새로고침", onClick: () => ws.refresh() });
    return items;
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
              <div
                className="flex h-[22px] items-center gap-1 bg-[#2d2d30] pl-1 pr-1.5"
                onContextMenu={(e) => openMenu(e, rootMenu(), { dark: true })}
              >
                <span className="flex w-4 justify-center text-[#8a8a8a]">
                  <IconChevronRight size={12} className="rotate-90" />
                </span>
                <span className="flex-1 truncate text-[11px] font-bold uppercase tracking-wide text-[#cccccc]">
                  워크스페이스
                </span>
                {!readOnly && (
                  <>
                    <button
                      title="새 파일"
                      onClick={() => beginCreate("file", "")}
                      className="flex h-5 w-5 items-center justify-center rounded-sm text-[#aaaaaa] hover:bg-white/10 hover:text-white"
                    >
                      <IconNewFile size={13} />
                    </button>
                    <button
                      title="새 폴더"
                      onClick={() => beginCreate("folder", "")}
                      className="flex h-5 w-5 items-center justify-center rounded-sm text-[#aaaaaa] hover:bg-white/10 hover:text-white"
                    >
                      <IconNewFolder size={13} />
                    </button>
                  </>
                )}
                <button
                  title="새로고침"
                  onClick={() => ws.refresh()}
                  className="flex h-5 w-5 items-center justify-center rounded-sm text-[#aaaaaa] hover:bg-white/10 hover:text-white"
                >
                  <IconRefresh size={11} />
                </button>
              </div>
              <div
                className="thin-scroll min-h-0 flex-1 overflow-y-auto py-0.5 outline-none"
                tabIndex={0}
                onContextMenu={(e) => openMenu(e, rootMenu(), { dark: true })}
                onClick={() => setTreeSel(null)}
                onKeyDown={(e) => {
                  if (!treeSel || draft) return;
                  const row = rows.find((r) => r.path === treeSel);
                  if (!row) return;
                  if (e.key === "F2") {
                    e.preventDefault();
                    beginRename(row.path);
                  }
                  if (e.key === "Delete") {
                    e.preventDefault();
                    removePath(row.path, row.isDir);
                  }
                }}
              >
                {/* 루트에 새로 만드는 중 */}
                {draft && draft.kind !== "rename" && draft.parent === "" && draftInput(0)}

                {rows.map((row) => {
                  const isRenaming = draft?.kind === "rename" && draft.target === row.path;
                  const open = row.isDir && !collapsed.has(row.path);
                  return (
                    <div key={(row.isDir ? "d:" : "f:") + row.path}>
                      {isRenaming ? (
                        draftInput(row.depth)
                      ) : (
                        <div
                          className={`group flex h-[22px] cursor-pointer items-center gap-1 pr-1 text-[13px] ${
                            activePath === row.path || treeSel === row.path
                              ? "bg-[#37373d] text-white"
                              : "text-[#cccccc] hover:bg-[#2a2d2e]"
                          }`}
                          style={{ paddingLeft: 6 + row.depth * 12 }}
                          onClick={(e) => {
                            e.stopPropagation();
                            setTreeSel(row.path);
                            if (row.isDir) {
                              setCollapsed((sset) => {
                                const n = new Set(sset);
                                if (n.has(row.path)) n.delete(row.path);
                                else n.add(row.path);
                                return n;
                              });
                            } else {
                              openFile(row.path);
                            }
                          }}
                          onContextMenu={(e) => {
                            setTreeSel(row.path);
                            openMenu(e, rowMenu(row), { dark: true });
                          }}
                        >
                          <span
                            className={`flex w-4 shrink-0 justify-center text-[#8a8a8a] transition-transform ${
                              row.isDir ? (open ? "rotate-90" : "") : "opacity-0"
                            }`}
                          >
                            <IconChevronRight size={12} />
                          </span>
                          {row.isDir ? (
                            <FolderGlyph size={14} open={open} />
                          ) : (
                            <FileGlyph path={row.path} size={12} dark />
                          )}
                          <span className="min-w-0 flex-1 truncate">{row.name}</span>
                        </div>
                      )}
                      {/* 이 폴더 아래에 새로 만드는 중 */}
                      {draft && draft.kind !== "rename" && draft.parent === row.path && draftInput(row.depth + 1)}
                    </div>
                  );
                })}

                {ws.files.length === 0 && !ws.loading && !draft && (
                  <p className="px-4 pt-3 text-xs text-[#8a8a8a]">
                    워크스페이스가 비어 있습니다 — 우클릭으로 파일을 만드세요
                  </p>
                )}
              </div>
            </div>
            <Divider
              orientation="vertical"
              tone="dark"
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
                  onContextMenu={(e) =>
                    openMenu(
                      e,
                      [
                        { label: "닫기", onClick: () => closeTab(t.path) },
                        {
                          label: "다른 탭 모두 닫기",
                          onClick: () => {
                            setTabs((list) => list.filter((x) => x.path === t.path));
                            setActivePath(t.path);
                          },
                        },
                        "separator",
                        { label: "경로 복사", onClick: () => copyPathText(t.path) },
                        ...(readOnly
                          ? []
                          : ([
                              { label: "이름 바꾸기", onClick: () => beginRename(t.path) },
                              { label: "복사본 만들기", onClick: () => duplicatePath(t.path) },
                            ] as MenuEntry[])),
                      ],
                      { dark: true },
                    )
                  }
                  className={`group flex h-full shrink-0 items-center gap-1.5 border-r border-black/40 px-3 text-[13px] ${
                    isActive
                      ? "border-t border-t-[#0078d4] bg-[#1e1e1e] text-white"
                      : "border-t border-t-transparent bg-[#2d2d2d] text-[#969696] hover:bg-[#2a2a2a] hover:text-[#cccccc]"
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
          <div
            className="min-h-0 flex-1"
            onContextMenu={(e) => {
              if (!active) return;
              openMenu(
                e,
                [
                  ...(readOnly
                    ? []
                    : ([
                        {
                          label: "저장",
                          shortcut: "Ctrl+S",
                          disabled: !active.dirty,
                          onClick: () => save(active),
                        },
                        { label: "이름 바꾸기", onClick: () => beginRename(active.path) },
                        { label: "복사본 만들기", onClick: () => duplicatePath(active.path) },
                        "separator",
                      ] as MenuEntry[])),
                  { label: "경로 복사", onClick: () => copyPathText(active.path) },
                  { label: "탐색기에서 표시", onClick: () => { setSidebarOpen(true); setTreeSel(active.path); expand(dirOf(active.path)); } },
                  "separator",
                  { label: "탭 닫기", onClick: () => closeTab(active.path) },
                ],
                { dark: true },
              );
            }}
          >
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
                tone="dark"
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
                  onContextMenu={(e) =>
                    openMenu(
                      e,
                      [
                        {
                          label: "붙여넣기",
                          disabled: readOnly || running,
                          onClick: async () => {
                            try {
                              const text = await navigator.clipboard.readText();
                              if (text) setInput((v) => v + text.replace(/\n/g, " "));
                              termInputRef.current?.focus();
                            } catch {
                              toast("클립보드를 읽을 수 없습니다 (Ctrl+V를 사용하세요)", "info");
                            }
                          },
                        },
                        {
                          label: "출력 복사",
                          onClick: async () => {
                            const text = lines
                              .map((l) => (l.kind === "cmd" ? `$ ${l.text}` : l.text))
                              .join("\n");
                            try {
                              await navigator.clipboard.writeText(text);
                              toast("터미널 출력을 복사했습니다", "success");
                            } catch {
                              toast("복사에 실패했습니다", "error");
                            }
                          },
                        },
                        "separator",
                        { label: "터미널 지우기", shortcut: "Ctrl+L", onClick: () => setLines([]) },
                      ],
                      { dark: true },
                    )
                  }
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

      <ContextMenuView menu={menu} onClose={closeMenu} />

      {/* 상태 바 */}
      <div className="flex h-[22px] shrink-0 items-center justify-between bg-[#007acc] px-2 text-[11px] text-white">
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1 bg-[#16825d] px-2 py-[1px] font-semibold">Odysseus</span>
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

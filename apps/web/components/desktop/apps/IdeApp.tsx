"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "@/lib/api";
import type { Execution } from "@/lib/types";
import { CodeEditor } from "@/components/CodeEditor";
import { Divider } from "@/components/Divider";
import { useToast } from "@/components/toast";
import {
  IconAgent,
  IconChevronRight,
  IconClose,
  IconDelete,
  IconNewFile,
  IconNewFolder,
  IconRefresh,
  IconTerminal,
} from "@/components/icons";
import { FiCopy, FiSettings } from "react-icons/fi";
import { copyText, selectedText } from "@/lib/clipboard";
import { saveStatusText } from "@/lib/autosave";
import { buildTree, isKeepPath, languageOf, TreeNode, useWorkspaceAs } from "../workspace";
import { useFileSaver } from "../useFileSaver";
import { FileGlyph, FolderGlyph } from "../fileicons";
import { ContextMenuView, MenuEntry, useContextMenu } from "../ContextMenu";
import { AgentChat } from "../AgentChat";
import { TerminalView } from "../TerminalView";
import { useTerminalSession } from "../terminalSession";
import { useAgentSession } from "../agentSession";

/** 열린 탭 — 저장 상태(더티·충돌·재시도)는 저장기(useFileSaver)가 경로별로 갖는다 */
interface Tab {
  path: string;
  content: string;
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

// ── IDE 본체 ─────────────────────────────────────────────────

/** VSCode풍 IDE — 액티비티 바 + 탐색기 + 탭/브레드크럼 + Monaco + 터미널 + 상태 바. */
export function IdeApp({ readOnly = false, onActivity }: { readOnly?: boolean; onActivity?: () => void }) {
  const ws = useWorkspaceAs("ide");
  const { toast, confirm } = useToast();
  // 자동 저장·제출 전 저장·충돌·재시도 — IDE·문서·표가 같은 규칙을 쓴다 (lib/autosave)
  const saver = useFileSaver(ws);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarView, setSidebarView] = useState<"explorer" | "agent">("explorer");
  const [sidebarW, setSidebarW] = useState(200);
  const [agentW, setAgentW] = useState(380);
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
  // 에이전트는 데스크톱 창과 **같은 세션/같은 대화** — 위치만 다르다
  const agent = useAgentSession();

  // 터미널은 데스크톱의 [터미널] 앱과 **같은 세션** — 여기서는 패널로 보여줄 뿐이다
  const term = useTerminalSession();

  const rootRef = useRef<HTMLDivElement>(null);

  const tree = buildTree(ws.files);
  const rows = flattenTree(tree, collapsed);
  const active = tabs.find((t) => t.path === activePath) ?? null;

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
        if (!readOnly) saver.open(path, fc.content, fc.sha256);
        setTabs((t) => [...t, { path, content: fc.content }]);
        setActivePath(path);
      } catch (e) {
        toast(e instanceof ApiError ? e.message : "파일을 열 수 없습니다", "error");
      }
    },
    [tabs, ws, toast, saver, readOnly],
  );

  useEffect(() => {
    if (ws.pendingIdeOpen) {
      const p = ws.pendingIdeOpen;
      ws.consumeIdeOpen();
      openFile(p);
    }
  }, [ws.pendingIdeOpen, ws, openFile]);

  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  /** 탭을 닫는다 — 편집이 남아 있으면 먼저 저장하고, 저장하지 못했으면 이름을 대고 묻는다.
   *  예전에는 더티 탭의 점을 누르면 편집이 경고 없이 사라졌다. */
  const closeTabs = async (paths: string[]) => {
    if (!readOnly) {
      const results = await Promise.all(paths.map(async (p) => ((await saver.flushOne(p)) ? null : p)));
      const failed = results.filter((p): p is string => p !== null);
      if (failed.length > 0) {
        const ok = await confirm({
          title: "저장하지 못한 편집이 있습니다",
          message: (
            <>
              <b>{failed.join(", ")}</b> — 탭을 닫으면 이 편집은 사라집니다.
            </>
          ),
          danger: true,
          confirmLabel: "편집 버리고 닫기",
        });
        if (!ok) return;
      }
      paths.forEach((p) => saver.close(p));
    }
    const rest = tabsRef.current.filter((x) => !paths.includes(x.path));
    setTabs((list) => list.filter((x) => !paths.includes(x.path)));
    setActivePath((cur) => (cur && paths.includes(cur) ? rest.at(-1)?.path ?? null : cur));
  };
  const closeTab = (path: string) => void closeTabs([path]);

  const save = useCallback(
    async (path: string | null) => {
      if (!path || readOnly) return;
      if (await saver.save(path)) onActivity?.();
      else toast(saveStatusText(saver.status(path)) || "저장에 실패했습니다", "error");
    },
    [saver, toast, readOnly, onActivity],
  );

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        if (rootRef.current?.contains(document.activeElement) || tabs.some((t) => saver.isDirty(t.path))) {
          e.preventDefault();
          void save(activePath);
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [tabs, activePath, save, saver]);

  // 밖에서 바뀐 파일 — 에이전트·터미널·다른 앱이 쓰면 워크스페이스 목록이 새 버전을 알려 준다.
  // 편집하지 않은 탭은 새 내용으로 맞추고, 편집 중인 탭은 자동 저장을 멈추고 응시자에게 고르게 한다
  // (조용히 덮으면 에이전트가 고친 것이 사라지고, 조용히 불러오면 응시자의 편집이 사라진다).
  useEffect(() => {
    if (readOnly) return;
    for (const tab of tabsRef.current) {
      const entry = ws.files.find((f) => f.path === tab.path);
      if (!entry?.sha256 || saver.noteServerVersion(tab.path, entry.sha256) !== "reload") continue;
      ws.loadContent(tab.path)
        .then((fc) => {
          if (saver.isDirty(tab.path)) return; // 읽는 사이 편집이 시작됐다 — 다음 저장의 버전 확인이 막는다
          saver.open(tab.path, fc.content, fc.sha256);
          setTabs((t) => t.map((x) => (x.path === tab.path ? { ...x, content: fc.content } : x)));
        })
        .catch(() => undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws.files, readOnly]);

  /** 충돌 해소 — 내 편집으로 덮어쓰기 */
  const keepMine = async (path: string) => {
    if (!(await saver.keepMine(path))) toast(saveStatusText(saver.status(path)) || "저장에 실패했습니다", "error");
  };

  /** 충돌 해소 — 서버의 내용을 불러온다 (내 편집은 버린다). 삭제된 파일이면 탭을 닫는다 */
  const loadServer = async (path: string) => {
    try {
      const fc = await ws.loadContent(path);
      saver.open(path, fc.content, fc.sha256);
      setTabs((t) => t.map((x) => (x.path === path ? { ...x, content: fc.content } : x)));
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        saver.close(path);
        remapTabs(path, null);
      } else {
        toast(e instanceof ApiError ? e.message : "파일을 불러오지 못했습니다", "error");
      }
    }
  };

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
    for (const t of tabsRef.current) {
      const isSelf = t.path === from;
      if (!isSelf && !t.path.startsWith(`${from}/`)) continue;
      if (to === null) saver.close(t.path);
      else saver.rename(t.path, isSelf ? to : `${to}/${t.path.slice(from.length + 1)}`);
    }
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
    if (await copyText(path)) toast("경로를 클립보드에 복사했습니다", "success");
    else toast(path, "info");
  };

  // ── 초기 상태로 되돌리기 ──
  // 여러 가지를 시도하다 아니다 싶으면 처음부터 다시 — 시나리오가 준 초기 파일이 원본이다.
  const resetOne = async (path: string) => {
    if (readOnly || !ws.isInitial(path)) return;
    const okToGo = await confirm({
      title: "초기 내용으로 되돌릴까요?",
      message: (
        <>
          <b>{path}</b> 를 시나리오가 처음 제공한 내용으로 되돌립니다. 지금까지 이 파일에 한 수정은
          사라집니다.
        </>
      ),
      danger: true,
      confirmLabel: "되돌리기",
    });
    if (!okToGo) return;
    try {
      await ws.resetFile(path);
      toast(`되돌렸습니다 — ${path}`, "success");
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "되돌리기에 실패했습니다", "error");
    }
  };

  const resetWorkspace = async () => {
    if (readOnly) return;
    const okToGo = await confirm({
      title: "워크스페이스 전체를 초기화할까요?",
      message: (
        <>
          시나리오가 처음 제공한 파일은 원래 내용으로 돌아가고, 그 뒤에 만든 파일은{" "}
          <b>모두 삭제</b>됩니다. 되돌릴 수 없습니다.
        </>
      ),
      danger: true,
      confirmLabel: "전체 초기화",
    });
    if (!okToGo) return;
    try {
      const res = await ws.resetAll();
      toast(`워크스페이스를 초기화했습니다 — 복원 ${res.restored}개, 삭제 ${res.removed}개`, "success");
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "초기화에 실패했습니다", "error");
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
      if (!row.isDir && ws.isInitial(row.path)) {
        items.push({ label: "초기 내용으로 되돌리기", onClick: () => resetOne(row.path) });
      }
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
    if (!readOnly && ws.initialPaths.length > 0) {
      items.push("separator");
      items.push({ label: "워크스페이스 초기화…", danger: true, onClick: resetWorkspace });
    }
    return items;
  };

  // ── 터미널 세션 연결 ──
  // 실행은 서버 파일 기준이다 — 셸이 돌기 전에 편집 중인 내용을 먼저 저장한다.
  // 실행이 바꾼 파일은 터미널이 워크스페이스 목록을 갱신하므로 위의 '밖에서 바뀐 파일' 이 맞춘다.
  useEffect(
    () =>
      term.registerPreRun(async () => {
        if (!readOnly) await saver.flush();
      }),
    [term, saver, readOnly],
  );

  // 되돌리기(이 창이든 폴더·문서·표 앱에서든)는 편집 중이던 내용보다 우선한다 — 그것이 되돌리기의 뜻이다.
  // 파일 하나면 그 탭만, 전체 초기화면 열린 탭 전부를 다시 읽고 사라진 파일의 탭은 닫는다.
  useEffect(
    () =>
      ws.subscribeChanges(async ({ scope, paths }) => {
        const targets = tabsRef.current.filter((t) => scope === "all" || paths.includes(t.path));
        for (const tab of targets) {
          const fc = await ws.loadContent(tab.path).catch(() => null);
          if (fc) {
            saver.open(tab.path, fc.content, fc.sha256);
            setTabs((t) => t.map((x) => (x.path === tab.path ? { ...x, content: fc.content } : x)));
          } else remapTabs(tab.path, null);
        }
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ws.subscribeChanges, ws.loadContent],
  );

  const activeStatus = active && !readOnly ? saver.status(active.path) : null;
  const crumbs = active ? active.path.split("/") : [];
  const langName = active ? languageOf(active.path) : "";

  /** 같은 뷰를 다시 누르면 사이드바를 접고, 다른 뷰면 전환한다 (VSCode 규약) */
  const toggleSidebar = (view: "explorer" | "agent") => {
    if (sidebarOpen && sidebarView === view) {
      setSidebarOpen(false);
      return;
    }
    setSidebarView(view);
    setSidebarOpen(true);
  };

  const activityBtn = (activeState: boolean) =>
    `relative flex h-11 w-full items-center justify-center transition-colors ${
      activeState ? "text-white" : "text-[#7a7a7a] hover:text-white"
    }`;

  return (
    <div ref={rootRef} className="flex h-full min-h-0 flex-col bg-[#1e1e1e]">
      <div className="flex min-h-0 flex-1">
        {/* 액티비티 바 */}
        <div className="flex w-11 shrink-0 flex-col items-center border-r border-black/40 bg-[#333333] py-1">
          <button
            title="탐색기"
            className={activityBtn(sidebarOpen && sidebarView === "explorer")}
            onClick={() => toggleSidebar("explorer")}
          >
            {sidebarOpen && sidebarView === "explorer" && (
              <span className="absolute left-0 top-1.5 h-8 w-[2px] bg-white" />
            )}
            <FiCopy size={20} />
          </button>
          <button title="터미널" className={activityBtn(termOpen)} onClick={() => setTermOpen((v) => !v)}>
            {termOpen && <span className="absolute left-0 top-1.5 h-8 w-[2px] bg-white" />}
            <IconTerminal size={20} />
          </button>
          {agent?.available && (
            <button
              title="AI 에이전트"
              className={activityBtn(sidebarOpen && sidebarView === "agent")}
              onClick={() => toggleSidebar("agent")}
            >
              {sidebarOpen && sidebarView === "agent" && (
                <span className="absolute left-0 top-1.5 h-8 w-[2px] bg-white" />
              )}
              <IconAgent size={20} />
              {/* 에이전트가 일하는 중 — 깜빡이지 않는다. 시험장의 움직이는 것은 눈을 뺏는다. */}
              {agent.busy && <span className="absolute right-2 top-2 h-1.5 w-1.5 rounded-full bg-amber-400" />}
            </button>
          )}
          <div className="mt-auto">
            <span className="flex h-11 w-11 items-center justify-center text-[#5a5a5a]">
              <FiSettings size={19} />
            </span>
          </div>
        </div>

        {/* 사이드바: 탐색기 */}
        {sidebarOpen && (
          <>
            <div
              className="flex shrink-0 flex-col bg-[#252526]"
              style={{ width: sidebarView === "agent" ? agentW : sidebarW }}
            >
              <div className="flex h-8 shrink-0 items-center justify-between pl-4 pr-2">
                <span className="text-[11px] uppercase tracking-wide text-[#bbbbbb]">
                  {sidebarView === "agent" ? "AI 에이전트" : "탐색기"}
                </span>
                {sidebarView === "agent" && agent?.usage && (
                  <span className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] font-semibold text-[#cccccc]">
                    남은 질문 {agent.usage.remaining}/{agent.usage.max}
                  </span>
                )}
              </div>
              {sidebarView === "agent" ? (
                <div className="min-h-0 flex-1">
                  <AgentChat theme="dark" showHeader={false} />
                </div>
              ) : (
              <>
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
              </>
              )}
            </div>
            <Divider
              orientation="vertical"
              tone="dark"
              onMove={(x) => {
                const left = rootRef.current?.getBoundingClientRect().left ?? 0;
                const next = x - left - 44;
                if (sidebarView === "agent") setAgentW(Math.max(280, Math.min(next, 640)));
                else setSidebarW(Math.max(140, Math.min(next, 420)));
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
              const dirty = saver.isDirty(t.path);
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
                            setActivePath(t.path);
                            void closeTabs(tabs.filter((x) => x.path !== t.path).map((x) => x.path));
                          },
                        },
                        "separator",
                        { label: "경로 복사", onClick: () => copyPathText(t.path) },
                        ...(readOnly
                          ? []
                          : ([
                              { label: "이름 바꾸기", onClick: () => beginRename(t.path) },
                              { label: "복사본 만들기", onClick: () => duplicatePath(t.path) },
                              ...(ws.isInitial(t.path)
                                ? [{ label: "초기 내용으로 되돌리기", onClick: () => resetOne(t.path) }]
                                : []),
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
                      dirty ? "" : isActive ? "text-[#cccccc]" : "text-transparent group-hover:text-[#969696]"
                    }`}
                  >
                    {dirty ? <span className="h-2 w-2 rounded-full bg-[#cccccc]" /> : <IconClose size={11} />}
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
          {/* 충돌 — 이 파일이 밖에서 바뀌었다. 자동 저장은 멈췄고, 응시자가 고를 때까지 어느 쪽도 덮지 않는다 */}
          {active && activeStatus?.kind === "conflict" && (
            <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-amber-500/40 bg-amber-500/15 px-3 py-1.5 text-[12px] text-amber-100">
              <span className="min-w-0 flex-1">
                {activeStatus.deleted
                  ? "이 파일이 다른 곳에서 삭제되었습니다."
                  : "이 파일이 다른 곳(에이전트·터미널 등)에서 바뀌었습니다."}{" "}
                내 편집은 아직 저장되지 않았습니다.
              </span>
              <button
                onClick={() => void keepMine(active.path)}
                className="rounded-sm bg-amber-500/80 px-2 py-0.5 text-[11px] font-semibold text-black hover:bg-amber-400"
              >
                {activeStatus.deleted ? "내 편집으로 다시 만들기" : "내 편집으로 덮어쓰기"}
              </button>
              <button
                onClick={() => void loadServer(active.path)}
                className="rounded-sm border border-amber-400/50 px-2 py-0.5 text-[11px] hover:bg-white/10"
              >
                {activeStatus.deleted ? "내 편집 버리고 닫기" : "내 편집 버리고 바뀐 내용 불러오기"}
              </button>
            </div>
          )}
          {/* 에디터 */}
          <div
            className="min-h-0 flex-1"
            onContextMenu={(e) => {
              if (!active) return;
              const sel = selectedText();
              openMenu(
                e,
                [
                  ...(sel
                    ? ([
                        { label: "선택 영역 복사", shortcut: "Ctrl+C", onClick: () => copyText(sel) },
                        "separator",
                      ] as MenuEntry[])
                    : []),
                  ...(readOnly
                    ? []
                    : ([
                        {
                          label: "저장",
                          shortcut: "Ctrl+S",
                          disabled: !saver.isDirty(active.path),
                          onClick: () => save(active.path),
                        },
                        { label: "이름 바꾸기", onClick: () => beginRename(active.path) },
                        { label: "복사본 만들기", onClick: () => duplicatePath(active.path) },
                        ...(ws.isInitial(active.path)
                          ? [{ label: "초기 내용으로 되돌리기", onClick: () => resetOne(active.path) }]
                          : []),
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
                onChange={(code) => {
                  setTabs((t) => t.map((x) => (x.path === active.path ? { ...x, content: code } : x)));
                  if (!readOnly) saver.edit(active.path, code);
                }}
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
                    <button title="터미널 지우기" onClick={term.clear} className="flex h-6 w-6 items-center justify-center rounded-sm text-[#8a8a8a] hover:bg-white/10 hover:text-white">
                      <IconDelete size={12} />
                    </button>
                    <button title="패널 닫기" onClick={() => setTermOpen(false)} className="flex h-6 w-6 items-center justify-center rounded-sm text-[#8a8a8a] hover:bg-white/10 hover:text-white">
                      <IconClose size={13} />
                    </button>
                  </div>
                </div>
                <div className="thin-scroll min-h-0 flex-1">
                  <TerminalView readOnly={readOnly} />
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
              {/* 문서·표 편집기와 같은 문구 — 실패하는 동안에도 사실대로 말한다 */}
              {!readOnly && <span className="opacity-90">{saveStatusText(activeStatus)}</span>}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import type { FileContent, FileEntry } from "@/lib/types";

/** IDE·폴더·에이전트가 공유하는 워크스페이스 파일 상태 (시나리오 단위). */
interface WorkspaceCtxValue {
  attemptId: string;
  scenarioId: string;
  files: FileEntry[];
  loading: boolean;
  refresh: () => Promise<void>;
  loadContent: (path: string) => Promise<FileContent>;
  saveContent: (path: string, content: string) => Promise<void>;
  deleteFile: (path: string) => Promise<void>;
  renameFile: (from: string, to: string) => Promise<void>;
  /** 폴더 앱 → IDE로 파일 열기 요청 (데스크톱이 IDE 창을 띄우고 전달) */
  requestOpenInIde: (path: string) => void;
  /** IDE가 소비할 대기 중 열기 요청 */
  pendingIdeOpen: string | null;
  consumeIdeOpen: () => void;
}

const Ctx = createContext<WorkspaceCtxValue | null>(null);

export function useWorkspace(): WorkspaceCtxValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("WorkspaceProvider missing");
  return v;
}

export function WorkspaceProvider({
  attemptId,
  scenarioId,
  onOpenIde,
  children,
}: {
  attemptId: string;
  scenarioId: string;
  onOpenIde: () => void;
  children: React.ReactNode;
}) {
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [pendingIdeOpen, setPendingIdeOpen] = useState<string | null>(null);

  const base = `/attempts/${attemptId}/scenarios/${scenarioId}`;

  const refresh = useCallback(async () => {
    const rows = await api.get<FileEntry[]>(`${base}/files`);
    setFiles(rows);
    setLoading(false);
  }, [base]);

  useEffect(() => {
    setLoading(true);
    refresh().catch(() => setLoading(false));
  }, [refresh]);

  const loadContent = useCallback(
    (path: string) => api.get<FileContent>(`${base}/files/content?path=${encodeURIComponent(path)}`),
    [base],
  );

  const saveContent = useCallback(
    async (path: string, content: string) => {
      await api.put(`${base}/files/content`, { path, content });
      await refresh();
    },
    [base, refresh],
  );

  const deleteFile = useCallback(
    async (path: string) => {
      await api.del(`${base}/files?path=${encodeURIComponent(path)}`);
      await refresh();
    },
    [base, refresh],
  );

  const renameFile = useCallback(
    async (from: string, to: string) => {
      await api.post(`${base}/files/rename`, { from_path: from, to_path: to });
      await refresh();
    },
    [base, refresh],
  );

  const requestOpenInIde = useCallback(
    (path: string) => {
      setPendingIdeOpen(path);
      onOpenIde();
    },
    [onOpenIde],
  );

  const consumeIdeOpen = useCallback(() => setPendingIdeOpen(null), []);

  const value = useMemo(
    () => ({
      attemptId,
      scenarioId,
      files,
      loading,
      refresh,
      loadContent,
      saveContent,
      deleteFile,
      renameFile,
      requestOpenInIde,
      pendingIdeOpen,
      consumeIdeOpen,
    }),
    [
      attemptId,
      scenarioId,
      files,
      loading,
      refresh,
      loadContent,
      saveContent,
      deleteFile,
      renameFile,
      requestOpenInIde,
      pendingIdeOpen,
      consumeIdeOpen,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

// ── 파일 트리 유틸 ───────────────────────────────────────────

export interface TreeNode {
  name: string;
  path: string; // 폴더는 프리픽스, 파일은 전체 경로
  isDir: boolean;
  children: TreeNode[];
  size?: number;
}

export function buildTree(files: FileEntry[]): TreeNode[] {
  const root: TreeNode = { name: "", path: "", isDir: true, children: [] };
  for (const f of files) {
    const parts = f.path.split("/");
    let node = root;
    for (let i = 0; i < parts.length; i++) {
      const isLeaf = i === parts.length - 1;
      const name = parts[i];
      const path = parts.slice(0, i + 1).join("/");
      let child = node.children.find((c) => c.name === name && c.isDir === !isLeaf);
      if (!child) {
        child = { name, path, isDir: !isLeaf, children: [], size: isLeaf ? f.size : undefined };
        node.children.push(child);
      }
      node = child;
    }
  }
  const sortRec = (n: TreeNode) => {
    n.children.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
    n.children.forEach(sortRec);
  };
  sortRec(root);
  return root.children;
}

export function languageOf(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    py: "python",
    js: "javascript",
    ts: "typescript",
    tsx: "typescript",
    jsx: "javascript",
    json: "json",
    md: "markdown",
    csv: "plaintext",
    txt: "plaintext",
    html: "html",
    css: "css",
    sql: "sql",
    sh: "shell",
    yml: "yaml",
    yaml: "yaml",
    go: "go",
    java: "java",
    c: "c",
    cpp: "cpp",
    h: "cpp",
  };
  return map[ext] ?? "plaintext";
}

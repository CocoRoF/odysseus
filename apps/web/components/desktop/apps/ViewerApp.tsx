"use client";

import { useEffect, useState } from "react";
import { copyText, selectedText } from "@/lib/clipboard";
import { useToast } from "@/components/toast";
import { FilePreview } from "../FilePreview";
import { ContextMenuView, MenuEntry, useContextMenu } from "../ContextMenu";
import { useWorkspace } from "../workspace";

/** 뷰어 — 아무 기능 없는 읽기 전용 파일 보기. 탐색기 더블클릭으로 열린다. */
export function ViewerApp({ path }: { path: string | null }) {
  const ws = useWorkspace();
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState("");
  const { menu, open: openMenu, close: closeMenu } = useContextMenu();
  const { toast } = useToast();

  useEffect(() => {
    if (!path) return;
    setContent(null);
    setError("");
    ws.loadContent(path)
      .then((fc) => setContent(fc.content))
      .catch(() => setError("파일을 불러올 수 없습니다"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  if (!path) {
    return (
      <div className="flex h-full items-center justify-center bg-white text-sm text-slate-400">
        표시할 파일이 없습니다
      </div>
    );
  }
  if (error) {
    return <div className="flex h-full items-center justify-center bg-white text-sm text-red-500">{error}</div>;
  }
  if (content === null) {
    return <div className="flex h-full items-center justify-center bg-white text-xs text-slate-400">불러오는 중...</div>;
  }
  const copy = async (text: string, label: string) => {
    if (await copyText(text)) toast(`${label}을(를) 복사했습니다`, "success");
    else toast("복사에 실패했습니다", "error");
  };

  return (
    <div
      className="h-full bg-white"
      onContextMenu={(e) => {
        const sel = selectedText();
        const items: MenuEntry[] = [];
        if (sel) items.push({ label: "선택 영역 복사", shortcut: "Ctrl+C", onClick: () => copy(sel, "선택 영역") });
        items.push({ label: "파일 내용 복사", onClick: () => copy(content, "파일 내용") });
        items.push({ label: "파일 경로 복사", onClick: () => copy(path, "경로") });
        items.push("separator");
        items.push({ label: "IDE에서 열기", onClick: () => ws.requestOpenInIde(path) });
        openMenu(e, items);
      }}
    >
      <FilePreview path={path} content={content} />
      <ContextMenuView menu={menu} onClose={closeMenu} />
    </div>
  );
}

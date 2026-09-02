"use client";

import { useEffect, useState } from "react";
import { FilePreview } from "../FilePreview";
import { useWorkspace } from "../workspace";

/** 뷰어 — 아무 기능 없는 읽기 전용 파일 보기. 탐색기 더블클릭으로 열린다. */
export function ViewerApp({ path }: { path: string | null }) {
  const ws = useWorkspace();
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState("");

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
  return (
    <div className="h-full bg-white">
      <FilePreview path={path} content={content} />
    </div>
  );
}

"use client";

import { useEffect, useReducer, useRef } from "react";
import { ApiError } from "@/lib/api";
import { classifySaveError, FileSaver } from "@/lib/autosave";
import { useToast } from "@/components/toast";
import { useWorkspace, type WorkspaceCtxValue } from "./workspace";

/** 편집기 하나의 저장기 — 규칙은 lib/autosave 에 있고, 여기서는 워크스페이스와 화면에 잇는다.
 *
 *  - 쓰기·읽기는 워크스페이스 API 로 (조건부 저장 포함)
 *  - 상태가 바뀌면 다시 그린다 (상태 줄·충돌 띠·더티 표시)
 *  - 제출 직전 일괄 저장에 등록한다
 *  - 창이 닫혀도 남은 편집은 끝까지 저장하고, 그동안은 등록을 풀지 않는다 — 제출 확인창이
 *    그 파일 이름을 계속 말할 수 있어야 한다. 끝내 저장하지 못했으면(충돌·차단) 알린다.
 */
/** @param scoped 창 이름이 붙은 워크스페이스(useWorkspaceAs). 주지 않으면 이름 없이("ide") 저장된다 —
 *  문서·표의 자동 저장이 "ide" 로 남으면 채점이 어떤 앱으로 일했는지 되짚을 수 없다. */
export function useFileSaver(scoped?: WorkspaceCtxValue): FileSaver {
  const base = useWorkspace();
  const ws = scoped ?? base;
  const { toast } = useToast();
  const wsRef = useRef(ws);
  wsRef.current = ws;
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const saverRef = useRef<FileSaver | null>(null);
  if (!saverRef.current) {
    saverRef.current = new FileSaver({
      write: async (path, content, baseSha) => {
        const saved = await wsRef.current.saveContent(path, content, baseSha);
        return { sha256: saved.sha256 };
      },
      read: async (path) => {
        try {
          return await wsRef.current.loadContent(path);
        } catch (e) {
          if (e instanceof ApiError && e.status === 404) return null;
          throw e;
        }
      },
      classify: classifySaveError,
      onChange: () => rerender(),
    });
  }
  const saver = saverRef.current;

  useEffect(() => {
    const unregister = wsRef.current.registerEditor({
      dirtyPaths: () => saver.dirtyPaths(),
      flush: () => saver.flush(),
    });
    return () => {
      saver.retire((unsaved) => {
        unregister();
        if (unsaved.length > 0) {
          toastRef.current(`닫힌 편집기의 파일을 저장하지 못했습니다: ${unsaved.join(", ")}`, "error");
        }
      });
    };
  }, [saver]);

  return saver;
}

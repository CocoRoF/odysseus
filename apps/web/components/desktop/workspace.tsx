"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import type { FileContent, FileEntry, FileResetResult, InitialFileEntry } from "@/lib/types";

/** 워크스페이스 파일이 앱 밖에서 바뀌었을 때(되돌리기 등) 열린 앱들이 받는 알림.
 *  scope=all 이면 응시자가 만든 파일은 사라졌고 초기 파일은 원래 내용이다 — 열린 것 전부를 다시 읽어야 한다. */
export interface WorkspaceChange {
  reason: "reset";
  scope: "file" | "all";
  /** 내용이 바뀐(되돌려진) 경로들 */
  paths: string[];
}
export type WorkspaceChangeListener = (change: WorkspaceChange) => void;

/** 저장되지 않은 내용을 들고 있는 편집기 — IDE·문서·표가 각각 자기를 등록한다.
 *
 *  제출과 문제 전환은 **서버가 가진 파일**만 채점한다. 편집기 안에만 있는 글자는 존재하지
 *  않는 것과 같으므로, 그 경계를 넘기 전에 한 번 밀어 넣어야 한다. 편집기마다 제출 버튼을
 *  아는 대신, 여기에 등록해 두고 데스크톱이 일괄로 부른다. 저장 자체는 편집기의 저장기
 *  (lib/autosave.FileSaver)가 하므로 자동 저장과 같은 줄에 서서 순서가 뒤집히지 않는다.
 *  창이 닫힌 편집기는 남은 저장이 끝날 때까지 등록을 유지한다 (useFileSaver). */
export interface PendingEditor {
  /** 아직 서버에 없는 경로들 — 확인창이 이름을 보여줄 수 있게 */
  dirtyPaths: () => string[];
  /** 미저장 내용을 서버에 쓴다. **실패한 경로**를 돌려준다 (빈 배열이면 모두 저장됨) */
  flush: () => Promise<string[]>;
}

/** 파일을 건드릴 수 있는 창 — 서버의 desktop.FILE_ACTORS 와 같아야 한다.
 *
 *  어느 앱으로 일했는지는 채점 자료다. 문서로 쓴 글과 OdyCell 로 만든 표가 서버 기록에서 똑같이
 *  "ide" 로 보이면, "이 사람이 어떤 도구를 실제로 썼는가" 를 되짚을 방법이 없다. */
export type DesktopActor =
  | "ide"
  | "docs"
  | "sheet"
  | "files"
  | "mail"
  | "viewer"
  | "terminal"
  | "agent"
  | "github";

/** IDE·폴더·에이전트가 공유하는 워크스페이스 파일 상태 (시나리오 단위). */
export interface WorkspaceCtxValue {
  attemptId: string;
  scenarioId: string;
  files: FileEntry[];
  loading: boolean;
  refresh: () => Promise<void>;
  /** quiet — 목록 미리보기처럼 사람이 연 것이 아닌 읽기. 열람 기록을 남기지 않는다 */
  loadContent: (path: string, app?: DesktopActor, opts?: { quiet?: boolean }) => Promise<FileContent>;
  /** baseSha 를 주면 조건부 저장 — 서버가 그 사이 바뀌었으면 409 FILE_CHANGED/FILE_DELETED (lib/autosave) */
  saveContent: (path: string, content: string, baseSha?: string | null, app?: DesktopActor) => Promise<FileContent>;
  /** 메일 보내기 — 파일을 쓰는 일과 "보냈다" 를 남기는 일을 서버가 한 번에 한다.
   *
   *  메일 앱이 파일만 저장하고 보낸 사실은 브라우저가 따로 보고하면, 그 보고는 위조할 수 있고
   *  위조할 수 있는 값은 평가의 근거가 되지 못한다. 그래서 보내기만은 전용 엔드포인트를 지난다.
   *  저장된 내용(파일에 실제로 들어간 글)을 돌려준다. */
  sendMail: (mail: {
    to: string;
    cc: string;
    subject: string;
    body: string;
    path: string;
    quoted: boolean;
  }) => Promise<string>;
  deleteFile: (path: string, app?: DesktopActor) => Promise<void>;
  renameFile: (from: string, to: string, app?: DesktopActor) => Promise<void>;
  copyPath: (from: string, to: string, app?: DesktopActor) => Promise<void>;
  createFolder: (path: string, app?: DesktopActor) => Promise<void>;
  /** 폴더 앱 → IDE로 파일 열기 요청 (데스크톱이 IDE 창을 띄우고 전달) */
  requestOpenInIde: (path: string) => void;
  /** 폴더/뷰어 → 문서 편집기로 열기 요청 */
  requestOpenInDocs: (path: string) => void;
  /** 폴더/뷰어 → 표 편집기로 열기 요청 */
  requestOpenInSheet: (path: string) => void;
  /** 더블클릭 → 읽기 전용 뷰어 앱으로 열기 */
  openInViewer: (path: string) => void;
  /** 시나리오가 처음 제공한 파일 경로 — 이 파일만 "초기 내용으로 되돌리기"가 가능하다 */
  initialPaths: string[];
  isInitial: (path: string) => boolean;
  /** 파일 하나를 초기 내용으로 되돌린다. 되돌린 내용을 돌려준다 */
  resetFile: (path: string) => Promise<string>;
  /** 워크스페이스 전체를 초기 상태로 — 응시자가 만든 파일은 지워지고 초기 파일은 원래 내용이 된다 */
  resetAll: () => Promise<FileResetResult>;
  /** 되돌리기처럼 앱 밖에서 파일이 바뀌었을 때 열린 문서를 갱신하려면 구독한다 */
  subscribeChanges: (fn: WorkspaceChangeListener) => () => void;
  /** 저장되지 않은 내용을 들고 있는 편집기를 등록한다. 해제 함수를 돌려준다 */
  registerEditor: (editor: PendingEditor) => () => void;
  /** 열린 편집기 전부의 미저장 내용을 서버로 밀어 넣는다. 실패한 경로를 돌려준다 */
  flushPending: () => Promise<string[]>;
  /** 지금 서버에 없는 편집 내용의 경로 — 제출 확인창이 읽는다 */
  pendingPaths: () => string[];
  /** 이 시나리오가 실제로 제공하는 앱인가.
   *
   *  시나리오는 어떤 앱을 띄울지 스스로 정한다(desktop_apps). 그런데 폴더·뷰어처럼 "다른 앱으로 열기"
   *  를 권하는 화면이 그 사실을 모르면, 열리지도 않는 [IDE] 단추를 내민다 — 눌러도 아무 일이 없는
   *  단추는 없느니만 못하다. 그래서 그 판단을 워크스페이스가 들고 다니며 누구든 물어볼 수 있게 한다. */
  appAvailable: (app: string) => boolean;
  /** IDE가 소비할 대기 중 열기 요청 */
  pendingIdeOpen: string | null;
  consumeIdeOpen: () => void;
  /** 문서 편집기가 소비할 대기 중 열기 요청. 여러 창이 떠 있어도 **한 창만** 가져간다 */
  pendingDocsOpen: string | null;
  takeDocsOpen: () => string | null;
  /** 표 편집기가 소비할 대기 중 열기 요청. 여러 창이 떠 있어도 **한 창만** 가져간다 */
  pendingSheetOpen: string | null;
  takeSheetOpen: () => string | null;
  /** 이 창이 지금 어떤 파일을 열고 있는지 등록한다 (null = 놓는다).
   *
   *  같은 파일을 두 창이 동시에 편집하면 2초 자동 저장이 서로의 전문을 덮어써서, 나중에
   *  건드린 창의 내용만 남고 다른 쪽 작업이 조용히 사라진다. 그래서 파일 하나는 창 하나만
   *  갖는다 — OS 의 문서 편집기가 같은 파일을 두 번 열지 않고 열려 있던 창을 올려 주는 것과 같다. */
  claimFile: (winId: string, path: string | null) => void;
  /** 그 파일을 이미 열고 있는 **다른** 창의 id. 없으면 null */
  fileOwner: (path: string, exceptWinId?: string) => string | null;
  /** 그 창을 앞으로 가져온다 (데스크톱이 내려 준다) */
  focusWindow: (winId: string) => void;
}

export interface PendingEdits {
  registerEditor: (editor: PendingEditor) => () => void;
  flushPending: () => Promise<string[]>;
  pendingPaths: () => string[];
}

/** 미저장 편집기 레지스트리.
 *
 *  훅으로 떼어 둔 이유는 **제출 버튼이 WorkspaceProvider 바깥에 있기 때문**이다. 시험
 *  데스크톱은 provider 안에서 편집기를 그리지만 [시험 종료]·[다음 문제로]는 그 위에 있다.
 *  페이지가 이 훅으로 레지스트리를 소유하고 provider 에 내려 주면, 양쪽이 같은 목록을 본다. */
export function usePendingEdits(): PendingEdits {
  const editorsRef = useRef<Set<PendingEditor>>(new Set());

  const registerEditor = useCallback((editor: PendingEditor) => {
    editorsRef.current.add(editor);
    return () => {
      editorsRef.current.delete(editor);
    };
  }, []);

  const pendingPaths = useCallback(() => {
    const out = new Set<string>();
    for (const e of editorsRef.current) {
      try {
        e.dirtyPaths().forEach((p) => out.add(p));
      } catch {
        /* 한 편집기의 오류가 나머지를 가리지 않는다 */
      }
    }
    return [...out];
  }, []);

  const flushPending = useCallback(async () => {
    // 한 편집기가 실패해도 나머지는 저장한다 — 제출 직전이라 부분 저장이 무저장보다 낫다.
    const results = await Promise.allSettled([...editorsRef.current].map((e) => e.flush()));
    const failed = new Set<string>();
    for (const r of results) {
      if (r.status === "fulfilled") r.value.forEach((p) => failed.add(p));
    }
    // 거부된 편집기는 어느 경로가 실패했는지 말하지 못한다. 남아 있는 더티 경로로 메운다.
    if (results.some((r) => r.status === "rejected")) pendingPaths().forEach((p) => failed.add(p));
    return [...failed];
  }, [pendingPaths]);

  return useMemo(
    () => ({ registerEditor, flushPending, pendingPaths }),
    [registerEditor, flushPending, pendingPaths],
  );
}

const Ctx = createContext<WorkspaceCtxValue | null>(null);

export function useWorkspace(): WorkspaceCtxValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("WorkspaceProvider missing");
  return v;
}

/** 이 앱의 이름으로 워크스페이스를 쓴다 — 앱은 한 줄만 바꾸면 된다.
 *
 *  호출마다 "나는 문서요" 를 손으로 붙이게 하면 언젠가 한 군데를 빠뜨리고, 그 한 군데가 조용히
 *  "ide" 로 기록된다. 창이 자기 이름을 한 번 말하고 나면 그 창의 모든 읽기·쓰기가 그 이름으로
 *  남는다 — 자동 저장(lib/autosave)도 이 함수를 받아 쓰므로 같이 따라온다.
 */
export function useWorkspaceAs(app: DesktopActor): WorkspaceCtxValue {
  const ws = useWorkspace();
  // 감싼 함수의 정체성은 **밑의 함수**에만 묶는다. 문맥 값(ws)은 파일 목록이 갱신될 때마다(10초)
  // 새 객체가 되므로, 거기에 묶으면 `[ws.loadContent]` 를 의존성으로 둔 효과들이 10초마다 다시 돈다.
  const { loadContent, saveContent, deleteFile, renameFile, copyPath, createFolder } = ws;
  const bound = useMemo(
    () => ({
      loadContent: (path: string, _app?: DesktopActor, opts?: { quiet?: boolean }) => loadContent(path, app, opts),
      saveContent: (path: string, content: string, baseSha: string | null = null) =>
        saveContent(path, content, baseSha, app),
      deleteFile: (path: string) => deleteFile(path, app),
      renameFile: (from: string, to: string) => renameFile(from, to, app),
      copyPath: (from: string, to: string) => copyPath(from, to, app),
      createFolder: (path: string) => createFolder(path, app),
    }),
    [loadContent, saveContent, deleteFile, renameFile, copyPath, createFolder, app],
  );
  return useMemo(() => ({ ...ws, ...bound }), [ws, bound]);
}

/** 파일 목록을 스스로 다시 읽는 간격. 목록은 내용을 담지 않아 가볍다. */
const WORKSPACE_POLL_MS = 10_000;

export function WorkspaceProvider({
  attemptId,
  scenarioId,
  onOpenIde,
  onOpenDocs,
  onOpenSheet,
  onOpenViewer,
  onFocusWindow,
  appAvailable,
  pendingEdits,
  children,
}: {
  attemptId: string;
  scenarioId: string;
  /** 이 시험이 제공하는 앱인가 — 주지 않으면 전부 있는 것으로 본다(리뷰 화면 등) */
  appAvailable?: (app: string) => boolean;
  onOpenIde: () => void;
  onOpenDocs?: () => void;
  onOpenSheet?: () => void;
  onOpenViewer?: (path: string) => void;
  /** 창 하나를 앞으로 — 같은 파일을 이미 연 창으로 데려갈 때 쓴다 */
  onFocusWindow?: (winId: string) => void;
  /** 제출 버튼이 provider 바깥에 있는 시험 데스크톱은 자기 레지스트리를 내려 준다.
   *  주지 않으면(리뷰 화면 등) 안에서 하나 만들어 쓴다 — 동작은 같고 바깥이 못 부를 뿐이다. */
  pendingEdits?: PendingEdits;
  children: React.ReactNode;
}) {
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [pendingIdeOpen, setPendingIdeOpen] = useState<string | null>(null);
  const [pendingDocsOpen, setPendingDocsOpen] = useState<string | null>(null);
  const [pendingSheetOpen, setPendingSheetOpen] = useState<string | null>(null);
  const [initialPaths, setInitialPaths] = useState<string[]>([]);
  const listenersRef = useRef<Set<WorkspaceChangeListener>>(new Set());
  const ownPendingEdits = usePendingEdits();

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

  /** 파일 목록을 스스로 다시 읽는다 — 이 컴퓨터는 나 말고도 쓰는 사람이 있다.
   *
   *  AI 에이전트와 터미널은 일을 끝내고 스스로 알려 주지만(ws.refresh), 그 둘만이 파일을 바꾸는 것은
   *  아니다. 러너가 남긴 산출물, 다른 창에서 한 저장, 관리자 조치까지 — 알려 줄 사람이 없는 변화가 있다.
   *  목록은 내용 없이 경로·크기·해시뿐이라 가볍고, 여기서 새 해시를 본 앱이 알아서 판단한다
   *  (편집 중인 파일은 건드리지 않고 충돌 띠를 띄운다).
   *
   *  탭이 숨겨져 있으면 쉰다. 보이지 않는 화면을 위해 서버를 두드릴 이유가 없다.
   */
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "hidden") return;
      refresh().catch(() => undefined);
    };
    const timer = setInterval(tick, WORKSPACE_POLL_MS);
    // 다른 창에서 일을 보고 돌아왔다면 기다리지 않고 바로 맞춘다
    document.addEventListener("visibilitychange", tick);
    window.addEventListener("focus", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
      window.removeEventListener("focus", tick);
    };
  }, [refresh]);

  // 초기 파일 목록은 응시 정의에 고정되어 있어 한 번만 읽으면 된다. 못 읽으면 되돌리기만 없는 것으로 본다.
  useEffect(() => {
    let alive = true;
    api
      .get<InitialFileEntry[]>(`${base}/files/initial`)
      .then((rows) => {
        if (alive) setInitialPaths(rows.map((r) => r.path));
      })
      .catch(() => {
        if (alive) setInitialPaths([]);
      });
    return () => {
      alive = false;
    };
  }, [base]);

  const subscribeChanges = useCallback((fn: WorkspaceChangeListener) => {
    listenersRef.current.add(fn);
    return () => {
      listenersRef.current.delete(fn);
    };
  }, []);

  const { registerEditor, flushPending, pendingPaths } = pendingEdits ?? ownPendingEdits;

  const notify = useCallback((change: WorkspaceChange) => {
    for (const fn of listenersRef.current) {
      try {
        fn(change);
      } catch {
        /* 한 앱의 실패가 다른 앱의 갱신을 막지 않는다 */
      }
    }
  }, []);

  const isInitial = useCallback((path: string) => initialPaths.includes(path), [initialPaths]);

  const resetFile = useCallback(
    async (path: string) => {
      const res = await api.post<FileResetResult>(`${base}/files/reset`, { path });
      await refresh();
      notify({ reason: "reset", scope: "file", paths: res.paths });
      return res.content ?? "";
    },
    [base, refresh, notify],
  );

  const resetAll = useCallback(async () => {
    const res = await api.post<FileResetResult>(`${base}/files/reset`, {});
    await refresh();
    notify({ reason: "reset", scope: "all", paths: res.paths });
    return res;
  }, [base, refresh, notify]);

  const loadContent = useCallback(
    (path: string, app: DesktopActor = "ide", opts?: { quiet?: boolean }) =>
      api.get<FileContent>(
        `${base}/files/content?path=${encodeURIComponent(path)}&app=${app}${opts?.quiet ? "&quiet=1" : ""}`,
      ),
    [base],
  );

  const saveContent = useCallback(
    async (path: string, content: string, baseSha: string | null = null, app: DesktopActor = "ide") => {
      const saved = await api.put<FileContent>(
        `${base}/files/content`,
        baseSha ? { path, content, base_sha256: baseSha, app } : { path, content, app },
      );
      // 목록 갱신이 실패해도 저장은 이미 끝났다 — 여기서 던지면 멀쩡히 저장된 파일을 "저장 실패" 라고 한다
      await refresh().catch(() => undefined);
      return saved;
    },
    [base, refresh],
  );

  const sendMail = useCallback(
    async (mail: {
      to: string;
      cc: string;
      subject: string;
      body: string;
      path: string;
      quoted: boolean;
    }) => {
      const sent = await api.post<{ path: string; content: string }>(`${base}/mail`, mail);
      await refresh().catch(() => undefined);
      return sent.content;
    },
    [base, refresh],
  );

  const deleteFile = useCallback(
    async (path: string, app: DesktopActor = "ide") => {
      await api.del(`${base}/files?path=${encodeURIComponent(path)}&app=${app}`);
      await refresh();
    },
    [base, refresh],
  );

  const renameFile = useCallback(
    async (from: string, to: string, app: DesktopActor = "ide") => {
      await api.post(`${base}/files/rename`, { from_path: from, to_path: to, app });
      await refresh();
    },
    [base, refresh],
  );

  const copyPath = useCallback(
    async (from: string, to: string, app: DesktopActor = "ide") => {
      await api.post(`${base}/files/copy`, { from_path: from, to_path: to, app });
      await refresh();
    },
    [base, refresh],
  );

  /** 빈 폴더는 .keep 플레이스홀더로 표현한다 (워크스페이스가 경로 기반이라 디렉터리 엔트리가 없음). */
  const createFolder = useCallback(
    async (path: string, app: DesktopActor = "ide") => {
      await api.put(`${base}/files/content`, { path: `${path.replace(/\/+$/, "")}/${KEEP_NAME}`, content: "", app });
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

  const requestOpenInDocs = useCallback(
    (path: string) => {
      setPendingDocsOpen(path);
      onOpenDocs?.();
    },
    [onOpenDocs],
  );

  // 열기 요청은 ref 로 한 번만 넘겨준다. state 만 쓰면 같은 렌더에서 문서 창 두 개가
  // 모두 같은 값을 읽어 같은 파일을 두 번 연다.
  const docsOpenRef = useRef<string | null>(null);
  docsOpenRef.current = pendingDocsOpen;
  const takeDocsOpen = useCallback(() => {
    const wanted = docsOpenRef.current;
    docsOpenRef.current = null;
    setPendingDocsOpen(null);
    return wanted;
  }, []);

  const requestOpenInSheet = useCallback(
    (path: string) => {
      setPendingSheetOpen(path);
      onOpenSheet?.();
    },
    [onOpenSheet],
  );

  const sheetOpenRef = useRef<string | null>(null);
  sheetOpenRef.current = pendingSheetOpen;
  const takeSheetOpen = useCallback(() => {
    const wanted = sheetOpenRef.current;
    sheetOpenRef.current = null;
    setPendingSheetOpen(null);
    return wanted;
  }, []);

  /** 파일 점유 등록부 — {창 id: 그 창이 연 경로}. 그리기와 무관하므로 ref 로 둔다. */
  const claimsRef = useRef<Map<string, string>>(new Map());
  const claimFile = useCallback((winId: string, path: string | null) => {
    if (path) claimsRef.current.set(winId, path);
    else claimsRef.current.delete(winId);
  }, []);
  const fileOwner = useCallback((path: string, exceptWinId?: string) => {
    for (const [win, held] of claimsRef.current) {
      if (held === path && win !== exceptWinId) return win;
    }
    return null;
  }, []);
  const focusWindow = useCallback((winId: string) => onFocusWindow?.(winId), [onFocusWindow]);

  const openInViewer = useCallback(
    (path: string) => {
      onOpenViewer?.(path);
    },
    [onOpenViewer],
  );

  const value = useMemo(
    () => ({
      attemptId,
      scenarioId,
      files,
      loading,
      refresh,
      loadContent,
      saveContent,
      sendMail,
      deleteFile,
      renameFile,
      copyPath,
      createFolder,
      requestOpenInIde,
      requestOpenInDocs,
      requestOpenInSheet,
      openInViewer,
      initialPaths,
      isInitial,
      resetFile,
      resetAll,
      subscribeChanges,
      registerEditor,
      flushPending,
      pendingPaths,
      appAvailable: appAvailable ?? (() => true),
      pendingIdeOpen,
      consumeIdeOpen,
      pendingDocsOpen,
      takeDocsOpen,
      pendingSheetOpen,
      takeSheetOpen,
      claimFile,
      fileOwner,
      focusWindow,
    }),
    [
      attemptId,
      scenarioId,
      files,
      loading,
      refresh,
      loadContent,
      saveContent,
      sendMail,
      deleteFile,
      renameFile,
      copyPath,
      createFolder,
      requestOpenInIde,
      requestOpenInDocs,
      requestOpenInSheet,
      openInViewer,
      initialPaths,
      isInitial,
      resetFile,
      resetAll,
      subscribeChanges,
      registerEditor,
      flushPending,
      pendingPaths,
      appAvailable,
      pendingIdeOpen,
      consumeIdeOpen,
      pendingDocsOpen,
      takeDocsOpen,
      pendingSheetOpen,
      takeSheetOpen,
      claimFile,
      fileOwner,
      focusWindow,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

// ── 파일 트리 유틸 ───────────────────────────────────────────

/** 빈 폴더 유지용 플레이스홀더 — UI/에이전트 목록에서는 감춘다. */
export const KEEP_NAME = ".keep";

/** 새 파일 이름 칸에 처음 들어갔을 때 고를 범위 — OS 의 "이름 바꾸기" 와 같다.
 *
 *  기본값(`output/새 문서.md`)이 들어 있는 칸에 그냥 포커스만 주면 커서가 끝에 붙어서,
 *  바로 타이핑한 사람은 `output/새 문서.md회의록` 을 만들게 된다. 폴더 경로와 확장자는
 *  두고 **파일명만** 골라 두면 첫 글자가 그 자리를 덮는다. */
export function selectFileStem(el: HTMLInputElement): void {
  const value = el.value;
  const start = value.lastIndexOf("/") + 1;
  const dot = value.lastIndexOf(".");
  const end = dot > start ? dot : value.length;
  try {
    el.setSelectionRange(start, end);
  } catch {
    el.select();
  }
}

/** 새로 만들 파일 경로 검사. 통과하면 정규화한 경로를, 아니면 사람이 읽을 사유를 돌려준다.
 *
 *  확장자까지 보는 이유: 문서·표 앱은 확장자로 목록을 거르므로, 확장자가 틀린 파일은
 *  만들어져도 그 앱에 **보이지 않는다**. 채점도 경로로 찾으므로 조용히 어긋난 이름은
 *  응시자가 알아챌 방법이 없다. 만들기 전에 막는 편이 낫다. */
export function checkNewPath(raw: string, exts: string[]): { path: string } | { error: string } {
  const path = raw.trim().replace(/^\/+/, "").trim();
  if (!path) return { error: "파일 이름을 입력하세요" };
  if (path.length > 200) return { error: "파일 이름이 너무 깁니다" };
  if (path.endsWith("/")) return { error: "폴더가 아니라 파일 이름으로 끝나야 합니다" };
  if (path.includes("\\")) return { error: "경로 구분은 / 로 적어 주세요" };
  const segments = path.split("/");
  if (segments.some((seg) => seg === "" || seg === "." || seg === ".."))
    return { error: "경로에 쓸 수 없는 이름이 있습니다" };
  if ([...path].some((ch) => ch.charCodeAt(0) < 32) || /[:*?"<>|]/.test(path))
    return { error: "파일 이름에 쓸 수 없는 문자가 있습니다" };
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (!path.includes(".") || !exts.includes(ext))
    return { error: `${exts.map((e) => "." + e).join(" 또는 ")} 로 끝나는 이름이어야 합니다` };
  return { path };
}

export function isKeepPath(path: string): boolean {
  return path.split("/").pop() === KEEP_NAME;
}

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
  // .keep 리프는 제거 — 폴더 노드는 남으므로 빈 폴더가 유지된다
  const prune = (n: TreeNode) => {
    n.children = n.children.filter((c) => c.isDir || c.name !== KEEP_NAME);
    n.children.forEach(prune);
  };
  prune(root);
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

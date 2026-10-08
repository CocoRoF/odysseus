"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { api, ApiError } from "@/lib/api";
import type { Attempt, AttemptScenario, ReferenceConfig } from "@/lib/types";
import { useToast } from "@/components/toast";
import { homeFor, useUser } from "@/components/useUser";
import { COPY_EVENT } from "@/lib/clipboard";
import { Button, Spinner } from "@/components/ui";
import {
  IconAgent,
  IconCheck,
  IconClock,
  IconDocs,
  IconFile,
  IconFolder,
  IconGithub,
  IconIde,
  IconMail,
  IconMessenger,
  IconSheet,
  IconTerminal,
} from "@/components/icons";
import { useWindowManager, AppId, MULTI_INSTANCE_APPS } from "@/components/desktop/wm";
import { Window, APP_META } from "@/components/desktop/Window";
import { Taskbar } from "@/components/desktop/Taskbar";
import { WorkspaceProvider, usePendingEdits } from "@/components/desktop/workspace";
import { AgentSessionProvider } from "@/components/desktop/agentSession";
import { TerminalSessionProvider } from "@/components/desktop/terminalSession";
import { MessengerSessionProvider, useMessengerSessionOptional } from "@/components/desktop/messengerSession";
import { IntroCinematic } from "@/components/desktop/IntroCinematic";
import { BootSequence } from "@/components/desktop/BootSequence";
import { BriefingModal } from "@/components/desktop/BriefingModal";
import { ConnectionBanner } from "@/components/desktop/ConnectionBanner";
import { DuplicateTabBanner } from "@/components/desktop/DuplicateTabBanner";
import { SessionLostBanner } from "@/components/desktop/SessionLostBanner";
import { SystemInfoModal } from "@/components/desktop/SystemInfoModal";
import { Watermark } from "@/components/desktop/Watermark";
import {
  AppSwitcherOverlay,
  keyboardLockSupported,
  requestDesktopFullscreen,
  useAppSwitcher,
  useFullscreenKeyboardLock,
} from "@/components/desktop/AppSwitcher";
import { ContextMenuView, MenuEntry, useContextMenu } from "@/components/desktop/ContextMenu";
import { MessengerApp } from "@/components/desktop/apps/MessengerApp";
import { ViewerApp } from "@/components/desktop/apps/ViewerApp";
import { IdeApp } from "@/components/desktop/apps/IdeApp";
import { AgentApp } from "@/components/desktop/apps/AgentApp";
import { FilesApp } from "@/components/desktop/apps/FilesApp";
import { TerminalApp } from "@/components/desktop/apps/TerminalApp";
import { GithubApp } from "@/components/desktop/apps/GithubApp";
import { DocsApp } from "@/components/desktop/apps/DocsApp";
import { SheetApp } from "@/components/desktop/apps/SheetApp";
import { MailApp } from "@/components/desktop/apps/MailApp";

const ICONS: { id: AppId; label: string; icon: React.ReactNode; tile: string; glow: string }[] = [
  {
    id: "terminal",
    label: "터미널",
    icon: <IconTerminal size={30} />,
    tile: "from-neutral-700 via-neutral-800 to-black",
    glow: "group-hover:shadow-[0_0_26px_rgba(163,163,163,0.4)]",
  },
  {
    id: "files",
    label: "폴더",
    icon: <IconFolder size={30} />,
    tile: "from-amber-400 via-amber-500 to-orange-600",
    glow: "group-hover:shadow-[0_0_26px_rgba(251,191,36,0.55)]",
  },
  {
    id: "messenger",
    label: "메신저",
    icon: <IconMessenger size={30} />,
    tile: "from-violet-400 via-violet-500 to-fuchsia-600",
    glow: "group-hover:shadow-[0_0_26px_rgba(167,139,250,0.55)]",
  },
  {
    id: "mail",
    label: "메일",
    icon: <IconMail size={30} />,
    tile: "from-rose-400 via-rose-500 to-pink-600",
    glow: "group-hover:shadow-[0_0_26px_rgba(251,113,133,0.55)]",
  },
  {
    id: "docs",
    label: "문서",
    icon: <IconDocs size={30} />,
    tile: "from-sky-400 via-blue-500 to-indigo-600",
    glow: "group-hover:shadow-[0_0_26px_rgba(96,165,250,0.55)]",
  },
  {
    id: "sheet",
    label: "OdyCell",
    icon: <IconSheet size={30} />,
    tile: "from-emerald-400 via-green-500 to-teal-600",
    glow: "group-hover:shadow-[0_0_26px_rgba(52,211,153,0.55)]",
  },
  {
    id: "ide",
    label: "IDE",
    icon: <IconIde size={30} />,
    tile: "from-slate-500 via-slate-600 to-slate-800",
    glow: "group-hover:shadow-[0_0_26px_rgba(148,163,184,0.45)]",
  },
  {
    id: "agent",
    label: "AI 에이전트",
    icon: <IconAgent size={30} />,
    tile: "from-sky-400 via-sky-500 to-blue-600",
    glow: "group-hover:shadow-[0_0_26px_rgba(56,189,248,0.55)]",
  },
  {
    id: "github",
    label: "GitHub",
    icon: <IconGithub size={30} />,
    tile: "from-slate-600 via-slate-800 to-slate-950",
    glow: "group-hover:shadow-[0_0_26px_rgba(148,163,184,0.5)]",
  },
];

/** 응시 중 행동 이벤트 배치 기록 (포커스/가시성/네트워크/캡처 키) */
function useActivityTracker(attemptId: string, active: boolean, scenarioId: string | null) {
  const queue = useRef<{ type: string; scenario_id: string | null; payload: Record<string, unknown> }[]>([]);
  const scenarioRef = useRef(scenarioId);
  scenarioRef.current = scenarioId;
  // 순서 번호·클라이언트 id — 서버가 중복을 버리고 빈틈을 기록한다 (ODY-017). 세션(탭) 단위로 이어진다.
  const seqRef = useRef(0);
  const clientIdRef = useRef<string>("");
  if (!clientIdRef.current) {
    try {
      const key = `odysseus:telemetry:${attemptId}`;
      const saved = sessionStorage.getItem(key);
      if (saved) {
        const parsed = JSON.parse(saved) as { id: string; seq: number };
        clientIdRef.current = parsed.id;
        seqRef.current = parsed.seq;
      } else {
        clientIdRef.current = Math.random().toString(36).slice(2, 10);
      }
    } catch {
      clientIdRef.current = Math.random().toString(36).slice(2, 10);
    }
  }

  const push = useCallback((type: string, payload: Record<string, unknown> = {}) => {
    seqRef.current += 1;
    try {
      sessionStorage.setItem(`odysseus:telemetry:${attemptId}`, JSON.stringify({ id: clientIdRef.current, seq: seqRef.current }));
    } catch {
      /* 저장 실패는 무시 */
    }
    queue.current.push({ type, scenario_id: scenarioRef.current, payload: { ...payload, seq: seqRef.current, client_id: clientIdRef.current } });
  }, [attemptId]);

  useEffect(() => {
    if (!active) return;
    const flush = () => {
      if (queue.current.length === 0) return;
      const events = queue.current.splice(0, 50);
      api.post(`/attempts/${attemptId}/events`, { events }).catch(() => undefined);
    };
    const interval = setInterval(flush, 5000);

    let hiddenAt: number | null = null;
    const onVisibility = () => {
      if (document.hidden) {
        hiddenAt = Date.now();
        push("tab_hidden");
      } else {
        push("tab_visible", hiddenAt ? { away_ms: Date.now() - hiddenAt } : {});
        hiddenAt = null;
      }
    };
    let blurAt: number | null = null;
    const onBlur = () => {
      blurAt = Date.now();
      push("window_blur");
    };
    const onFocus = () => {
      push("window_focus", blurAt ? { away_ms: Date.now() - blurAt } : {});
      blurAt = null;
    };
    const onOffline = () => push("net_offline");
    const onOnline = () => push("net_online");
    // 복사/잘라내기 — 평가용 무결성 신호 (선택 복사, 앱 내부 복사 버튼 모두)
    const recordCopy = (type: "copy" | "cut", text: string) => {
      const trimmed = (text ?? "").trim();
      if (!trimmed) return;
      push(type, { chars: trimmed.length });
    };
    const onCopy = () => recordCopy("copy", window.getSelection()?.toString() ?? "");
    const onCut = () => recordCopy("cut", window.getSelection()?.toString() ?? "");
    const onAppCopy = (e: Event) =>
      recordCopy("copy", String((e as CustomEvent<{ text?: string }>).detail?.text ?? ""));
    // 붙여넣기 — 복사·잘라내기는 세면서 이것만 빠져 있었다. 시험장 밖에서 가져온 글이 있었는지는
    // 무결성 신호 중에서도 가장 먼저 보게 되는 것이라, 글자 수만이라도 남겨야 한다.
    // (내용은 보내지 않는다. 서버도 chars 말고는 저장하지 않는다 — ODY-017)
    const onPaste = (e: ClipboardEvent) => {
      const text = (e.clipboardData?.getData("text") ?? "").trim();
      if (text) push("paste", { chars: text.length });
    };
    // 화면 캡처 키 — 브라우저가 캡처 자체를 막을 수는 없지만 눌린 사실은 남는다.
    // Windows 는 PrintScreen 의 keydown 을 페이지에 주지 않고 keyup 만 준다. 둘 다 듣되 한 번만 센다.
    let lastShot = 0;
    const recordShot = (e: KeyboardEvent, source: string) => {
      if (e.key !== "PrintScreen" && e.code !== "PrintScreen") return;
      const now = Date.now();
      if (now - lastShot < 500) return;
      lastShot = now;
      push("screenshot_key", { source });
    };
    const onKeyDownShot = (e: KeyboardEvent) => recordShot(e, "keydown");
    const onKeyUpShot = (e: KeyboardEvent) => recordShot(e, "keyup");
    const onExit = () => {
      push("page_exit");
      if (queue.current.length) {
        const events = queue.current.splice(0, 50);
        navigator.sendBeacon?.(
          `/api/attempts/${attemptId}/events`,
          new Blob([JSON.stringify({ events })], { type: "application/json" }),
        );
      }
    };

    push("page_enter");
    document.addEventListener("visibilitychange", onVisibility);
    document.addEventListener("copy", onCopy);
    document.addEventListener("cut", onCut);
    document.addEventListener("paste", onPaste);
    window.addEventListener(COPY_EVENT, onAppCopy);
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);
    window.addEventListener("keydown", onKeyDownShot);
    window.addEventListener("keyup", onKeyUpShot);
    window.addEventListener("pagehide", onExit);
    return () => {
      flush();
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
      document.removeEventListener("copy", onCopy);
      document.removeEventListener("cut", onCut);
      document.removeEventListener("paste", onPaste);
      window.removeEventListener(COPY_EVENT, onAppCopy);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("keydown", onKeyDownShot);
      window.removeEventListener("keyup", onKeyUpShot);
      window.removeEventListener("pagehide", onExit);
    };
  }, [attemptId, active, push]);

  return push;
}

function FinishedScreen({ attempt, router }: { attempt: Attempt; router: ReturnType<typeof useRouter> }) {
  // 끝난 시험은 결과 화면이 이어받는다 — 게스트에게는 그 화면이 마지막 화면이다 (app/result).
  useEffect(() => {
    router.replace(`/result/${attempt.id}`);
  }, [attempt.id, router]);
  return (
    <div className="desktop-wallpaper flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-md rounded-2xl bg-white p-8 text-center shadow-2xl">
        <span
          className={`mx-auto flex h-12 w-12 items-center justify-center rounded-full ${
            attempt.status === "submitted" ? "bg-emerald-50 text-emerald-600" : "bg-amber-50 text-amber-600"
          }`}
        >
          {attempt.status === "submitted" ? <IconCheck size={24} /> : <IconClock size={24} />}
        </span>
        <h1 className="mt-4 text-xl font-bold">
          {attempt.status === "submitted" ? "시험이 제출되었습니다" : "시험 시간이 만료되었습니다"}
        </h1>
        <p className="mt-2 text-sm text-slate-500">{attempt.assessment_title} — 결과를 준비하고 있습니다.</p>
      </div>
    </div>
  );
}

/** 바탕화면 메신저 아이콘의 읽지 않음 배지 — 세션이 세는 값을 그대로 쓴다 */
function MessengerUnreadBadge() {
  const session = useMessengerSessionOptional();
  const unread = session?.unreadTotal ?? 0;
  if (unread <= 0) return null;
  return (
    <span className="absolute -right-1.5 -top-1.5 flex h-5 min-w-5 items-center justify-center rounded-full border-2 border-slate-900/40 bg-red-500 px-1 text-[10px] font-bold text-white shadow">
      {unread > 99 ? "99+" : unread}
    </span>
  );
}

/** 마감 몇 ms 전에 편집 내용을 미리 저장하는가 */
const PRE_DEADLINE_FLUSH_MS = 15_000;
/** 제출·문제 전환·연결 복구 때 저장을 기다리는 최대 시간 */
const SUBMIT_FLUSH_TIMEOUT_MS = 8_000;
/** PC 시계 오차가 이만큼 넘게 바뀌면 남은 시간을 다시 센다 */
const CLOCK_RESYNC_MS = 2_000;

export default function ExamDesktopPage() {
  const params = useParams<{ attemptId: string }>();
  const attemptId = params.attemptId;
  const router = useRouter();
  const { toast, confirm } = useToast();
  const { user } = useUser(["candidate", "admin", "evaluator", "guest"]);

  const [attempt, setAttempt] = useState<Attempt | null>(null);
  /** 서버 시각 - PC 시각 (ms). 마감은 서버가 판정하므로 남은 시간도 서버 시계로 센다 */
  const clockSkewRef = useRef(0);
  /** 응답의 server_now 로 오차를 다시 잰다. 크게 바뀌었으면 true */
  const syncClock = useCallback((a: Attempt) => {
    const at = Date.parse(a.server_now ?? "");
    if (!Number.isFinite(at)) return false;
    const skew = at - Date.now();
    const moved = Math.abs(skew - clockSkewRef.current) > CLOCK_RESYNC_MS;
    clockSkewRef.current = skew;
    return moved;
  }, []);
  const serverNow = useCallback(() => Date.now() + clockSkewRef.current, []);
  const [error, setError] = useState("");
  const [showBriefing, setShowBriefing] = useState(false);
  // 브리핑 다시 보기 — 시작 뒤에도 언제든 상황 설명을 다시 읽을 수 있다
  const [briefingReview, setBriefingReview] = useState(false);
  // 시네마틱 모드: [임무 시작] → 부팅 연출 → 데스크톱
  const [booting, setBooting] = useState(false);
  const [selectedIcon, setSelectedIcon] = useState<AppId | null>(null);
  // 참고 자료 앱(GitHub)은 관리자 설정으로 끌 수 있다 — 꺼졌으면 아이콘부터 없앤다
  const [reference, setReference] = useState<ReferenceConfig | null>(null);
  // 뷰어 인스턴스 id -> 그 창이 보여주는 파일 경로
  const [viewerPaths, setViewerPaths] = useState<Record<string, string>>({});
  const [systemInfoOpen, setSystemInfoOpen] = useState(false);
  const { menu: deskMenu, open: openDeskMenu, close: closeDeskMenu } = useContextMenu();
  // 편집기의 미저장 내용 — 제출·문제 전환 버튼이 provider 바깥에 있으므로 페이지가 소유한다.
  const pendingEdits = usePendingEdits();

  const inProgress = attempt?.status === "in_progress";
  // 순차 진행 — 현재 문제는 서버의 current_ordinal 이 정한다 (임의 이동 불가)
  const scenario: AttemptScenario | null = useMemo(
    () => attempt?.scenarios.find((s) => s.ordinal === attempt.current_ordinal) ?? null,
    [attempt],
  );
  const scenarioId = scenario?.scenario_id ?? null;
  const hasNext = Boolean(
    attempt && attempt.current_ordinal < attempt.scenarios.length - 1,
  );
  const pushEvent = useActivityTracker(attemptId, Boolean(inProgress), scenarioId);

  // 이 문제에서 제공되는 앱 — 시나리오가 목록을 지정하지 않았으면 전부 제공한다.
  // (사무 시나리오는 터미널·IDE 없이 문서/표로 일한다. 도구가 곧 문제의 성격이다.)
  //
  // 단, `desktop_apps` 가 **관장하지 않는** 앱은 이 목록으로 판정하지 않는다. 서버의
  // OPTIONAL_APPS 에는 메신저·에이전트·뷰어가 없고(메신저는 문제를 제시하는 수단 자체,
  // 에이전트는 agent_enabled 가, 뷰어는 탐색기가 연다), 서버는 목록이 비어 있으면
  // OPTIONAL_APPS 를 통째로 돌려준다. 그래서 "비면 전부" 분기는 실제로는 절대 타지 않고,
  // 이 셋은 "목록에 없다"는 이유로 모든 시나리오에서 사라져 있었다.
  const appAllowed = useCallback(
    (id: AppId) => {
      if (id === "messenger" || id === "agent" || id === "viewer") return true;
      const allowed = scenario?.desktop_apps;
      if (!allowed || allowed.length === 0) return true;
      return (allowed as string[]).includes(id);
    },
    [scenario],
  );

  // 두 번째 인자 = 창 배치를 기억할 자리. 새로고침해도 열어 둔 창이 그대로 돌아온다.
  const wm = useWindowManager((type, app) => pushEvent(type, { app }), `odysseus:wins:${attemptId}`);

  // ── 앱 전환기 (Alt+Tab · Alt+`) ────────────────────────────
  const switcher = useAppSwitcher(wm);
  // 전체화면이면 Alt·Tab 을 잠가 OS 로 새지 않게 한다. 안 되는 브라우저에는 대체 키를 한 번 안내한다.
  const lockNoticeRef = useRef(false);
  useFullscreenKeyboardLock((ok) => {
    if (ok || lockNoticeRef.current) return;
    lockNoticeRef.current = true;
    toast("이 브라우저에서는 Alt+Tab 대신 Alt+` 로 창을 전환합니다.", "info");
  });
  useEffect(() => {
    if (!inProgress || keyboardLockSupported() || lockNoticeRef.current) return;
    lockNoticeRef.current = true;
    toast("이 브라우저에서는 Alt+Tab 대신 Alt+` 로 창을 전환합니다.", "info");
  }, [inProgress, toast]);

  // ── 시험장 이탈 방지 ────────────────────────────────────────
  // 응시 중에 뒤로 가기를 누르면 시험 화면이 그냥 사라진다. 브라우저 기본
  // 확인창은 이 환경에서 뜨지 않거나 막히므로, 히스토리를 되밀어 두고 우리
  // 확인창으로 묻는다. 새로고침·창 닫기는 브라우저 기본 경고로 막는다.
  const leaveAskedRef = useRef(false);
  useEffect(() => {
    if (!inProgress) return;
    window.history.pushState({ odysseusExam: true }, "");
    const onPop = () => {
      window.history.pushState({ odysseusExam: true }, "");
      if (leaveAskedRef.current) return;
      leaveAskedRef.current = true;
      confirm({
        title: "시험장을 나갈까요?",
        message: (
          <>
            아직 <b>응시 중</b>입니다. 나가도 시간은 계속 흐르고, 지금까지의 작업은 저장되어
            있습니다. 이 창을 닫지 않으면 다시 들어와 이어서 진행할 수 있습니다.
            {user?.role === "guest" && (
              <>
                {" "}
                다만 <b>로그아웃하면 이 계정으로는 다시 들어올 수 없습니다.</b>
              </>
            )}
          </>
        ),
        confirmLabel: "나가기",
        cancelLabel: "계속 응시",
        danger: true,
      })
        .then((ok) => {
          if (ok) {
            pushEvent("exam_leave", { via: "back" });
            // 게스트의 집은 사무실이다 — /dashboard 로 보내면 한 번 더 튕긴다 (useUser.homeFor)
            router.replace(homeFor(user?.role ?? "candidate"));
          }
        })
        .finally(() => {
          leaveAskedRef.current = false;
        });
    };
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("popstate", onPop);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("popstate", onPop);
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [inProgress, confirm, router, pushEvent]);

  useEffect(() => {
    api
      .get<Attempt>(`/attempts/${attemptId}`)
      .then((a) => {
        syncClock(a);
        setAttempt(a);
        const current = a.scenarios.find((s) => s.ordinal === a.current_ordinal);
        if (a.status === "in_progress" && current) {
          const seenKey = `odysseus:briefing:${a.id}:${current.scenario_id}`;
          if (!localStorage.getItem(seenKey)) setShowBriefing(true);
        }
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : "불러올 수 없습니다"));
  }, [attemptId, syncClock]);

  // 참고 자료 앱 가용 여부 — 실패하면 없는 것으로 본다 (fail-closed)
  useEffect(() => {
    api
      .get<ReferenceConfig>("/reference/config")
      .then(setReference)
      .catch(() => setReference({ github_enabled: false }));
  }, []);

  const remainingSeconds = useMemo(() => {
    if (!attempt) return 0;
    return Math.max(0, Math.round((new Date(attempt.deadline_at).getTime() - serverNow()) / 1000));
  }, [attempt, serverNow]);

  /** 브리핑/인트로를 닫고 업무 시작 — 메신저부터 열어 준다 */
  const startWork = useCallback(() => {
    if (!attempt || !scenario) return;
    localStorage.setItem(`odysseus:briefing:${attempt.id}:${scenario.scenario_id}`, "1");
    setShowBriefing(false);
    wm.activate("messenger");
  }, [attempt, scenario, wm]);

  const introNotes = useMemo(
    () => [
      "과제는 명시적으로 제시되지 않습니다. 주어진 환경에서 파악해야 합니다.",
      "워크스페이스에 만들어지는 파일은 모두 산출물이 되고, 그것을 바탕으로 채점됩니다.",
      ...(attempt && attempt.scenarios.length > 1
        ? ["문제는 순서대로 진행합니다. 제출하면 이전 문제로 돌아갈 수 없습니다."]
        : []),
      "이 설명은 작업 표시줄의 [브리핑]에서 언제든 다시 볼 수 있습니다.",
      "모든 활동은 평가 목적으로 기록됩니다. 화면 캡처와 외부 도구 사용도 기록되어 평가에 반영됩니다.",
    ],
    [attempt],
  );

  const openBriefingReview = useCallback(() => {
    setBriefingReview(true);
    pushEvent("briefing_reopen");
  }, [pushEvent]);

  /** 편집기 내용을 서버로 밀어 넣되 **ms 안에** 끝낸다. 돌려주는 것은 그래도 못 보낸 경로.
   *
   *  시간 제한이 없으면 멈춘 연결 하나가 [시험 종료]와 마감 자동 제출을 붙잡는다 — 버튼을 눌러도
   *  아무 일이 일어나지 않고, 마감이 지나도 제출이 나가지 않는다. 제한에 걸리면 아직 서버에 없는
   *  경로를 그대로 돌려줘 확인창이 이름을 댈 수 있게 한다. */
  const flushWithin = useCallback(
    async (ms: number) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<string[]>((resolve) => {
        timer = setTimeout(() => resolve(pendingEdits.pendingPaths()), ms);
      });
      try {
        return await Promise.race([
          pendingEdits.flushPending().catch(() => pendingEdits.pendingPaths()),
          timedOut,
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
    [pendingEdits],
  );
  /** 관리자 보정을 화면이 알아차리게 한다.
   *
   *  마감과 질문 한도는 서버가 바꿀 수 있는데(장애 구제), 응시 정보는 마운트할 때 한 번만
   *  읽었다. 그래서 관리자가 시간을 늘려 줘도 응시자 화면의 타이머는 옛 마감을 향해 계속
   *  내려갔고, "늘려 줬다" 는 말을 믿고 기다리다 자동 제출되는 일이 생길 수 있었다.
   *  30초면 사람이 조치하고 알려 주는 속도에 충분히 붙는다. */
  const grantSeenRef = useRef<string>("");
  useEffect(() => {
    if (!inProgress) return;
    const poll = async () => {
      try {
        const fresh = await api.get<Attempt>(`/attempts/${attemptId}`);
        // 도중에 PC 시계가 맞춰졌으면 남은 시간을 다시 센다
        const clockMoved = syncClock(fresh);
        setAttempt((prev) => {
          // 바뀐 것이 없으면 이전 객체를 그대로 둔다. 새 객체를 넣으면 남은 시간이 다시 계산돼
          // 타이머가 이미 지난 경고를 30초마다 다시 울렸다.
          if (
            !clockMoved &&
            prev &&
            prev.deadline_at === fresh.deadline_at &&
            prev.status === fresh.status &&
            prev.current_ordinal === fresh.current_ordinal &&
            (prev.grants?.at ?? "") === (fresh.grants?.at ?? "")
          )
            return prev;
          const at = fresh.grants?.at ?? "";
          // 기준값은 이 화면이 뜰 때의 보정 시각이다. 그래서 새로고침할 때마다 예전 보정이
          // 다시 뜨지는 않고, 보는 동안 새로 들어온 것만 알린다 — 첫 보정도 포함해서.
          if (at && at !== grantSeenRef.current) {
            const parts: string[] = [];
            const dTurns = (fresh.grants?.agent_turns ?? 0) - (prev?.grants?.agent_turns ?? 0);
            const dMessages = (fresh.grants?.messenger_turns ?? 0) - (prev?.grants?.messenger_turns ?? 0);
            const dMin = (fresh.grants?.extra_minutes ?? 0) - (prev?.grants?.extra_minutes ?? 0);
            if (dMin > 0) parts.push(`시험 시간 ${dMin}분`);
            if (dTurns > 0) parts.push(`에이전트 질문 ${dTurns}회`);
            if (dMessages > 0) parts.push(`메신저 메시지 ${dMessages}건`);
            if (parts.length) toast(`관리자가 ${parts.join(" · ")}을(를) 추가했습니다`, "success");
          }
          grantSeenRef.current = at;
          return fresh;
        });
      } catch {
        /* 폴링 실패는 조용히 넘긴다 — 연결 안내는 ConnectionBanner 가 한다 */
      }
    };
    grantSeenRef.current = attempt?.grants?.at ?? "";
    const t = setInterval(poll, 30_000);
    return () => clearInterval(t);
    // attempt 전체를 의존으로 두면 폴링할 때마다 타이머가 새로 걸린다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inProgress, attemptId, toast]);

  /** 되돌릴 수 없는 경계를 넘기 전에 편집기 내용을 서버로 밀어 넣는다.
   *  돌려주는 것은 **그래도 못 보낸 경로** — 호출부가 이름을 대고 경고할 수 있다. */
  const flushBeforeLeaving = useCallback(async () => {
    if (pendingEdits.pendingPaths().length > 0) toast("저장하지 않은 편집을 먼저 저장합니다…", "info");
    const failed = await flushWithin(SUBMIT_FLUSH_TIMEOUT_MS);
    if (failed.length > 0) pushEvent("unsaved_on_submit", { paths: failed.slice(0, 20), count: failed.length });
    return failed;
  }, [pendingEdits, flushWithin, pushEvent, toast]);

  // 마감 직전에 미리 저장한다. 서버는 마감 시각이 지나면 유예 없이 종료하므로, 타이머가 0 이 된 뒤의
  // 저장(마감 자동 제출의 일괄 저장)은 대개 늦는다 — 시간에 쫓겨 마지막까지 고친 사람이 가장 크게
  // 잃던 자리다. 그 뒤의 편집은 자동 저장과 마지막 일괄 저장이 받는다.
  const deadlineAt = attempt?.status === "in_progress" ? attempt.deadline_at : null;
  useEffect(() => {
    if (!deadlineAt) return;
    const wait = new Date(deadlineAt).getTime() - PRE_DEADLINE_FLUSH_MS - serverNow();
    if (wait < -PRE_DEADLINE_FLUSH_MS) return; // 이미 마감이 지났다
    const t = setTimeout(() => void flushWithin(PRE_DEADLINE_FLUSH_MS - 2000), Math.max(0, wait));
    return () => clearTimeout(t);
  }, [deadlineAt, flushWithin, serverNow]);

  const goNextScenario = useCallback(async () => {
    if (!attempt || !scenario) return;
    // 채점은 서버가 가진 파일만 본다 — 확인창을 띄우기 전에 편집기 내용을 밀어 넣고,
    // 그래도 못 보낸 것이 있으면 이름을 대고 물어본다. 되돌아올 수 없는 버튼이기 때문이다.
    const unsaved = await flushBeforeLeaving();
    const ok = await confirm({
      title: "이 문제를 제출하고 다음으로 넘어갈까요?",
      message: (
        <>
          제출하면 이 문제로 <b className="text-slate-700">되돌아올 수 없습니다</b>. 대화·파일·실행 기록은
          그대로 평가에 사용됩니다.
          {unsaved.length > 0 && (
            <>
              <br />
              <b className="text-red-600">
                저장하지 못한 파일 {unsaved.length}개({unsaved.join(", ")})가 있습니다 — 이 내용은 채점에
                포함되지 않습니다.
              </b>
            </>
          )}
        </>
      ),
      danger: true,
      confirmLabel: "제출하고 다음 문제로",
    });
    if (!ok) return;
    try {
      const next = await api.post<Attempt>(
        `/attempts/${attemptId}/scenarios/${scenario.scenario_id}/complete`,
      );
      syncClock(next);
      setAttempt(next);
      // 새 문제 = 새 데스크톱: 창을 정리하고 브리핑부터 다시
      Object.keys(wm.wins).forEach((id) => wm.close(id));
      setViewerPaths({});
      setBooting(false);
      setBriefingReview(false);
      setShowBriefing(true);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "다음 문제로 넘어갈 수 없습니다", "error");
    }
  }, [attempt, scenario, attemptId, confirm, toast, wm, flushBeforeLeaving, syncClock]);

  const finish = useCallback(
    async (silent = false) => {
      // 마감 자동 제출(silent)도 먼저 저장을 시도한다 — 다만 서버는 마감 시각에 이미 닫혔을 수 있어,
      // 실제 보장은 15초 전의 미리 저장(위)과 자동 저장이 맡는다. 시간 제한이 있어 제출을 붙잡지 않는다.
      const unsaved = await flushBeforeLeaving();
      if (!silent) {
        const ok = await confirm({
          title: "시험을 종료할까요?",
          message: (
            <>
              종료하면 더 이상 작업할 수 없습니다. 산출물과 대화가 그대로 제출됩니다.
              {unsaved.length > 0 && (
                <>
                  <br />
                  <b className="text-red-600">
                    저장하지 못한 파일 {unsaved.length}개({unsaved.join(", ")})가 있습니다 — 이 내용은
                    채점에 포함되지 않습니다. 연결을 확인하고 다시 시도해 보세요.
                  </b>
                </>
              )}
            </>
          ),
          danger: true,
          confirmLabel: "종료 및 제출",
        });
        if (!ok) return;
      }
      try {
        const a = await api.post<Attempt>(`/attempts/${attemptId}/finish`);
        setAttempt(a);
      } catch (e) {
        toast(e instanceof ApiError ? e.message : "종료에 실패했습니다", "error");
      }
    },
    [attemptId, confirm, toast, flushBeforeLeaving],
  );

  if (error) {
    return (
      <div className="desktop-wallpaper flex min-h-screen items-center justify-center p-4">
        <div className="rounded-2xl bg-white p-8 text-center shadow-2xl">
          <p className="text-sm text-red-600">{error}</p>
          <Button className="mt-4" variant="secondary" onClick={() => router.replace("/dashboard")}>
            대시보드로
          </Button>
        </div>
      </div>
    );
  }
  if (!attempt || !scenario) {
    return (
      <div className="desktop-wallpaper flex min-h-screen items-center justify-center">
        <Spinner label="시험 환경 준비 중..." />
      </div>
    );
  }
  if (attempt.status !== "in_progress") {
    return <FinishedScreen attempt={attempt} router={router} />;
  }

  const openApp = (id: AppId) => wm.activate(id);
  const chapter = attempt.scenarios.length > 1 ? `문제 ${attempt.current_ordinal + 1} / ${attempt.scenarios.length}` : null;
  const messengerWin = wm.wins.messenger;
  const messengerVisible = messengerWin.open && !messengerWin.minimized;

  /** 문서·표의 새 창을 연다 (기존 창은 그대로 둔다). */
  const openNewApp = (id: AppId) => wm.activate(wm.openNew(id));

  return (
    <WorkspaceProvider
      attemptId={attemptId}
      scenarioId={scenario.scenario_id}
      pendingEdits={pendingEdits}
      // 폴더·뷰어가 "다른 앱으로 열기" 를 권하기 전에 그 앱이 이 시험에 있는지 묻는다
      appAvailable={(app) => appAllowed(app as AppId)}
      onOpenIde={() => openApp("ide")}
      onOpenDocs={() => openApp("docs")}
      onOpenSheet={() => openApp("sheet")}
      onFocusWindow={(winId) => wm.focus(winId)}
      onOpenViewer={(path) => {
        const open = wm.instancesOf("viewer").filter((w) => w.open);
        const same = open.find((w) => viewerPaths[w.id] === path);
        if (same) {
          wm.focus(same.id);
          return;
        }
        const id = open.length === 0 ? wm.open("viewer") : wm.openNew("viewer");
        setViewerPaths((m) => ({ ...m, [id]: path }));
        wm.focus(id);
      }}
    >
      {/* 연결이 끊긴 사실은 기록만 하지 않고 화면에도 말한다 — 저장되지 않는 줄 모른 채
          계속 작업하는 것이 이 시험에서 가장 크게 잃는 길이다 */}
      <ConnectionBanner onReconnect={() => flushWithin(SUBMIT_FLUSH_TIMEOUT_MS)} />
      {/* 같은 응시가 두 탭에 열려 있으면 나중에 연 탭에만 알린다 — 탭끼리는 서로의 편집을
          모르고, 자동 저장이 상대의 전문을 덮어쓴다 */}
      <DuplicateTabBanner attemptId={attemptId} />
      <SessionLostBanner />
      {/* 메신저 세션은 창이 아니라 데스크톱 수명이다 — 창을 닫아도 대화·읽음·답장 대기가 남는다 */}
      <MessengerSessionProvider
        key={scenario.scenario_id}
        attemptId={attemptId}
        scenarioId={scenario.scenario_id}
        characters={scenario.characters}
        onReply={(ch) => {
          if (!messengerVisible) toast(`${ch.name}님이 답장했습니다. 메신저에서 확인하세요.`, "info");
        }}
      >
      <TerminalSessionProvider key={scenario.scenario_id}>
      <AgentSessionProvider
        attemptId={attemptId}
        scenarioId={scenario.scenario_id}
        enabled={scenario.agent_enabled}
      >
      <div
        className="desktop-wallpaper relative h-screen w-screen overflow-hidden"
        onClick={() => setSelectedIcon(null)}
        onContextMenu={(e) => {
          // 시험 환경은 OS처럼 동작한다 — 입력 요소에서는 붙여넣기 등 기본 메뉴를
          // 남기고, 앱이 자기 메뉴를 열었으면(기본 동작이 이미 막혔으면) 건드리지
          // 않는다. 바탕화면 빈 곳에서만 데스크톱 메뉴를 연다.
          const el = e.target as HTMLElement;
          const editable =
            el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable;
          if (editable || e.defaultPrevented) return;
          const onWallpaper = !el.closest("[data-app], [data-taskbar], [data-desktop-icons]");
          if (!onWallpaper) {
            e.preventDefault();
            return;
          }
          const openWindows = Object.keys(wm.wins).filter((id) => wm.wins[id].open);
          openDeskMenu(e, [
            {
              label: "모든 창 최소화",
              disabled: openWindows.every((id) => wm.wins[id].minimized),
              onClick: () => openWindows.forEach((id) => wm.minimize(id)),
            },
            {
              label: "모든 창 닫기",
              disabled: openWindows.length === 0,
              onClick: () => openWindows.forEach((id) => wm.close(id)),
            },
            "separator",
            { label: "브리핑 다시 보기", onClick: openBriefingReview },
            {
              label: document.fullscreenElement ? "전체화면 종료" : "전체화면",
              onClick: () =>
                document.fullscreenElement
                  ? document.exitFullscreen().catch(() => undefined)
                  : document.documentElement.requestFullscreen().catch(() => undefined),
            },
            { label: "이 컴퓨터에 관하여", onClick: () => setSystemInfoOpen(true) },
          ] as MenuEntry[]);
        }}
      >
        {/* 바탕화면 아이콘 — 클릭 한 번으로 선택과 동시에 열린다(Enter도 동일).
            위→아래로 채우다 작업 표시줄 위 공간을 넘으면 다음 열로 이어진다(.desktop-dock —
            화면이 낮으면 더 촘촘한 타일). 어떤 높이에서도 아이콘이 잘리지 않는다. */}
        <div
          data-desktop-icons
          className="desktop-dock absolute bottom-[70px] left-4 top-5 z-10 select-none"
          onClick={(e) => e.stopPropagation()}
        >
          {ICONS.map((it) => {
            if (it.id === "agent" && !scenario.agent_enabled) return null;
            if (it.id === "github" && !reference?.github_enabled) return null;
            if (!appAllowed(it.id)) return null;
            const selected = selectedIcon === it.id;
            return (
              <button
                key={it.id}
                onClick={() => {
                  setSelectedIcon(it.id);
                  openApp(it.id);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") openApp(it.id);
                }}
                onContextMenu={(e) => {
                  setSelectedIcon(it.id);
                  openDeskMenu(e, [
                    { label: "열기", onClick: () => openApp(it.id) },
                    ...(MULTI_INSTANCE_APPS.includes(it.id)
                      ? [{ label: "새 창으로 열기", onClick: () => openNewApp(it.id) }]
                      : []),
                  ]);
                }}
                title={it.label}
                className={`dock-item group flex flex-col items-center justify-start gap-1.5 rounded-xl border px-2 transition ${
                  selected
                    ? "border-sky-300/40 bg-sky-400/20"
                    : "border-transparent hover:border-white/10 hover:bg-white/10"
                }`}
              >
                <span
                  className={`dock-glyph relative flex shrink-0 items-center justify-center rounded-[30%] bg-gradient-to-br text-white shadow-lg transition-transform duration-150 group-hover:-translate-y-0.5 group-hover:scale-105 group-active:scale-95 ${it.tile} ${it.glow}`}
                >
                  {/* 유리 광택 */}
                  <span className="pointer-events-none absolute inset-0 rounded-[30%] bg-gradient-to-b from-white/40 via-white/10 to-transparent opacity-80" />
                  <span className="pointer-events-none absolute inset-0 rounded-[30%] ring-1 ring-inset ring-white/25" />
                  <span className="relative drop-shadow-sm">{it.icon}</span>
                  {it.id === "messenger" && <MessengerUnreadBadge />}
                </span>
                <span
                  className={`max-w-full truncate rounded px-1 text-center text-[11px] font-semibold leading-tight text-white ${
                    selected ? "" : "drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]"
                  }`}
                >
                  {it.label}
                </span>
              </button>
            );
          })}
        </div>

        {/* 창들 */}
        <Window
          win={wm.wins.messenger}
          wm={wm}
          title={APP_META.messenger.title}
          accent={APP_META.messenger.accent}
          theme={APP_META.messenger.theme}
          icon={<IconMessenger size={15} />}
        >
          <MessengerApp key={scenario.scenario_id} />
        </Window>
        {appAllowed("ide") && (
          <Window
            win={wm.wins.ide}
            wm={wm}
            title={APP_META.ide.title}
            accent={APP_META.ide.accent}
            theme={APP_META.ide.theme}
            icon={<IconIde size={15} />}
          >
            <IdeApp key={scenario.scenario_id} />
          </Window>
        )}
        {appAllowed("mail") && (
          <Window
            win={wm.wins.mail}
            wm={wm}
            title={APP_META.mail.title}
            accent={APP_META.mail.accent}
            theme={APP_META.mail.theme}
            icon={<IconMail size={15} />}
          >
            <MailApp key={scenario.scenario_id} people={scenario.characters} />
          </Window>
        )}
        {/* 문서·표는 인스턴스마다 창을 하나씩 편다 — [새 창으로 열기]로 늘어난 만큼 */}
        {appAllowed("docs") &&
          wm.instancesOf("docs").map((w, i, arr) => (
            <Window
              key={w.id}
              win={w}
              wm={wm}
              title={arr.length > 1 ? `${APP_META.docs.title} ${i + 1}` : APP_META.docs.title}
              accent={APP_META.docs.accent}
              theme={APP_META.docs.theme}
              icon={<IconDocs size={15} />}
            >
              <DocsApp key={`${scenario.scenario_id}:${w.id}`} winId={w.id} />
            </Window>
          ))}
        {appAllowed("sheet") &&
          wm.instancesOf("sheet").map((w, i, arr) => (
            <Window
              key={w.id}
              win={w}
              wm={wm}
              title={arr.length > 1 ? `${APP_META.sheet.title} ${i + 1}` : APP_META.sheet.title}
              accent={APP_META.sheet.accent}
              theme={APP_META.sheet.theme}
              icon={<IconSheet size={15} />}
            >
              <SheetApp key={`${scenario.scenario_id}:${w.id}`} winId={w.id} />
            </Window>
          ))}
        {scenario.agent_enabled && (
          <Window
            win={wm.wins.agent}
            wm={wm}
            title={APP_META.agent.title}
            accent={APP_META.agent.accent}
            icon={<IconAgent size={15} />}
          >
            <AgentApp />
          </Window>
        )}
        {appAllowed("files") && (
        <Window
          win={wm.wins.files}
          wm={wm}
          title={APP_META.files.title}
          accent={APP_META.files.accent}
          theme={APP_META.files.theme}
          icon={<IconFolder size={15} />}
        >
          <FilesApp key={scenario.scenario_id} />
        </Window>
        )}
        {appAllowed("terminal") && (
          <Window
            win={wm.wins.terminal}
            wm={wm}
            title={APP_META.terminal.title}
            accent={APP_META.terminal.accent}
            theme={APP_META.terminal.theme}
            icon={<IconTerminal size={15} />}
          >
            <TerminalApp />
          </Window>
        )}
        {reference?.github_enabled && appAllowed("github") && (
          <Window
            win={wm.wins.github}
            wm={wm}
            title={APP_META.github.title}
            accent={APP_META.github.accent}
            theme={APP_META.github.theme}
            icon={<IconGithub size={15} />}
          >
            <GithubApp key={scenario.scenario_id} />
          </Window>
        )}
        {wm.instancesOf("viewer").map((w) => {
          const p = viewerPaths[w.id] ?? null;
          return (
            <Window
              key={w.id}
              win={w}
              wm={wm}
              title={p ? `뷰어 — ${p.split("/").pop()}` : "뷰어"}
              accent={APP_META.viewer.accent}
              theme={APP_META.viewer.theme}
              icon={<IconFile size={15} />}
            >
              <ViewerApp key={`${scenario.scenario_id}:${w.id}`} path={p} />
            </Window>
          );
        })}

        {/* 워터마크 — 창 위, 작업 표시줄 아래. 캡처된 화면에 누구의 것인지가 남는다 */}
        <Watermark name={user?.name ?? ""} email={user?.email ?? ""} attemptId={attemptId} />

        {/* 작업 표시줄 */}
        <Taskbar
          wm={wm}
          remainingSeconds={remainingSeconds}
          onExpire={() => {
            // 마감 직전에 관리자가 연장했을 수 있다 — 30초 폴링을 기다리지 않고 서버의 마감을 한 번 더 본다
            // 타이머는 초 단위 반올림이라 마감 직전에 0 이 될 수 있다. 서버 마감이 지난 뒤에 보낸다
            const finishAfter = (deadlineAt: string) =>
              setTimeout(() => void finish(true), Math.max(0, Date.parse(deadlineAt) - serverNow()) + 200);
            api
              .get<Attempt>(`/attempts/${attemptId}`)
              .then((fresh) => {
                syncClock(fresh);
                if (fresh.status !== "in_progress") void finish(true);
                else if (Date.parse(fresh.deadline_at) > serverNow() + 1000) setAttempt(fresh);
                else finishAfter(fresh.deadline_at);
              })
              .catch(() => (attempt ? finishAfter(attempt.deadline_at) : void finish(true)));
          }}
          onTimeWarning={(left) =>
            toast(
              left > 300
                ? `남은 시간 ${Math.round(left / 60)}분입니다.`
                : left > 60
                  ? `남은 시간 ${Math.round(left / 60)}분 — 마무리하고 제출을 준비하세요.`
                  : "1분 남았습니다. 시간이 다 되면 지금 상태 그대로 자동 제출됩니다.",
              left <= 300 ? "error" : "info",
            )
          }
          onFinish={() => finish(false)}
          onNextScenario={goNextScenario}
          userName={user?.name ?? ""}
          attemptId={attemptId}
          scenarios={attempt.scenarios}
          hasNext={hasNext}
          viewerPaths={viewerPaths}
          onOpenSystemInfo={() => setSystemInfoOpen(true)}
          onOpenBriefing={openBriefingReview}
        />

        {/* 앱 전환기 — Alt+Tab / Alt+` */}
        <AppSwitcherOverlay
          state={switcher.state}
          wins={wm.wins}
          onPick={(id) => {
            switcher.cancel();
            wm.activate(id);
          }}
          labelOf={(w) => {
            if (w.appId === "viewer" && viewerPaths[w.id]) return `뷰어 — ${viewerPaths[w.id].split("/").pop()}`;
            // 같은 앱의 창이 여럿이면(문서·표) 몇 번째인지 붙인다 — 작업 표시줄과 같은 번호
            const siblings = wm.instancesOf(w.appId).filter((x) => x.open);
            const n = siblings.findIndex((x) => x.id === w.id);
            return siblings.length > 1 ? `${APP_META[w.appId].title} ${n + 1}` : APP_META[w.appId].title;
          }}
        />

        <ContextMenuView menu={deskMenu} onClose={closeDeskMenu} />

        <SystemInfoModal
          open={systemInfoOpen}
          onClose={() => setSystemInfoOpen(false)}
          userName={user?.name ?? ""}
        />

        {/* 브리핑 다시 보기 — 시작 브리핑과 같은 카드, 닫기만 다르다 */}
        {briefingReview && !showBriefing && !booting && (
          <BriefingModal
            mode="review"
            title={attempt.assessment_title}
            chapter={chapter}
            briefing={scenario.briefing_md}
            notes={introNotes}
            onClose={() => setBriefingReview(false)}
          />
        )}

        {/* 부팅 연출 — 임무 시작 뒤, 옛 기계가 켜지듯 실제 사양이 흐른다 */}
        {booting && (
          <BootSequence
            userName={user?.name ?? ""}
            assessmentTitle={attempt.assessment_title}
            chapter={chapter}
            characters={scenario.characters.map((c) => ({ name: c.name, role: c.role }))}
            agentEnabled={scenario.agent_enabled}
            durationMin={Math.max(1, Math.round(remainingSeconds / 60))}
            onReveal={startWork}
            onDone={() => setBooting(false)}
          />
        )}

        {/* 시작 브리핑 — 설정에 따라 시네마틱 인트로 또는 기본 카드.
            시작 버튼은 사용자 제스처라 여기서 전체화면을 청한다 — 한 화면으로 시험을 보는 환경에서
            Alt+Tab 창 전환이 OS 로 새지 않으려면 전체화면이어야 한다. 거부되면 그냥 진행한다. */}
        {showBriefing && !booting &&
          (attempt.gamified_intro ? (
            <IntroCinematic
              title={attempt.assessment_title}
              chapter={chapter}
              briefing={scenario.briefing_md || "출근했습니다. 메신저에 새 메시지가 와 있습니다."}
              notes={introNotes}
              onStart={() => {
                requestDesktopFullscreen();
                setBooting(true);
              }}
            />
          ) : (
            <BriefingModal
              mode="start"
              title={attempt.assessment_title}
              chapter={chapter}
              briefing={scenario.briefing_md}
              notes={introNotes}
              onStart={() => {
                requestDesktopFullscreen();
                startWork();
              }}
            />
          ))}
      </div>
      </AgentSessionProvider>
      </TerminalSessionProvider>
      </MessengerSessionProvider>
    </WorkspaceProvider>
  );
}

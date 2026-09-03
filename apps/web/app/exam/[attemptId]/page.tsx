"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { api, ApiError } from "@/lib/api";
import type { Attempt, AttemptScenario, ReferenceConfig } from "@/lib/types";
import { Markdown } from "@/components/Markdown";
import { useToast } from "@/components/toast";
import { useUser } from "@/components/useUser";
import { COPY_EVENT } from "@/lib/clipboard";
import { Button, Spinner } from "@/components/ui";
import {
  IconAgent,
  IconFile,
  IconFolder,
  IconGithub,
  IconGlobe,
  IconIde,
  IconMessenger,
  IconTerminal,
} from "@/components/icons";
import { useWindowManager, AppId } from "@/components/desktop/wm";
import { Window, APP_META } from "@/components/desktop/Window";
import { Taskbar } from "@/components/desktop/Taskbar";
import { WorkspaceProvider } from "@/components/desktop/workspace";
import { AgentSessionProvider } from "@/components/desktop/agentSession";
import { TerminalSessionProvider } from "@/components/desktop/terminalSession";
import { IntroCinematic } from "@/components/desktop/IntroCinematic";
import { MessengerApp } from "@/components/desktop/apps/MessengerApp";
import { ViewerApp } from "@/components/desktop/apps/ViewerApp";
import { IdeApp } from "@/components/desktop/apps/IdeApp";
import { AgentApp } from "@/components/desktop/apps/AgentApp";
import { FilesApp } from "@/components/desktop/apps/FilesApp";
import { TerminalApp } from "@/components/desktop/apps/TerminalApp";
import { GithubApp } from "@/components/desktop/apps/GithubApp";
import { BrowserApp } from "@/components/desktop/apps/BrowserApp";

const ICONS: { id: AppId; label: string; icon: React.ReactNode; tile: string; glow: string }[] = [
  {
    id: "messenger",
    label: "메신저",
    icon: <IconMessenger size={30} />,
    tile: "from-violet-400 via-violet-500 to-fuchsia-600",
    glow: "group-hover:shadow-[0_0_26px_rgba(167,139,250,0.55)]",
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
    id: "files",
    label: "폴더",
    icon: <IconFolder size={30} />,
    tile: "from-amber-400 via-amber-500 to-orange-600",
    glow: "group-hover:shadow-[0_0_26px_rgba(251,191,36,0.55)]",
  },
  {
    id: "terminal",
    label: "터미널",
    icon: <IconTerminal size={30} />,
    tile: "from-neutral-700 via-neutral-800 to-black",
    glow: "group-hover:shadow-[0_0_26px_rgba(163,163,163,0.4)]",
  },
  {
    id: "github",
    label: "GitHub",
    icon: <IconGithub size={30} />,
    tile: "from-slate-600 via-slate-800 to-slate-950",
    glow: "group-hover:shadow-[0_0_26px_rgba(148,163,184,0.5)]",
  },
  {
    id: "browser",
    label: "인터넷",
    icon: <IconGlobe size={30} />,
    tile: "from-emerald-400 via-teal-500 to-cyan-600",
    glow: "group-hover:shadow-[0_0_26px_rgba(45,212,191,0.55)]",
  },
];

/** 응시 중 행동 이벤트 배치 기록 (포커스/가시성/네트워크) */
function useActivityTracker(attemptId: string, active: boolean, scenarioId: string | null) {
  const queue = useRef<{ type: string; scenario_id: string | null; payload: Record<string, unknown> }[]>([]);
  const scenarioRef = useRef(scenarioId);
  scenarioRef.current = scenarioId;

  const push = useCallback((type: string, payload: Record<string, unknown> = {}) => {
    queue.current.push({ type, scenario_id: scenarioRef.current, payload });
  }, []);

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
      push(type, { chars: trimmed.length, text: trimmed.slice(0, 500) });
    };
    const onCopy = () => recordCopy("copy", window.getSelection()?.toString() ?? "");
    const onCut = () => recordCopy("cut", window.getSelection()?.toString() ?? "");
    const onAppCopy = (e: Event) =>
      recordCopy("copy", String((e as CustomEvent<{ text?: string }>).detail?.text ?? ""));
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
    window.addEventListener(COPY_EVENT, onAppCopy);
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);
    window.addEventListener("pagehide", onExit);
    return () => {
      flush();
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
      document.removeEventListener("copy", onCopy);
      document.removeEventListener("cut", onCut);
      window.removeEventListener(COPY_EVENT, onAppCopy);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("pagehide", onExit);
    };
  }, [attemptId, active, push]);

  return push;
}

function FinishedScreen({ attempt, router }: { attempt: Attempt; router: ReturnType<typeof useRouter> }) {
  return (
    <div className="desktop-wallpaper flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-md rounded-2xl bg-white p-8 text-center shadow-2xl">
        <p className="text-4xl">{attempt.status === "submitted" ? "✅" : "⏰"}</p>
        <h1 className="mt-3 text-xl font-bold">
          {attempt.status === "submitted" ? "시험이 제출되었습니다" : "시험 시간이 만료되었습니다"}
        </h1>
        <p className="mt-2 text-sm text-slate-500">
          {attempt.assessment_title} — 모든 대화·파일·작업 기록이 평가자에게 전달되었습니다.
        </p>
        <Button className="mt-6 w-full" onClick={() => router.replace("/dashboard")}>
          대시보드로 돌아가기
        </Button>
      </div>
    </div>
  );
}

export default function ExamDesktopPage() {
  const params = useParams<{ attemptId: string }>();
  const attemptId = params.attemptId;
  const router = useRouter();
  const { toast, confirm } = useToast();
  const { user } = useUser(["candidate", "admin", "evaluator"]);

  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [error, setError] = useState("");
  const [showBriefing, setShowBriefing] = useState(false);
  const [messengerOpened, setMessengerOpened] = useState(false);
  const [selectedIcon, setSelectedIcon] = useState<AppId | null>(null);
  // 참고 자료 앱(GitHub·인터넷)은 관리자 설정으로 끌 수 있다 — 꺼졌으면 아이콘부터 없앤다
  const [reference, setReference] = useState<ReferenceConfig | null>(null);
  const [viewerPath, setViewerPath] = useState<string | null>(null);

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

  const wm = useWindowManager((type, app) => pushEvent(type, { app }));

  useEffect(() => {
    api
      .get<Attempt>(`/attempts/${attemptId}`)
      .then((a) => {
        setAttempt(a);
        const current = a.scenarios.find((s) => s.ordinal === a.current_ordinal);
        if (a.status === "in_progress" && current) {
          const seenKey = `odysseus:briefing:${a.id}:${current.scenario_id}`;
          if (!localStorage.getItem(seenKey)) setShowBriefing(true);
        }
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : "불러올 수 없습니다"));
  }, [attemptId]);

  // 참고 자료 앱 가용 여부 — 실패하면 없는 것으로 본다 (fail-closed)
  useEffect(() => {
    api
      .get<ReferenceConfig>("/reference/config")
      .then(setReference)
      .catch(() => setReference({ github_enabled: false, web_enabled: false, search_provider: "" }));
  }, []);

  const remainingSeconds = useMemo(() => {
    if (!attempt) return 0;
    return Math.max(0, Math.round((new Date(attempt.deadline_at).getTime() - Date.now()) / 1000));
  }, [attempt]);

  /** 브리핑/인트로를 닫고 업무 시작 — 메신저부터 열어 준다 */
  const startWork = useCallback(() => {
    if (!attempt || !scenario) return;
    localStorage.setItem(`odysseus:briefing:${attempt.id}:${scenario.scenario_id}`, "1");
    setShowBriefing(false);
    setMessengerOpened(true);
    wm.open("messenger");
    wm.focus("messenger");
  }, [attempt, scenario, wm]);

  const introNotes = useMemo(
    () => [
      "과제는 명시적으로 제시되지 않습니다. 주어진 환경에서 파악해야 합니다.",
      "워크스페이스에 만들어지는 파일은 모두 산출물이 되고, 그것을 바탕으로 채점됩니다.",
      ...(attempt && attempt.scenarios.length > 1
        ? ["문제는 순서대로 진행합니다. 제출하면 이전 문제로 돌아갈 수 없습니다."]
        : []),
      "모든 활동은 평가 목적으로 기록됩니다.",
    ],
    [attempt],
  );

  const goNextScenario = useCallback(async () => {
    if (!attempt || !scenario) return;
    const ok = await confirm({
      title: "이 문제를 제출하고 다음으로 넘어갈까요?",
      message: (
        <>
          제출하면 이 문제로 <b className="text-slate-700">되돌아올 수 없습니다</b>. 대화·파일·실행 기록은
          그대로 평가에 사용됩니다.
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
      setAttempt(next);
      // 새 문제 = 새 데스크톱: 창을 정리하고 브리핑부터 다시
      (Object.keys(wm.wins) as AppId[]).forEach((id) => wm.close(id));
      setViewerPath(null);
      setMessengerOpened(false);
      setShowBriefing(true);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "다음 문제로 넘어갈 수 없습니다", "error");
    }
  }, [attempt, scenario, attemptId, confirm, toast, wm]);

  const finish = useCallback(
    async (silent = false) => {
      if (!silent) {
        const ok = await confirm({
          title: "시험을 종료할까요?",
          message: "종료하면 더 이상 작업할 수 없습니다. 산출물과 대화가 그대로 제출됩니다.",
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
    [attemptId, confirm, toast],
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

  const openApp = (id: AppId) => {
    if (id === "messenger") setMessengerOpened(true);
    wm.open(id);
    wm.focus(id);
  };

  return (
    <WorkspaceProvider
      attemptId={attemptId}
      scenarioId={scenario.scenario_id}
      onOpenIde={() => openApp("ide")}
      onOpenViewer={(path) => {
        setViewerPath(path);
        openApp("viewer");
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
          // 시험 환경은 OS처럼 동작한다 — 앱이 자체 메뉴를 열지 않은 경우 브라우저 메뉴는 막는다.
          // 단, 입력 요소에서는 기본 메뉴(붙여넣기 등)를 남긴다.
          const el = e.target as HTMLElement;
          const editable =
            el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable;
          if (!editable) e.preventDefault();
        }}
      >
        {/* 바탕화면 아이콘 — 클릭=선택, 더블클릭/Enter=열기 (Windows 규약) */}
        <div
          className="absolute left-4 top-5 z-10 flex select-none flex-col gap-2"
          onClick={(e) => e.stopPropagation()}
        >
          {ICONS.map((it) => {
            if (it.id === "agent" && !scenario.agent_enabled) return null;
            if (it.id === "github" && !reference?.github_enabled) return null;
            if (it.id === "browser" && !reference?.web_enabled) return null;
            const selected = selectedIcon === it.id;
            return (
              <button
                key={it.id}
                onClick={() => setSelectedIcon(it.id)}
                onDoubleClick={() => openApp(it.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") openApp(it.id);
                }}
                title={`${it.label} — 더블 클릭으로 열기`}
                className={`group flex w-[92px] flex-col items-center gap-1.5 rounded-xl border px-2 pb-1.5 pt-2.5 transition ${
                  selected
                    ? "border-sky-300/40 bg-sky-400/20"
                    : "border-transparent hover:border-white/10 hover:bg-white/10"
                }`}
              >
                <span
                  className={`relative flex h-14 w-14 items-center justify-center rounded-[17px] bg-gradient-to-br text-white shadow-lg transition-transform duration-150 group-hover:-translate-y-0.5 group-hover:scale-105 group-active:scale-95 ${it.tile} ${it.glow}`}
                >
                  {/* 유리 광택 */}
                  <span className="pointer-events-none absolute inset-0 rounded-[17px] bg-gradient-to-b from-white/40 via-white/10 to-transparent opacity-80" />
                  <span className="pointer-events-none absolute inset-0 rounded-[17px] ring-1 ring-inset ring-white/25" />
                  <span className="relative drop-shadow-sm">{it.icon}</span>
                  {it.id === "messenger" && !messengerOpened && (
                    <span className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full border-2 border-slate-900/40 bg-red-500 text-[10px] font-bold text-white shadow">
                      1
                    </span>
                  )}
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
          <MessengerApp
            key={scenario.scenario_id}
            attemptId={attemptId}
            scenarioId={scenario.scenario_id}
            characters={scenario.characters}
            onActivity={() => undefined}
          />
        </Window>
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
        {reference?.github_enabled && (
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
        {reference?.web_enabled && (
          <Window
            win={wm.wins.browser}
            wm={wm}
            title={APP_META.browser.title}
            accent={APP_META.browser.accent}
            theme={APP_META.browser.theme}
            icon={<IconGlobe size={15} />}
          >
            <BrowserApp key={scenario.scenario_id} />
          </Window>
        )}
        <Window
          win={wm.wins.viewer}
          wm={wm}
          title={viewerPath ? `뷰어 — ${viewerPath.split("/").pop()}` : "뷰어"}
          accent={APP_META.viewer.accent}
          theme={APP_META.viewer.theme}
          icon={<IconFile size={15} />}
        >
          <ViewerApp key={scenario.scenario_id} path={viewerPath} />
        </Window>

        {/* 작업 표시줄 */}
        <Taskbar
          wm={wm}
          remainingSeconds={remainingSeconds}
          onExpire={() => finish(true)}
          onFinish={() => finish(false)}
          onNextScenario={goNextScenario}
          userName={user?.name ?? ""}
          assessmentTitle={
            attempt.scenarios.length > 1
              ? `${attempt.assessment_title} · ${attempt.current_ordinal + 1}. ${scenario.title}`
              : attempt.assessment_title
          }
          scenarios={attempt.scenarios}
          hasNext={hasNext}
          messengerBadge={!messengerOpened}
          agentDisabled={!scenario.agent_enabled}
          referenceDisabled={{
            github: !reference?.github_enabled,
            browser: !reference?.web_enabled,
          }}
          viewerLabel={viewerPath ? viewerPath.split("/").pop() : null}
        />

        {/* 시작 브리핑 — 설정에 따라 시네마틱 인트로 또는 기본 카드 */}
        {showBriefing &&
          (attempt.gamified_intro ? (
            <IntroCinematic
              title={attempt.assessment_title}
              chapter={
                attempt.scenarios.length > 1
                  ? `문제 ${attempt.current_ordinal + 1} / ${attempt.scenarios.length}`
                  : null
              }
              briefing={scenario.briefing_md || "출근했습니다. 메신저에 새 메시지가 와 있습니다."}
              notes={introNotes}
              onStart={startWork}
            />
          ) : (
            <div className="absolute inset-0 z-[9500] flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-sm">
              <div className="window-shadow flex max-h-[85vh] w-full max-w-2xl flex-col rounded-2xl bg-white">
                <div className="shrink-0 px-7 pb-4 pt-7">
                  <div className="flex items-center gap-2">
                    <p className="text-xs font-bold uppercase tracking-widest text-sky-500">Odysseus</p>
                    {attempt.scenarios.length > 1 && (
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-500">
                        문제 {attempt.current_ordinal + 1} / {attempt.scenarios.length}
                      </span>
                    )}
                  </div>
                  <h2 className="mt-1 text-xl font-bold">{attempt.assessment_title}</h2>
                </div>
                <div className="thin-scroll min-h-0 flex-1 overflow-y-auto px-7">
                  <div className="rounded-xl bg-slate-50 p-5">
                    {scenario.briefing_md ? (
                      <Markdown>{scenario.briefing_md}</Markdown>
                    ) : (
                      <p className="text-sm text-slate-600">
                        출근했습니다. 메신저에 새 메시지가 와 있습니다.
                      </p>
                    )}
                  </div>
                  <ul className="mt-4 space-y-1 pb-2 text-xs text-slate-500">
                    {introNotes.map((n, i) => (
                      <li key={i}>· {n}</li>
                    ))}
                  </ul>
                </div>
                <div className="shrink-0 px-7 pb-7 pt-4">
                  <Button className="w-full" onClick={startWork}>
                    업무 시작하기
                  </Button>
                </div>
              </div>
            </div>
          ))}
      </div>
      </AgentSessionProvider>
      </TerminalSessionProvider>
    </WorkspaceProvider>
  );
}

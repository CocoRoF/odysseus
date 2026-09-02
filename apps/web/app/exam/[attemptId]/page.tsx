"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { api, ApiError } from "@/lib/api";
import type { Attempt, AttemptScenario } from "@/lib/types";
import { Markdown } from "@/components/Markdown";
import { useToast } from "@/components/toast";
import { Button, Spinner } from "@/components/ui";
import { IconAgent, IconFolder, IconIde, IconMessenger } from "@/components/icons";
import { useWindowManager, AppId } from "@/components/desktop/wm";
import { Window, APP_META } from "@/components/desktop/Window";
import { Taskbar } from "@/components/desktop/Taskbar";
import { WorkspaceProvider } from "@/components/desktop/workspace";
import { MessengerApp } from "@/components/desktop/apps/MessengerApp";
import { IdeApp } from "@/components/desktop/apps/IdeApp";
import { AgentApp } from "@/components/desktop/apps/AgentApp";
import { FilesApp } from "@/components/desktop/apps/FilesApp";

const ICONS: { id: AppId; label: string; icon: React.ReactNode; tint: string }[] = [
  { id: "messenger", label: "메신저", icon: <IconMessenger size={26} />, tint: "bg-violet-500/90" },
  { id: "ide", label: "IDE", icon: <IconIde size={26} />, tint: "bg-slate-600/90" },
  { id: "agent", label: "AI 에이전트", icon: <IconAgent size={26} />, tint: "bg-sky-500/90" },
  { id: "files", label: "폴더", icon: <IconFolder size={26} />, tint: "bg-amber-500/90" },
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
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);
    window.addEventListener("pagehide", onExit);
    return () => {
      flush();
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
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

  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [error, setError] = useState("");
  const [scenarioId, setScenarioId] = useState<string | null>(null);
  const [showBriefing, setShowBriefing] = useState(false);
  const [messengerOpened, setMessengerOpened] = useState(false);

  const inProgress = attempt?.status === "in_progress";
  const pushEvent = useActivityTracker(attemptId, Boolean(inProgress), scenarioId);

  const wm = useWindowManager((type, app) => pushEvent(type, { app }));

  useEffect(() => {
    api
      .get<Attempt>(`/attempts/${attemptId}`)
      .then((a) => {
        setAttempt(a);
        setScenarioId(a.scenarios[0]?.scenario_id ?? null);
        if (a.status === "in_progress") {
          const seenKey = `odysseus:briefing:${a.id}`;
          if (!localStorage.getItem(seenKey)) setShowBriefing(true);
        }
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : "불러올 수 없습니다"));
  }, [attemptId]);

  const scenario: AttemptScenario | null = useMemo(
    () => attempt?.scenarios.find((s) => s.scenario_id === scenarioId) ?? null,
    [attempt, scenarioId],
  );

  const remainingSeconds = useMemo(() => {
    if (!attempt) return 0;
    return Math.max(0, Math.round((new Date(attempt.deadline_at).getTime() - Date.now()) / 1000));
  }, [attempt]);

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
    <WorkspaceProvider attemptId={attemptId} scenarioId={scenario.scenario_id} onOpenIde={() => openApp("ide")}>
      <div className="desktop-wallpaper relative h-screen w-screen overflow-hidden select-none">
        {/* 바탕화면 아이콘 */}
        <div className="absolute left-5 top-6 z-10 flex flex-col gap-4">
          {ICONS.map((it) => {
            if (it.id === "agent" && !scenario.agent_enabled) return null;
            return (
              <button
                key={it.id}
                onDoubleClick={() => openApp(it.id)}
                onClick={() => openApp(it.id)}
                className="group flex w-20 flex-col items-center gap-1.5 rounded-xl p-2 hover:bg-white/10"
              >
                <span
                  className={`relative flex h-12 w-12 items-center justify-center rounded-2xl text-white shadow-lg ${it.tint}`}
                >
                  {it.icon}
                  {it.id === "messenger" && !messengerOpened && (
                    <span className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-red-500 text-[10px] font-bold text-white">
                      !
                    </span>
                  )}
                </span>
                <span className="text-center text-[11px] font-medium leading-tight text-white/90 drop-shadow">
                  {it.label}
                </span>
              </button>
            );
          })}
        </div>

        {/* 시나리오 전환 (복수일 때만) */}
        {attempt.scenarios.length > 1 && (
          <div className="absolute left-1/2 top-3 z-10 flex -translate-x-1/2 items-center gap-1 rounded-full bg-slate-950/50 p-1 backdrop-blur">
            {attempt.scenarios.map((s, i) => (
              <button
                key={s.scenario_id}
                onClick={() => setScenarioId(s.scenario_id)}
                className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                  s.scenario_id === scenarioId ? "bg-white text-slate-900" : "text-slate-300 hover:bg-white/10"
                }`}
              >
                {i + 1}. {s.title}
              </button>
            ))}
          </div>
        )}

        {/* 창들 */}
        <Window
          win={wm.wins.messenger}
          wm={wm}
          title={APP_META.messenger.title}
          accent={APP_META.messenger.accent}
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
          icon={<IconIde size={15} />}
        >
          <IdeApp key={scenario.scenario_id} onActivity={() => undefined} />
        </Window>
        {scenario.agent_enabled && (
          <Window
            win={wm.wins.agent}
            wm={wm}
            title={APP_META.agent.title}
            accent={APP_META.agent.accent}
            icon={<IconAgent size={15} />}
          >
            <AgentApp key={scenario.scenario_id} onActivity={() => undefined} />
          </Window>
        )}
        <Window
          win={wm.wins.files}
          wm={wm}
          title={APP_META.files.title}
          accent={APP_META.files.accent}
          icon={<IconFolder size={15} />}
        >
          <FilesApp key={scenario.scenario_id} />
        </Window>

        {/* 작업 표시줄 */}
        <Taskbar
          wm={wm}
          remainingSeconds={remainingSeconds}
          onExpire={() => finish(true)}
          onFinish={() => finish(false)}
          assessmentTitle={attempt.assessment_title}
          scenarioTitle={attempt.scenarios.length > 1 ? scenario.title : undefined}
          messengerBadge={!messengerOpened}
          agentDisabled={!scenario.agent_enabled}
        />

        {/* 시작 브리핑 */}
        {showBriefing && (
          <div className="absolute inset-0 z-[9500] flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-sm">
            <div className="window-shadow w-full max-w-lg rounded-2xl bg-white p-7">
              <p className="text-xs font-bold uppercase tracking-widest text-sky-500">Odysseus</p>
              <h2 className="mt-1 text-xl font-bold">{attempt.assessment_title}</h2>
              <div className="mt-4 rounded-xl bg-slate-50 p-4">
                {scenario.briefing_md ? (
                  <Markdown>{scenario.briefing_md}</Markdown>
                ) : (
                  <p className="text-sm text-slate-600">
                    메신저에 새 메시지가 와 있습니다. 대화로 상황을 파악하고, IDE와 폴더에서 작업하세요.
                  </p>
                )}
              </div>
              <ul className="mt-4 space-y-1 text-xs text-slate-500">
                <li>· 과제는 지문으로 주어지지 않습니다 — <b>메신저 대화</b>로 파악하세요.</li>
                <li>· 워크스페이스의 파일이 곧 산출물입니다. IDE·터미널·AI 에이전트를 활용하세요.</li>
                <li>· 모든 활동은 평가 목적으로 기록됩니다.</li>
              </ul>
              <Button
                className="mt-6 w-full"
                onClick={() => {
                  localStorage.setItem(`odysseus:briefing:${attempt.id}`, "1");
                  setShowBriefing(false);
                  openApp("messenger");
                }}
              >
                업무 시작하기
              </Button>
            </div>
          </div>
        )}
      </div>
    </WorkspaceProvider>
  );
}

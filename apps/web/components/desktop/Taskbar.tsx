"use client";

import { useEffect, useState } from "react";
import { Timer } from "@/components/Timer";
import {
  IconAgent,
  IconDone,
  IconExitFullscreen,
  IconFile,
  IconFolder,
  IconFullscreen,
  IconIde,
  IconLock,
  IconMessenger,
  IconMonitor,
  IconMore,
  IconNext,
  IconTerminal,
  IconGithub,
  IconGlobe,
} from "@/components/icons";
import type { AttemptScenario } from "@/lib/types";
import { ResourceMeter } from "./ResourceMeter";
import type { AppId, WindowManager } from "./wm";

// 바탕화면 아이콘과 같은 순서 — 두 곳이 어긋나면 찾는 위치가 달라진다
const APPS: { id: AppId; label: string; icon: React.ReactNode }[] = [
  { id: "terminal", label: "터미널", icon: <IconTerminal size={17} /> },
  { id: "files", label: "폴더", icon: <IconFolder size={17} /> },
  { id: "messenger", label: "메신저", icon: <IconMessenger size={17} /> },
  { id: "browser", label: "인터넷", icon: <IconGlobe size={17} /> },
  { id: "ide", label: "IDE", icon: <IconIde size={17} /> },
  { id: "agent", label: "AI 에이전트", icon: <IconAgent size={17} /> },
  { id: "github", label: "GitHub", icon: <IconGithub size={17} /> },
];

function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 10_000);
    return () => clearInterval(t);
  }, []);
  return (
    <span className="font-mono text-xs text-slate-300">
      {now.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}
    </span>
  );
}

/** 전체화면 토글 — 브라우저 fullscreen API, 상태에 따라 아이콘 전환 */
function FullscreenButton() {
  const [full, setFull] = useState(false);
  useEffect(() => {
    const sync = () => setFull(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);
  const toggle = () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => undefined);
    else document.documentElement.requestFullscreen().catch(() => undefined);
  };
  return (
    <button
      title={full ? "전체화면 종료" : "전체화면"}
      onClick={toggle}
      className="flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-white/15 px-2.5 text-xs font-medium text-slate-300 transition hover:bg-white/10 hover:text-white"
    >
      {full ? <IconExitFullscreen size={14} /> : <IconFullscreen size={14} />}
      <span className="hidden lg:inline">{full ? "전체화면 종료" : "전체화면"}</span>
    </button>
  );
}

/** 문제 목록 — 진행 상황만 보여주는 읽기 전용 팝오버 (이동 불가) */
function ScenarioListButton({ scenarios }: { scenarios: AttemptScenario[] }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const done = scenarios.filter((s) => s.status === "completed").length;

  return (
    <div className="relative shrink-0" onClick={(e) => e.stopPropagation()}>
      <button
        title="문제 목록"
        onClick={() => setOpen((v) => !v)}
        className={`flex h-9 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition ${
          open
            ? "border-white/25 bg-white/15 text-white"
            : "border-white/15 text-slate-300 hover:bg-white/10 hover:text-white"
        }`}
      >
        <IconMore size={15} />
        <span className="hidden xl:inline">
          문제 {Math.min(done + 1, scenarios.length)}/{scenarios.length}
        </span>
      </button>

      {open && (
        <div className="window-shadow absolute bottom-11 left-0 z-[9100] w-80 overflow-hidden rounded-xl border border-slate-700 bg-slate-900/95 backdrop-blur-xl">
          <div className="border-b border-white/10 px-3 py-2">
            <p className="text-xs font-bold text-white">문제 목록</p>
            <p className="mt-0.5 text-[11px] text-slate-400">
              순서대로 진행합니다 — 제출한 문제로는 돌아갈 수 없습니다.
            </p>
          </div>
          <ul className="max-h-72 overflow-y-auto py-1">
            {scenarios.map((s, i) => {
              const state =
                s.status === "completed"
                  ? { icon: <IconDone size={13} />, cls: "text-emerald-400", label: "제출 완료" }
                  : s.status === "in_progress"
                    ? { icon: <IconNext size={13} />, cls: "text-sky-400", label: "진행 중" }
                    : { icon: <IconLock size={13} />, cls: "text-slate-500", label: "잠김" };
              return (
                <li
                  key={s.scenario_id}
                  className={`flex items-center gap-2.5 px-3 py-2 text-sm ${
                    s.status === "in_progress" ? "bg-white/5" : ""
                  }`}
                >
                  <span className={`shrink-0 ${state.cls}`}>{state.icon}</span>
                  <span className="w-4 shrink-0 text-center text-[11px] text-slate-500">{i + 1}</span>
                  <span
                    className={`min-w-0 flex-1 truncate ${
                      s.status === "locked" ? "text-slate-500" : "text-slate-200"
                    }`}
                  >
                    {s.status === "locked" ? "· · · · ·" : s.title}
                  </span>
                  <span className={`shrink-0 text-[11px] ${state.cls}`}>{state.label}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

export function Taskbar({
  wm,
  remainingSeconds,
  onExpire,
  onFinish,
  onNextScenario,
  userName,
  attemptId,
  scenarios,
  hasNext,
  messengerBadge,
  agentDisabled,
  referenceDisabled,
  viewerLabel,
  onOpenSystemInfo,
}: {
  wm: WindowManager;
  remainingSeconds: number;
  onExpire: () => void;
  onFinish: () => void;
  onNextScenario: () => void;
  userName: string;
  attemptId: string;
  scenarios: AttemptScenario[];
  hasNext: boolean;
  messengerBadge: boolean;
  agentDisabled: boolean;
  /** 시험 설정에서 꺼진 참고 자료 앱 — 작업 표시줄에서도 감춘다 */
  referenceDisabled: Partial<Record<AppId, boolean>>;
  viewerLabel?: string | null;
  onOpenSystemInfo: () => void;
}) {
  return (
    <div className="absolute inset-x-0 bottom-0 z-[9000] flex h-[58px] select-none items-center gap-3 border-t border-white/10 bg-slate-950/70 px-3 backdrop-blur-xl">
      {/* 좌측: [전체화면] [{참여자}의 컴퓨터 — {시험명}] */}
      <div className="flex min-w-0 items-center gap-2">
        {scenarios.length > 1 && <ScenarioListButton scenarios={scenarios} />}
        <FullscreenButton />
        <button
          onClick={onOpenSystemInfo}
          title="이 컴퓨터에 관하여"
          className="flex min-w-0 items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 transition hover:border-white/25 hover:bg-white/10"
        >
          <IconMonitor size={14} className="shrink-0 text-sky-400" />
          <span className="truncate text-xs font-medium text-slate-200">
            {userName ? `${userName}의 컴퓨터` : "내 컴퓨터"}
          </span>
        </button>
        {/* 이 샌드박스가 지금 쓰고 있는 자원 */}
        <ResourceMeter attemptId={attemptId} />
      </div>

      <div className="mx-auto flex items-center gap-1.5">
        {APPS.map((app) => {
          if (app.id === "agent" && agentDisabled) return null;
          if (referenceDisabled[app.id]) return null;
          const w = wm.wins[app.id];
          const active = w.open && !w.minimized;
          return (
            <button
              key={app.id}
              title={app.label}
              onClick={() => (w.open && !w.minimized ? wm.minimize(app.id) : (wm.open(app.id), wm.focus(app.id)))}
              className={`relative flex h-11 w-11 items-center justify-center rounded-xl transition ${
                active
                  ? "bg-white/15 text-white"
                  : w.open
                    ? "text-slate-300 hover:bg-white/10"
                    : "text-slate-400 hover:bg-white/10 hover:text-slate-200"
              }`}
            >
              {app.icon}
              {w.open && (
                <span className="absolute bottom-1 left-1/2 h-1 w-1 -translate-x-1/2 rounded-full bg-sky-400" />
              )}
              {app.id === "messenger" && messengerBadge && (
                <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-red-500" />
              )}
            </button>
          );
        })}
        {/* 뷰어 — 열려 있을 때만 나타나는 실행 창 (아이콘: 파일) */}
        {wm.wins.viewer.open && (
          <button
            title={viewerLabel ? `뷰어 — ${viewerLabel}` : "뷰어"}
            onClick={() =>
              wm.wins.viewer.minimized ? (wm.open("viewer"), wm.focus("viewer")) : wm.minimize("viewer")
            }
            className={`relative flex h-11 w-11 items-center justify-center rounded-xl transition ${
              !wm.wins.viewer.minimized ? "bg-white/15 text-white" : "text-slate-300 hover:bg-white/10"
            }`}
          >
            <IconFile size={17} />
            <span className="absolute bottom-1 left-1/2 h-1 w-1 -translate-x-1/2 rounded-full bg-sky-400" />
          </button>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-3">
        <Clock />
        <Timer initialSeconds={remainingSeconds} onExpire={onExpire} />
        {hasNext ? (
          <button
            onClick={onNextScenario}
            className="flex items-center gap-1.5 rounded-lg bg-sky-600 px-3.5 py-1.5 text-sm font-semibold text-white transition hover:bg-sky-500"
          >
            <IconNext size={15} /> 다음 문제로
          </button>
        ) : (
          <button
            onClick={onFinish}
            className="rounded-lg bg-red-500/90 px-3.5 py-1.5 text-sm font-semibold text-white transition hover:bg-red-500"
          >
            시험 종료
          </button>
        )}
      </div>
    </div>
  );
}

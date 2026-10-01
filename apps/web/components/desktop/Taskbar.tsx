"use client";

import { useEffect, useState } from "react";
import { Timer } from "@/components/Timer";
import {
  IconBook,
  IconClose,
  IconDone,
  IconExitFullscreen,
  IconFullscreen,
  IconHelp,
  IconLock,
  IconMonitor,
  IconMore,
  IconNext,
} from "@/components/icons";
import type { AttemptScenario } from "@/lib/types";
import { ContextMenuView, useContextMenu } from "./ContextMenu";
import { ResourceMeter } from "./ResourceMeter";
import { appIcon, TASKBAR_ORDER } from "./appIcons";
import { APP_META } from "./Window";
import { useAgentSession } from "./agentSession";
import { useMessengerSessionOptional } from "./messengerSession";
import { useTerminalSession } from "./terminalSession";
import { MULTI_INSTANCE_APPS, type AppId, type WindowManager } from "./wm";

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
      title={full ? "전체화면 종료" : "전체화면 — Alt+Tab 창 전환이 켜집니다"}
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

/** 인터페이스 도움말 — 문제 내용과 무관한 사용법만 안내하는 팝오버. 기본은 닫힘(원할 때만 연다) */
function HelpButton() {
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

  return (
    <div className="relative shrink-0" onClick={(e) => e.stopPropagation()}>
      <button
        title="인터페이스 도움말"
        onClick={() => setOpen((v) => !v)}
        className={`flex h-9 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition ${
          open
            ? "border-white/25 bg-white/15 text-white"
            : "border-white/15 text-slate-300 hover:bg-white/10 hover:text-white"
        }`}
      >
        <IconHelp size={14} />
        <span className="hidden lg:inline">도움말</span>
      </button>

      {open && (
        <div className="window-shadow absolute bottom-11 left-0 z-[9100] w-80 overflow-hidden rounded-xl border border-slate-700 bg-slate-900/95 backdrop-blur-xl">
          <div className="flex items-center justify-between border-b border-white/10 px-3 py-2">
            <div>
              <p className="text-xs font-bold text-white">인터페이스 도움말</p>
              <p className="mt-0.5 text-[11px] text-slate-400">문제 내용은 다루지 않습니다 — 화면 사용법만 안내합니다.</p>
            </div>
            <button
              title="닫기"
              onClick={() => setOpen(false)}
              className="rounded p-1 text-slate-400 transition hover:bg-white/10 hover:text-white"
            >
              <IconClose size={14} />
            </button>
          </div>
          <ul className="space-y-2 px-3 py-3 text-xs leading-snug text-slate-300">
            <li>바탕화면 아이콘은 클릭 한 번으로 열립니다.</li>
            <li>문서·시트는 아이콘 우클릭 → 새 창으로 열기로 여러 개를 동시에 띄울 수 있습니다.</li>
            <li>마지막 문제에서는 화면 오른쪽 아래 &apos;시험 종료&apos;를 눌러야 제출됩니다.</li>
            <li>Alt+Tab으로 열려 있는 창을 전환할 수 있습니다.</li>
            <li>작업 표시줄 아이콘을 클릭하면 최소화한 창을 다시 불러옵니다.</li>
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
  onTimeWarning,
  onFinish,
  onNextScenario,
  userName,
  attemptId,
  scenarios,
  hasNext,
  viewerPaths,
  onOpenSystemInfo,
  onOpenBriefing,
}: {
  wm: WindowManager;
  remainingSeconds: number;
  onExpire: () => void;
  /** 남은 시간이 문턱을 넘을 때 (30·10·5·1분) */
  onTimeWarning?: (secondsLeft: number) => void;
  onFinish: () => void;
  onNextScenario: () => void;
  userName: string;
  attemptId: string;
  scenarios: AttemptScenario[];
  hasNext: boolean;
  /** 뷰어 인스턴스 id -> 그 창이 보여주는 파일 경로 */
  viewerPaths?: Record<string, string>;
  onOpenSystemInfo: () => void;
  /** 브리핑 다시 보기 */
  onOpenBriefing: () => void;
}) {
  const { menu, open: openMenu, close: closeMenu } = useContextMenu();
  // 진행 중 표시의 원천 — 창이 닫혀 있어도 세션은 살아 있으므로 여기서 읽을 수 있다
  const messenger = useMessengerSessionOptional();
  const agent = useAgentSession();
  const term = useTerminalSession();
  const busy: Partial<Record<AppId, boolean>> = {
    messenger: Boolean(messenger?.pending),
    agent: Boolean(agent?.busy),
    terminal: term.running,
    ide: term.running,
  };
  const unread = messenger?.unreadTotal ?? 0;

  return (
    <div data-taskbar className="absolute inset-x-0 bottom-0 z-[9000] flex h-[58px] select-none items-center gap-3 border-t border-white/10 bg-slate-950/70 px-3 backdrop-blur-xl">
      {/* 좌측: [문제 목록] [브리핑] [전체화면] [{참여자}의 컴퓨터] [자원] */}
      <div className="flex min-w-0 items-center gap-2">
        {scenarios.length > 1 && <ScenarioListButton scenarios={scenarios} />}
        <button
          title="브리핑 다시 보기 — 이 시험의 상황 설명"
          onClick={onOpenBriefing}
          className="flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-white/15 px-2.5 text-xs font-medium text-slate-300 transition hover:bg-white/10 hover:text-white"
        >
          <IconBook size={14} />
          <span className="hidden lg:inline">브리핑</span>
        </button>
        <HelpButton />
        <FullscreenButton />
        <button
          onClick={onOpenSystemInfo}
          title="이 컴퓨터에 관하여"
          className="flex h-9 min-w-0 items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 transition hover:border-white/25 hover:bg-white/10"
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
{TASKBAR_ORDER.flatMap((id) => {
          const working = Boolean(busy[id]);
          const hasUnread = id === "messenger" && unread > 0;
          const multi = MULTI_INSTANCE_APPS.includes(id);
          // 열린 창은 인스턴스마다 버튼 하나. 실행하지 않은 앱은 작업 표시줄에 없다 — 단, 닫힌 채로
          // 뒤에서 일하는 중이거나(답장 대기·실행 중) 읽지 않은 답장이 남아 있으면 기본 인스턴스를
          // 보여 준다. 닫은 창에 온 답장이 어디에도 안 보이면 안 된다.
          const opened = wm.instancesOf(id).filter((w) => w.open);
          const shown = opened.length > 0 ? opened : working || hasUnread ? [wm.wins[id]] : [];
          return shown.map((w, i) => {
            const active = w.open && !w.minimized;
            const viewerFile = id === "viewer" ? viewerPaths?.[w.id]?.split("/").pop() : undefined;
            const base = viewerFile ? `뷰어 — ${viewerFile}` : APP_META[id].title;
            const label = opened.length > 1 ? `${base} ${i + 1}` : base;
            const title = working
              ? `${label} — ${id === "messenger" ? "답장을 기다리는 중" : id === "agent" ? "에이전트가 작업 중" : "실행 중"}`
              : label;
            return (
              <button
                key={w.id}
                title={title}
                onClick={() => (active ? wm.minimize(w.id) : wm.activate(w.id))}
                onContextMenu={(e) =>
                  openMenu(
                    e,
                    [
                      { label: active ? "최소화" : "창 보이기", onClick: () => (active ? wm.minimize(w.id) : wm.activate(w.id)) },
                      { label: w.maximized ? "이전 크기로" : "최대화", onClick: () => (wm.open(w.appId, w.id), wm.toggleMaximize(w.id)) },
                      ...(multi ? [{ label: "새 창으로 열기", onClick: () => wm.activate(wm.openNew(id)) }] : []),
                      "separator",
                      { label: "닫기", danger: true, disabled: !w.open, onClick: () => wm.close(w.id) },
                    ],
                    { dark: true },
                  )
                }
                className={`relative flex h-11 w-11 items-center justify-center rounded-xl transition ${
                  active ? "bg-white/15 text-white" : w.open ? "text-slate-300 hover:bg-white/10" : "text-slate-500 hover:bg-white/10"
                }`}
              >
                {appIcon(id, 17)}
                {/* 진행 중 — 창이 열렸음을 알리는 그 점의 색만 바꾼다.
                    예전에는 아이콘을 도는 링이었다. 움직이는 것은 눈을 끌어당기고, 시험을 치르는
                    사람의 눈은 자기 일에 있어야 한다. 무언가 돌고 있다는 사실은 점 하나로 충분하다. */}
                {(w.open || working) && (
                  <span
                    className={`absolute bottom-1 left-1/2 h-1 -translate-x-1/2 rounded-full ${
                      working && i === 0 ? "w-3 bg-amber-400" : "w-1 bg-sky-400"
                    }`}
                  />
                )}
                {opened.length > 1 && (
                  <span className="absolute -bottom-0.5 -right-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-slate-950 text-[9px] font-bold text-slate-300 ring-1 ring-white/20">
                    {i + 1}
                  </span>
                )}
                {hasUnread && i === 0 && (
                  <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full border border-slate-900/60 bg-red-500 px-1 text-[10px] font-bold leading-none text-white">
                    {unread > 99 ? "99+" : unread}
                  </span>
                )}
              </button>
            );
          });
        })}
      </div>

      <ContextMenuView menu={menu} onClose={closeMenu} />

      <div className="flex shrink-0 items-center gap-3">
        <Clock />
        <Timer initialSeconds={remainingSeconds} onExpire={onExpire} onWarn={onTimeWarning} />
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

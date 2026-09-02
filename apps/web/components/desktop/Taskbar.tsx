"use client";

import { useEffect, useState } from "react";
import { Timer } from "@/components/Timer";
import {
  IconAgent,
  IconExitFullscreen,
  IconFolder,
  IconFullscreen,
  IconIde,
  IconMessenger,
  IconMonitor,
} from "@/components/icons";
import type { AppId, WindowManager } from "./wm";

const APPS: { id: AppId; label: string; icon: React.ReactNode }[] = [
  { id: "messenger", label: "메신저", icon: <IconMessenger size={17} /> },
  { id: "ide", label: "IDE", icon: <IconIde size={17} /> },
  { id: "agent", label: "AI 에이전트", icon: <IconAgent size={17} /> },
  { id: "files", label: "폴더", icon: <IconFolder size={17} /> },
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

export function Taskbar({
  wm,
  remainingSeconds,
  onExpire,
  onFinish,
  userName,
  assessmentTitle,
  messengerBadge,
  agentDisabled,
}: {
  wm: WindowManager;
  remainingSeconds: number;
  onExpire: () => void;
  onFinish: () => void;
  userName: string;
  assessmentTitle: string;
  messengerBadge: boolean;
  agentDisabled: boolean;
}) {
  return (
    <div className="absolute inset-x-0 bottom-0 z-[9000] flex h-[58px] items-center gap-3 border-t border-white/10 bg-slate-950/70 px-3 backdrop-blur-xl">
      {/* 좌측: [전체화면] [{참여자}의 컴퓨터 — {시험명}] */}
      <div className="flex min-w-0 items-center gap-2">
        <FullscreenButton />
        <div className="flex min-w-0 items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5">
          <IconMonitor size={14} className="shrink-0 text-sky-400" />
          <span className="truncate text-xs font-medium text-slate-200">
            {userName ? `${userName}의 컴퓨터` : "내 컴퓨터"}
            <span className="mx-1.5 text-slate-500">—</span>
            <span className="text-slate-400">{assessmentTitle}</span>
          </span>
        </div>
      </div>

      <div className="mx-auto flex items-center gap-1.5">
        {APPS.map((app) => {
          if (app.id === "agent" && agentDisabled) return null;
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
      </div>

      <div className="flex shrink-0 items-center gap-3">
        <Clock />
        <Timer initialSeconds={remainingSeconds} onExpire={onExpire} />
        <button
          onClick={onFinish}
          className="rounded-lg bg-red-500/90 px-3.5 py-1.5 text-sm font-semibold text-white transition hover:bg-red-500"
        >
          시험 종료
        </button>
      </div>
    </div>
  );
}

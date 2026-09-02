"use client";

import { useEffect, useState } from "react";
import { Timer } from "@/components/Timer";
import { IconAgent, IconFolder, IconIde, IconMessenger } from "@/components/icons";
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

export function Taskbar({
  wm,
  remainingSeconds,
  onExpire,
  onFinish,
  assessmentTitle,
  scenarioTitle,
  messengerBadge,
  agentDisabled,
}: {
  wm: WindowManager;
  remainingSeconds: number;
  onExpire: () => void;
  onFinish: () => void;
  assessmentTitle: string;
  scenarioTitle?: string;
  messengerBadge: boolean;
  agentDisabled: boolean;
}) {
  return (
    <div className="absolute inset-x-0 bottom-0 z-[9000] flex h-[58px] items-center gap-3 border-t border-white/10 bg-slate-950/70 px-4 backdrop-blur-xl">
      <div className="flex min-w-0 items-center gap-2">
        <span className="text-sm font-black text-white">
          Odysseus<span className="text-sky-400">.</span>
        </span>
        <span className="hidden max-w-[260px] truncate text-xs text-slate-400 md:block">
          {assessmentTitle}
          {scenarioTitle ? ` · ${scenarioTitle}` : ""}
        </span>
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

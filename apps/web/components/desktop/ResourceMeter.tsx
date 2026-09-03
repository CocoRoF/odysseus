"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { MyResources } from "@/lib/types";

/** 작업 표시줄의 자원 막대 — 내 작업 공간이 지금 얼마나 쓰고 있는가. */

const POLL_MS = 1500;

function Gauge({
  label,
  ratio,
  text,
  color,
}: {
  label: string;
  ratio: number;
  text: string;
  color: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
        {label}
      </span>
      <div className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-white/10">
        <div
          className="h-full rounded-full transition-[width] duration-500"
          style={{ width: `${Math.min(100, Math.max(2, ratio * 100))}%`, background: color }}
        />
      </div>
      <span className="w-9 shrink-0 text-right font-mono text-[10.5px] tabular-nums text-slate-300">
        {text}
      </span>
    </div>
  );
}

export function ResourceMeter({ attemptId }: { attemptId: string }) {
  const [res, setRes] = useState<MyResources | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await api.get<MyResources>(`/attempts/${attemptId}/resources`);
        if (alive) setRes(r);
      } catch {
        /* 잠깐의 실패는 무시 — 다음 주기에 회복된다 */
      }
    };
    tick();
    const t = setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [attemptId]);

  if (!res) return null;

  const cpuRatio = res.cpu_capacity_percent > 0 ? res.cpu_percent / res.cpu_capacity_percent : 0;
  const memRatio = res.memory_limit_bytes ? res.memory_bytes / res.memory_limit_bytes : 0;
  const memText =
    res.memory_bytes >= 1024 * 1024 * 1024
      ? `${(res.memory_bytes / 1024 ** 3).toFixed(1)}GB`
      : `${Math.round(res.memory_bytes / 1024 ** 2)}MB`;

  const busy = res.running > 0;
  const title = busy
    ? `실행 중 ${res.running}건 — ${res.commands.map((c) => c.command).join(" / ")}`
    : "실행 중인 명령이 없습니다";

  return (
    <div
      title={title}
      className={`flex h-9 shrink-0 items-center gap-3 rounded-lg border px-2.5 transition ${
        busy ? "border-sky-400/30 bg-sky-400/10" : "border-white/10 bg-white/5"
      }`}
    >
      <Gauge
        label="CPU"
        ratio={cpuRatio}
        text={`${Math.round(res.cpu_percent)}%`}
        color={cpuRatio > 0.75 ? "#f87171" : "#38bdf8"}
      />
      <span className="h-4 w-px shrink-0 bg-white/10" />
      <Gauge
        label="RAM"
        ratio={memRatio}
        text={memText}
        color={memRatio > 0.75 ? "#f87171" : "#34d399"}
      />
    </div>
  );
}

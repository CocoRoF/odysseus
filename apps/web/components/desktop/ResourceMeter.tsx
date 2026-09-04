"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { MyResources } from "@/lib/types";

/** 작업 표시줄의 자원 막대 — 내 작업 공간이 지금 얼마나 쓰고 있는가. */

const POLL_IDLE_MS = 2000;
const POLL_BUSY_MS = 800;
// 끝난 실행의 최고치를 이만큼 붙들어 둔다 — 2초짜리 실행도 눈에 보이게
const HOLD_MS = 6000;

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

  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      let busy = false;
      try {
        const r = await api.get<MyResources>(`/attempts/${attemptId}/resources`);
        if (!alive) return;
        setRes(r);
        setNow(Date.now());
        busy = r.running > 0;
      } catch {
        /* 잠깐의 실패는 무시 — 다음 주기에 회복된다 */
      }
      // 실행 중엔 촘촘히 — 2초짜리 실행도 잡힌다
      if (alive) timer = setTimeout(tick, busy ? POLL_BUSY_MS : POLL_IDLE_MS);
    };
    tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [attemptId]);

  if (!res) return null;

  const busy = res.running > 0;
  // 방금 끝난 실행은 최고치를 잠시 붙들어 보여 준다 — 순간값만 보면 늘 0 처럼 보인다
  const recent = !busy && res.last_run && now - res.last_run.ended_at * 1000 < HOLD_MS ? res.last_run : null;
  const cpuNow = busy ? res.cpu_percent : recent ? recent.peak_cpu : 0;
  const memNow = busy ? res.memory_bytes : recent ? recent.peak_mem : 0;
  const cpuRatio = res.cpu_capacity_percent > 0 ? cpuNow / res.cpu_capacity_percent : 0;
  const memRatio = res.memory_limit_bytes ? memNow / res.memory_limit_bytes : 0;
  const memText =
    memNow >= 1024 * 1024 * 1024 ? `${(memNow / 1024 ** 3).toFixed(1)}GB` : `${Math.round(memNow / 1024 ** 2)}MB`;

  const last = res.last_run;
  const title = busy
    ? `실행 중 ${res.running}건 — ${res.commands.map((c) => c.command).join(" / ")}`
    : last
      ? `최근 실행: ${last.command}\n${last.duration_s}초 · CPU ${last.cpu_seconds}s (최고 ${Math.round(last.peak_cpu)}%) · 메모리 최고 ${Math.round(last.peak_mem / 1048576)}MB\n이 세션 실행 ${res.stats.runs}회 · CPU 합계 ${res.stats.cpu_seconds}s`
      : "아직 실행한 명령이 없습니다";

  return (
    <div
      title={title}
      className={`flex h-9 shrink-0 items-center gap-3 rounded-lg border px-2.5 transition ${
        busy ? "border-sky-400/30 bg-sky-400/10" : recent ? "border-violet-400/30 bg-violet-400/10" : "border-white/10 bg-white/5"
      }`}
    >
      <Gauge
        label="CPU"
        ratio={cpuRatio}
        text={`${Math.round(cpuNow)}%`}
        color={cpuRatio > 0.75 ? "#f87171" : "#38bdf8"}
      />
      <span className="h-4 w-px shrink-0 bg-white/10" />
      <Gauge
        label="RAM"
        ratio={memRatio}
        text={memText}
        color={memRatio > 0.75 ? "#f87171" : "#34d399"}
      />
      {res.stats.runs > 0 && (
        <>
          <span className="h-4 w-px shrink-0 bg-white/10" />
          <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-slate-400" title="이 세션에서 실행한 명령 수 · CPU 시간 합계">
            {res.stats.runs}회 · {res.stats.cpu_seconds.toFixed(1)}s
          </span>
        </>
      )}
    </div>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import type { MyResources } from "@/lib/types";

/**
 * 작업 표시줄의 자원 막대 — 내 샌드박스가 지금 얼마나 쓰고 있는가.
 *
 * 값 하나만 보여주면 "지금 0%"밖에 알 수 없어서, 최근 이력을 함께 그린다.
 * 실행은 대개 순식간에 끝나므로 막대가 튀었다 가라앉는 모습 자체가 정보다.
 */

const POLL_MS = 1500;
const HISTORY = 32;

function Spark({ values, color }: { values: number[]; color: string }) {
  const width = 40;
  const height = 16;
  const points = values.map((v, i) => {
    const x = values.length === 1 ? width : (i / (values.length - 1)) * width;
    const y = height - Math.max(0.02, Math.min(1, v)) * height;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return (
    <svg width={width} height={height} className="shrink-0 overflow-visible" aria-hidden>
      <polyline
        points={`0,${height} ${points.join(" ")} ${width},${height}`}
        fill={color}
        fillOpacity={0.18}
        stroke="none"
      />
      <polyline points={points.join(" ")} fill="none" stroke={color} strokeWidth={1.3} strokeLinejoin="round" />
    </svg>
  );
}

function Gauge({
  label,
  ratio,
  text,
  color,
  history,
}: {
  label: string;
  ratio: number;
  text: string;
  color: string;
  history: number[];
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
        {label}
      </span>
      <Spark values={history} color={color} />
      <div className="h-1 w-8 shrink-0 overflow-hidden rounded-full bg-white/10">
        <div
          className="h-full rounded-full transition-[width] duration-500"
          style={{ width: `${Math.min(100, Math.max(3, ratio * 100))}%`, background: color }}
        />
      </div>
      <span className="w-10 shrink-0 text-right font-mono text-[10.5px] tabular-nums text-slate-300">
        {text}
      </span>
    </div>
  );
}

export function ResourceMeter({ attemptId }: { attemptId: string }) {
  const [res, setRes] = useState<MyResources | null>(null);
  const cpuHist = useRef<number[]>([]);
  const memHist = useRef<number[]>([]);
  const [, force] = useState(0);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await api.get<MyResources>(`/attempts/${attemptId}/resources`);
        if (!alive) return;
        setRes(r);
        const cpuRatio = r.cpu_capacity_percent > 0 ? r.cpu_percent / r.cpu_capacity_percent : 0;
        const memRatio = r.memory_limit_bytes ? r.memory_bytes / r.memory_limit_bytes : 0;
        cpuHist.current = [...cpuHist.current, cpuRatio].slice(-HISTORY);
        memHist.current = [...memHist.current, memRatio].slice(-HISTORY);
        force((n) => n + 1);
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
        history={cpuHist.current}
      />
      <span className="h-4 w-px shrink-0 bg-white/10" />
      <Gauge
        label="RAM"
        ratio={memRatio}
        text={memText}
        color={memRatio > 0.75 ? "#f87171" : "#34d399"}
        history={memHist.current}
      />
    </div>
  );
}

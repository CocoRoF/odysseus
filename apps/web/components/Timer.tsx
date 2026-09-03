"use client";

import { useEffect, useRef, useState } from "react";
import { fmtDuration } from "@/lib/format";

// 남은 시간 알림 문턱 (초) — 30분·10분·5분·1분
const WARN_MARKS = [1800, 600, 300, 60];

/** 서버가 준 remaining_seconds 기준 카운트다운. 0이 되면 onExpire 1회 호출.
 *
 * 남은 시간이 얼마 없다는 걸 숫자로만 알리면 잘 보이지 않는다. 문턱을 넘을 때
 * 한 번씩 알려 주고(onWarn), 마지막 1분은 눈에 띄게 뛴다.
 */
export function Timer({
  initialSeconds,
  onExpire,
  onWarn,
}: {
  initialSeconds: number;
  onExpire: () => void;
  onWarn?: (secondsLeft: number) => void;
}) {
  const [remaining, setRemaining] = useState(initialSeconds);
  const expiredRef = useRef(false);
  const endAtRef = useRef(Date.now() + initialSeconds * 1000);
  // 이미 알린 문턱 (초). 넘어설 때 딱 한 번씩만 알린다.
  const warnedRef = useRef<Set<number>>(new Set());
  const warnRef = useRef(onWarn);
  warnRef.current = onWarn;

  useEffect(() => {
    endAtRef.current = Date.now() + initialSeconds * 1000;
    expiredRef.current = false;
    warnedRef.current = new Set();
  }, [initialSeconds]);

  useEffect(() => {
    const t = setInterval(() => {
      const left = Math.max(0, Math.round((endAtRef.current - Date.now()) / 1000));
      setRemaining(left);
      for (const mark of WARN_MARKS) {
        if (left <= mark && left > 0 && !warnedRef.current.has(mark)) {
          warnedRef.current.add(mark);
          warnRef.current?.(mark);
        }
      }
      if (left <= 0 && !expiredRef.current) {
        expiredRef.current = true;
        onExpire();
      }
    }, 500);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const critical = remaining <= 60;
  const urgent = remaining <= 300;
  return (
    <span
      title={critical ? "곧 자동으로 제출됩니다" : undefined}
      className={`shrink-0 whitespace-nowrap rounded-lg px-3 py-1 font-mono text-sm font-bold tabular-nums transition-colors ${
        critical
          ? "animate-pulse bg-red-500 text-white"
          : urgent
            ? "bg-red-500/20 text-red-400"
            : "bg-slate-700/60 text-slate-200"
      }`}
    >
      {fmtDuration(remaining)}
    </span>
  );
}

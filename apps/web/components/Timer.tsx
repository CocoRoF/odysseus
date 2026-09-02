"use client";

import { useEffect, useRef, useState } from "react";
import { fmtDuration } from "@/lib/format";

/** 서버가 준 remaining_seconds 기준 카운트다운. 0이 되면 onExpire 1회 호출. */
export function Timer({
  initialSeconds,
  onExpire,
}: {
  initialSeconds: number;
  onExpire: () => void;
}) {
  const [remaining, setRemaining] = useState(initialSeconds);
  const expiredRef = useRef(false);
  const endAtRef = useRef(Date.now() + initialSeconds * 1000);

  useEffect(() => {
    endAtRef.current = Date.now() + initialSeconds * 1000;
    expiredRef.current = false;
  }, [initialSeconds]);

  useEffect(() => {
    const t = setInterval(() => {
      const left = Math.max(0, Math.round((endAtRef.current - Date.now()) / 1000));
      setRemaining(left);
      if (left <= 0 && !expiredRef.current) {
        expiredRef.current = true;
        onExpire();
      }
    }, 500);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const urgent = remaining <= 300;
  return (
    <span
      className={`shrink-0 whitespace-nowrap rounded-lg px-3 py-1 font-mono text-sm font-bold ${
        urgent ? "bg-red-500/20 text-red-400" : "bg-slate-700/60 text-slate-200"
      }`}
    >
      {fmtDuration(remaining)}
    </span>
  );
}

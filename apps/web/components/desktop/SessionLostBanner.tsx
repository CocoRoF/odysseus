"use client";

import { useEffect, useState } from "react";
import { onSessionLost, isSessionLost } from "@/lib/api";

/** 세션이 끝난 사실을 시험장에 알린다.
 *
 *  연결 배너는 서버에 **닿는가**를 본다(502·503·504). 세션이 끝난 것은 다른 일이다 — 서버는 멀쩡히
 *  답하고 있고, 다만 이 브라우저를 더는 알아보지 않는다. 그런데 화면은 둘을 구분하지 못해, 만료된
 *  뒤에도 타이머가 돌고 창이 멀쩡한 채로 저장만 조용히 실패했다. 응시자는 저장되고 있다고 믿는다.
 *
 *  손님 계정에서는 더 나쁘다. 세션이 끝나면 그 계정으로 다시 들어올 수 없고, 정리가 돌면 계정 자체가
 *  사라진다. 그러니 여기서는 **덮어서** 알린다 — 밑에서 계속 편집하게 두면 그 시간이 전부 버려진다.
 */
export function SessionLostBanner() {
  const [lost, setLost] = useState(false);

  useEffect(() => {
    setLost(isSessionLost());
    return onSessionLost(setLost);
  }, []);

  if (!lost) return null;
  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-label="세션이 끝났습니다"
      className="fixed inset-0 z-[300] flex items-center justify-center bg-slate-900/70 p-4 backdrop-blur-sm"
    >
      <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-2xl">
        <h2 className="text-lg font-semibold text-slate-900">세션이 끝났습니다</h2>
        <p className="mt-2 text-sm leading-relaxed text-slate-600">
          지금부터의 편집은 <b>저장되지 않습니다.</b> 화면에 보이는 내용은 아직 이 컴퓨터에만 있습니다.
          남기고 싶은 것이 있다면 먼저 복사해 두세요.
        </p>
        <p className="mt-2 text-xs leading-relaxed text-slate-400">
          계정으로 로그인한 경우 다시 들어오면 이어서 응시할 수 있습니다. 계정 없이 들어온 경우에는
          같은 계정으로 다시 들어올 수 없습니다.
        </p>
        <a
          href="/login"
          className="mt-5 block rounded-lg bg-slate-900 px-4 py-2.5 text-center text-sm font-medium text-white transition hover:bg-slate-700"
        >
          로그인 화면으로
        </a>
      </div>
    </div>
  );
}

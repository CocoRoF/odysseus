"use client";

import { useEffect, useState } from "react";

/** 같은 응시를 두 탭에서 열었을 때, **나중에 연 탭**에 사실을 알린다.
 *
 *  앱 안에서는 같은 파일을 두 창이 갖지 못하게 막아 두었지만(workspace.claimFile), 탭이
 *  다르면 서로를 모른다. 두 탭에서 같은 문서를 고치면 2초 자동 저장이 상대의 전문을 통째로
 *  덮어써서, 나중에 건드린 탭의 내용만 남고 다른 쪽 작업이 아무 말 없이 사라진다.
 *
 *  막지는 않는다 — 탭을 하나 더 여는 데에는 그럴 만한 이유가 있을 수 있고, 시험 중에 화면을
 *  잠그는 쪽이 더 위험하다. 대신 **무슨 일이 일어날 수 있는지** 한 줄로 알린다.
 *
 *  BroadcastChannel 은 같은 출처의 탭끼리만 오간다 — 서버도, 저장소도 쓰지 않는다.
 *  지원하지 않는 브라우저에서는 아무 일도 하지 않는다(안내가 없을 뿐, 동작은 그대로).
 */
export function DuplicateTabBanner({ attemptId }: { attemptId: string }) {
  const [duplicate, setDuplicate] = useState(false);

  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const me = Math.random().toString(36).slice(2, 10);
    let channel: BroadcastChannel;
    try {
      channel = new BroadcastChannel(`odysseus:attempt:${attemptId}`);
    } catch {
      return;
    }

    const onMessage = (e: MessageEvent) => {
      const data = e.data as { type?: string; from?: string } | null;
      if (!data || data.from === me) return;
      // 다른 탭이 "나 여기 있다" 고 물어보면 대답한다 — 먼저 있던 쪽의 몫이다.
      if (data.type === "hello") channel.postMessage({ type: "here", from: me });
      // 대답이 왔다 = 이 탭보다 먼저 열린 탭이 있다. 안내는 나중에 연 쪽에만 띄운다.
      if (data.type === "here") setDuplicate(true);
      // 상대가 닫혔다 — 아직 남은 탭이 있는지 다시 물어보고, 없으면 안내를 내린다.
      if (data.type === "bye") {
        setDuplicate(false);
        channel.postMessage({ type: "hello", from: me });
      }
    };

    channel.addEventListener("message", onMessage);
    channel.postMessage({ type: "hello", from: me });
    const leave = () => {
      try {
        channel.postMessage({ type: "bye", from: me });
      } catch {
        /* 이미 닫힌 채널이면 알릴 곳이 없다 */
      }
    };
    window.addEventListener("pagehide", leave);
    return () => {
      window.removeEventListener("pagehide", leave);
      leave();
      channel.removeEventListener("message", onMessage);
      channel.close();
    };
  }, [attemptId]);

  if (!duplicate) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-x-0 top-0 z-[9500] flex justify-center px-3 pt-2"
    >
      <div className="pointer-events-auto flex max-w-3xl items-center gap-3 rounded-xl border border-amber-400/60 bg-amber-600/95 px-4 py-2 text-[13px] font-semibold text-white shadow-lg">
        <span>
          이 시험이 다른 탭에서도 열려 있습니다.
          <span className="ml-1 font-normal opacity-90">
            두 곳에서 같은 파일을 고치면 한쪽 작업이 사라질 수 있습니다 — 한 탭만 쓰세요.
          </span>
        </span>
        <button
          onClick={() => setDuplicate(false)}
          className="shrink-0 rounded-lg border border-white/40 px-2 py-0.5 text-xs font-medium hover:bg-white/15"
        >
          닫기
        </button>
      </div>
    </div>
  );
}

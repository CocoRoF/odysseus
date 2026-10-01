"use client";

import { useEffect, useRef, useState } from "react";
import { ConnectionMonitor, onApiSignal, type Connection } from "@/lib/reachability";

/** 서버 확인 한 번의 시간 제한 — 멈춘 연결을 "아직 확인 중" 으로 오래 두지 않는다 */
const PROBE_TIMEOUT_MS = 5000;
/** 복구 뒤 저장이 남아 있으면 이 간격으로 다시 밀어 넣는다 */
const RECOVERY_RETRY_MS = 5000;

async function probeServer(): Promise<boolean> {
  try {
    const res = await fetch("/api/healthz", { cache: "no-store", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    return res.ok;
  } catch {
    return false;
  }
}

type Recovery = { tone: "working" | "ok" | "bad"; text: string } | null;

/** 연결이 끊긴 사실을 응시자에게 말한다.
 *
 *  예전에는 `net_offline` 을 **평가자용 기록으로만** 남기고 화면은 아무 말도 하지 않았다.
 *  타이머는 계속 돌고 창도 멀쩡해서, 응시자는 저장이 되고 있다고 믿은 채 계속 작업했다.
 *
 *  끊김은 브라우저의 네트워크 표시만으로 판단하지 않는다 — 서버 재시작·엣지 오류처럼 네트워크는
 *  멀쩡한데 서버에 닿지 못하는 경우가 더 흔하다 (lib/reachability).
 *
 *  복구되면 저절로 사라지지 않고 **끊긴 동안의 편집을 실제로 저장할 때까지** 남는다 — 끊겼다는
 *  말보다 "지금은 안전한가" 가 응시자가 실제로 알고 싶은 것이기 때문이다.
 */
export function ConnectionBanner({
  onReconnect,
}: {
  /** 편집 내용을 서버로 밀어 넣는다. 저장하지 못한 경로를 돌려준다 (빈 배열이면 전부 저장됨) */
  onReconnect: () => Promise<string[]>;
}) {
  const [connection, setConnection] = useState<Connection>("online");
  const [recovery, setRecovery] = useState<Recovery>(null);
  const onReconnectRef = useRef(onReconnect);
  onReconnectRef.current = onReconnect;

  useEffect(() => {
    let alive = true;
    let retry: ReturnType<typeof setTimeout> | null = null;

    /** 저장이 모두 끝날 때까지 되풀이한다. 다시 끊기면 멈추고 끊김 안내로 돌아간다 */
    const recover = async () => {
      if (retry) clearTimeout(retry);
      retry = null;
      setRecovery({ tone: "working", text: "연결이 복구되었습니다. 끊긴 동안의 편집을 저장하는 중…" });
      const failed = await onReconnectRef.current().catch(() => null);
      if (!alive || monitor.current !== "online") return;
      if (failed && failed.length === 0) {
        setRecovery({ tone: "ok", text: "연결이 복구되었습니다. 편집 내용을 모두 저장했습니다." });
        return;
      }
      setRecovery({
        tone: "bad",
        text: failed
          ? `연결은 복구됐지만 ${failed.length}개 파일을 아직 저장하지 못했습니다 (${failed.join(", ")}). 계속 다시 시도합니다 — 편집기의 상태 줄을 확인해 주세요.`
          : "연결은 복구됐지만 저장 상태를 확인하지 못했습니다. 계속 다시 시도합니다.",
      });
      retry = setTimeout(() => void recover(), RECOVERY_RETRY_MS);
    };

    const monitor = new ConnectionMonitor({
      probe: probeServer,
      onChange: (state, previous) => {
        if (!alive) return;
        setConnection(state);
        if (state !== "online") {
          if (retry) clearTimeout(retry);
          retry = null;
          setRecovery(null);
        } else if (previous !== "online") {
          void recover();
        }
      },
    });

    // navigator.onLine 은 첫 렌더에서 서버와 값이 다를 수 있다 — 마운트 뒤에 읽는다.
    if (!navigator.onLine) monitor.browserOffline();
    const goOffline = () => monitor.browserOffline();
    const goOnline = () => monitor.browserOnline();
    window.addEventListener("offline", goOffline);
    window.addEventListener("online", goOnline);
    const unsubscribe = onApiSignal((signal) => monitor.apiSignal(signal));
    return () => {
      alive = false;
      if (retry) clearTimeout(retry);
      monitor.dispose();
      unsubscribe();
      window.removeEventListener("offline", goOffline);
      window.removeEventListener("online", goOnline);
    };
  }, []);

  // 모두 저장했다는 안내만 읽을 만큼 세워 둔다. 끊김·저장 실패 안내는 스스로 사라지지 않는다.
  useEffect(() => {
    if (recovery?.tone !== "ok") return;
    const t = setTimeout(() => setRecovery(null), 6000);
    return () => clearTimeout(t);
  }, [recovery]);

  if (connection === "online" && !recovery) return null;

  const tone =
    connection !== "online"
      ? "border-red-400/60 bg-red-600/95"
      : recovery?.tone === "ok"
        ? "border-emerald-400/60 bg-emerald-600/95"
        : recovery?.tone === "working"
          ? "border-sky-400/60 bg-sky-700/95"
          : "border-amber-400/60 bg-amber-600/95";

  return (
    <div
      role="status"
      aria-live="assertive"
      className="pointer-events-none fixed inset-x-0 top-0 z-[9600] flex justify-center px-3 pt-2"
    >
      <div className={`max-w-3xl rounded-xl border px-4 py-2 text-center text-[13px] font-semibold text-white shadow-lg ${tone}`}>
        {connection !== "online" ? (
          <>
            {connection === "offline" ? "인터넷 연결이 끊겼습니다." : "서버에 연결할 수 없습니다."}
            <span className="ml-1 font-normal opacity-90">
              끊긴 뒤의 편집은 아직 저장되지 않았습니다. 창을 닫지 마세요 — 연결되면 자동으로 저장합니다.
            </span>
          </>
        ) : (
          recovery?.text
        )}
      </div>
    </div>
  );
}

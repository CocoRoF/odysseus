/** 서버에 닿는가 — 응시 화면이 "연결이 끊겼다" 고 말할 근거.
 *
 *  `navigator.onLine` 은 **이 컴퓨터의 네트워크**만 본다. 서버 재시작·엣지 502·VPN 끊김처럼
 *  응시자가 실제로 겪는 끊김 대부분에서 true 로 남아, 저장이 조용히 실패하는 동안 화면은 아무
 *  말도 하지 않았다. 그래서 두 신호를 합친다.
 *
 *  - 브라우저의 offline/online 이벤트 — 네트워크가 사라진 것은 확실하다
 *  - API 호출의 결과 — 응답이 아예 없거나(fetch 실패) 엣지가 502·503·504 를 냈으면 "의심" 이다.
 *    의심만으로는 알리지 않는다. 앱이 낸 503("AI가 설정되지 않았습니다") 같은 정상 오류도 있으므로
 *    가벼운 health 확인(/api/healthz)이 실패해야 끊김으로 본다.
 */

type ApiSignal = "failure" | "success";

const signalListeners = new Set<(signal: ApiSignal) => void>();

/** api.ts 가 부른다 — 응답이 없었거나 게이트웨이 오류였다 */
export function reportApiFailure(): void {
  signalListeners.forEach((fn) => fn("failure"));
}

/** api.ts 가 부른다 — 서버가 응답했다 (상태 코드와 무관) */
export function reportApiSuccess(): void {
  signalListeners.forEach((fn) => fn("success"));
}

export function onApiSignal(fn: (signal: ApiSignal) => void): () => void {
  signalListeners.add(fn);
  return () => {
    signalListeners.delete(fn);
  };
}

/** 이 상태 코드는 서버(앱)가 아니라 그 앞의 게이트웨이가 낸 것일 수 있다 */
export function isGatewayStatus(status: number): boolean {
  return status === 502 || status === 503 || status === 504;
}

export type Connection = "online" | "offline" | "unreachable";

export interface MonitorTimers {
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
}

export interface MonitorDeps {
  /** 서버에 닿으면 true — 시간 제한은 호출자가 건다 */
  probe: () => Promise<boolean>;
  onChange: (state: Connection, previous: Connection) => void;
  timers?: MonitorTimers;
  backoffMs?: readonly number[];
}

export const PROBE_BACKOFF_MS = [2000, 4000, 8000, 15000] as const;

/** 연결 상태 판단기 — 브라우저 이벤트와 API 신호를 받아 확인(probe)으로 확정한다 */
export class ConnectionMonitor {
  private state: Connection = "online";
  /** 브라우저가 오프라인이라고 말하는 동안에는 확인하지 않고 online 이벤트를 기다린다 */
  private browserOff = false;
  private probing = false;
  private attempt = 0;
  private timer: unknown = null;
  private readonly deps: MonitorDeps;
  private readonly timers: MonitorTimers;
  private readonly backoffMs: readonly number[];

  constructor(deps: MonitorDeps) {
    this.deps = deps;
    this.timers = deps.timers ?? {
      set: (fn, ms) => setTimeout(fn, ms),
      clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    };
    this.backoffMs = deps.backoffMs ?? PROBE_BACKOFF_MS;
  }

  get current(): Connection {
    return this.state;
  }

  browserOffline(): void {
    this.browserOff = true;
    this.cancel();
    this.set("offline");
  }

  browserOnline(): void {
    this.browserOff = false;
    // 네트워크가 돌아왔다고 서버에 닿는 것은 아니다 — 확인해서 정한다
    void this.check();
  }

  apiSignal(signal: ApiSignal): void {
    if (this.browserOff) return;
    if (signal === "success") {
      if (this.state === "unreachable") {
        this.cancel();
        this.set("online");
      }
      return;
    }
    if (!this.probing && this.timer === null) void this.check();
  }

  dispose(): void {
    this.cancel();
  }

  private async check(): Promise<void> {
    if (this.probing) return;
    this.cancel();
    this.probing = true;
    let ok = false;
    try {
      ok = await this.deps.probe();
    } catch {
      ok = false;
    }
    this.probing = false;
    if (ok) {
      this.attempt = 0;
      if (!this.browserOff) this.set("online");
      return;
    }
    if (this.browserOff) return; // 확인하는 사이 다시 오프라인이 됐다 — online 이벤트를 기다린다
    this.set("unreachable");
    this.attempt += 1;
    const delay = this.backoffMs[Math.min(this.attempt - 1, this.backoffMs.length - 1)];
    this.timer = this.timers.set(() => {
      this.timer = null;
      void this.check();
    }, delay);
  }

  private cancel(): void {
    if (this.timer !== null) {
      this.timers.clear(this.timer);
      this.timer = null;
    }
  }

  private set(next: Connection): void {
    if (next === this.state) return;
    const previous = this.state;
    this.state = next;
    this.deps.onChange(next, previous);
  }
}

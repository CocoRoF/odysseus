import { isGatewayStatus, reportApiFailure, reportApiSuccess } from "./reachability.ts";

export class ApiError extends Error {
  status: number;
  /** 서버가 detail 을 {code, message} 로 준 경우의 안정된 코드 (예: FILE_CHANGED) */
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** 응답의 모양으로 서버 도달 여부를 알린다 — 연결 배너가 이것을 보고 health 확인을 시작한다 (lib/reachability) */
function noteReachability(res: Response): void {
  if (isGatewayStatus(res.status)) reportApiFailure();
  else reportApiSuccess();
}

/** 세션이 끝났다 — 서버가 401 을 냈다.
 *
 *  연결 배너는 502·503·504 만 본다. 그래서 세션이 만료되거나 계정이 사라지면 저장이 **조용히**
 *  실패하는 화면을 계속 보게 됐다 — 타이머는 돌고 창은 멀쩡하니 응시자는 저장되고 있다고 믿는다.
 *  손님 계정에서는 그 사이 계정 자체가 정리될 수 있어 되돌릴 방법도 없다. 그래서 한 번이라도
 *  401 이 오면 화면 전체가 알도록 여기서 신호를 낸다.
 *
 *  로그인·게스트 시작처럼 **아직 세션이 없는 것이 정상인 길**은 세지 않는다.
 */
let sessionLost = false;
const sessionWatchers = new Set<(lost: boolean) => void>();
const NO_SESSION_PATHS = ["/auth/login", "/auth/guest", "/auth/resume", "/auth/logout", "/auth/me"];

export function isSessionLost(): boolean {
  return sessionLost;
}

export function onSessionLost(fn: (lost: boolean) => void): () => void {
  sessionWatchers.add(fn);
  return () => {
    sessionWatchers.delete(fn);
  };
}

/** 다시 들어왔을 때 되돌린다 — 새 세션으로 시작하는 화면이 옛 경고를 이고 있지 않게 */
export function clearSessionLost(): void {
  if (!sessionLost) return;
  sessionLost = false;
  sessionWatchers.forEach((fn) => fn(false));
}

/** 이 브라우저에 남은 **신분에 딸린 상태**를 지운다 — 로그아웃·로그인 화면 진입에서 부른다.
 *
 *  화면 이동은 대개 클라이언트 라우팅이라 페이지가 새로 뜨지 않는다. 그래서 모듈에 들고 있는
 *  값은 계정이 바뀌어도 그대로 살아남는다. 둘러보기로 보던 사람이 나가서 게스트로 응시하려 하면
 *  지워지지 않은 잠금이 요청을 막았다(2026-09-19). 신분이 바뀌는 자리에서는 전부 되돌린다.
 */
export function resetIdentityState(): void {
  setReadOnly(false);
  clearSessionLost();
}

function noteSession(res: Response, path: string): void {
  if (res.status !== 401) return;
  if (NO_SESSION_PATHS.some((p) => path.startsWith(p))) return;
  if (sessionLost) return;
  sessionLost = true;
  sessionWatchers.forEach((fn) => fn(true));
}

/** 둘러보기 계정(demo_admin)으로 보고 있는가 — useUser 가 /auth/me 를 읽고 알려 준다.
 *
 *  서버가 이미 바꾸는 요청을 거절하지만(demo.py), 요청을 보내 놓고 403 을 받아 오면 화면마다
 *  다른 말로 실패한다. 여기서 한 번에 같은 말을 하고, 쓸데없는 왕복도 없앤다. */
let readOnly = false;
const readOnlyWatchers = new Set<(value: boolean) => void>();
export function setReadOnly(value: boolean): void {
  if (value === readOnly) return;
  readOnly = value;
  readOnlyWatchers.forEach((fn) => fn(value));
}
export function isReadOnly(): boolean {
  return readOnly;
}
/** 화면이 이 상태를 따라 바뀐다 (components/readonly.tsx) */
export function onReadOnlyChange(fn: (value: boolean) => void): () => void {
  readOnlyWatchers.add(fn);
  return () => {
    readOnlyWatchers.delete(fn);
  };
}
export const READ_ONLY_MESSAGE = "둘러보기 모드입니다. 보기만 할 수 있어요";

/** 세션 자체를 만들거나 끝내는 길 — **둘러보기 잠금의 대상이 아니다.**
 *
 *  둘러보기 잠금은 "이 계정은 아무것도 바꾸지 못한다" 는 뜻이지, "이 브라우저는 다른 사람으로
 *  들어갈 수 없다" 는 뜻이 아니다. 둘을 섞었더니 둘러보기로 보다가 나간 사람이 게스트로 응시할 때
 *  "둘러보기 모드입니다" 를 맞았다 — 서버는 멀쩡히 받아 주는 요청이었다.
 */
const SESSION_PATHS = ["/auth/login", "/auth/logout", "/auth/guest"];

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const method = (init?.method || "GET").toUpperCase();
  if (readOnly && method !== "GET" && !SESSION_PATHS.some((p) => path === p || path.startsWith(`${p}/`))) {
    throw new ApiError(403, READ_ONLY_MESSAGE, "READ_ONLY");
  }
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      credentials: "include",
      headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
      ...init,
    });
  } catch (e) {
    reportApiFailure();
    throw e;
  }
  noteReachability(res);
  noteSession(res, path);
  if (!res.ok) {
    let detail = res.statusText;
    let code: string | undefined;
    try {
      const body = await res.json();
      if (typeof body.detail === "string") {
        detail = body.detail;
      } else if (body.detail && typeof body.detail === "object" && typeof body.detail.message === "string") {
        // 화면이 분기해야 하는 실패(편집 충돌 등)는 코드와 문구를 함께 준다
        detail = body.detail.message;
        code = typeof body.detail.code === "string" ? body.detail.code : undefined;
      } else if (Array.isArray(body.detail)) {
        // FastAPI 검증 실패(422) — 원본은 {loc, msg, type} 목록이라 그대로 보여주면
        // 사용자가 읽을 수 없는 덩어리가 된다. 필드 이름과 사유만 남긴다.
        detail = body.detail
          .map((d: { loc?: unknown[]; msg?: string }) => {
            const field = Array.isArray(d.loc) ? String(d.loc[d.loc.length - 1] ?? "") : "";
            return field ? `${field}: ${d.msg ?? ""}` : (d.msg ?? "");
          })
          .filter(Boolean)
          .join(", ") || JSON.stringify(body.detail);
      } else {
        detail = JSON.stringify(body.detail ?? body);
      }
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, detail, code);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "PUT", body: JSON.stringify(body) }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "PATCH", body: JSON.stringify(body) }),
  del: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};

/** 에이전트 스트림이 실패로 끝났을 때 서버가 알려 준 것 — 코드가 없으면 HTTP 단계에서 막힌 것이다 */
export interface AgentStreamError {
  /** 서버의 안정된 오류 코드 (ai/errors.py) */
  code?: string;
  correlationId?: string;
  /** 서버가 이 질문을 돌려주었는가 — 기록할 때 정해진 값 */
  refunded?: boolean;
}

/** 서버에 닿지 못했을 때의 안내 — 원인(상태 코드·예외 이름)은 응시자에게 도움이 되지 않는다 */
const UNREACHABLE = "서버에 연결할 수 없습니다. 연결을 확인하고 다시 보내 주세요";

/** 에이전트 SSE 스트리밍 (fetch 기반 — 쿠키 인증 유지)
 *
 *  어떤 실패든 onError 로 끝난다. 예전에는 네트워크 오류가 예외로 튀어나가 호출자의 '응답 대기'
 *  표시가 영영 풀리지 않았다. `signal` 로 멈춘 경우만 예외다 — 오류가 아니므로 아무것도 알리지
 *  않고 끝나며, 무엇이 기록됐는지는 호출부가 서버에서 다시 읽는다. */
/** 에이전트 스트림도 같은 규칙을 따른다 — 둘러보기 계정은 응시 화면 자체에 들어가지 못하지만,
 *  경로가 하나만 열려 있어도 규칙이 갈라진다. */
export async function streamAgentChat(
  attemptId: string,
  scenarioId: string,
  content: string,
  handlers: {
    onDelta: (text: string) => void;
    onDone: () => void;
    onError: (message: string, info?: AgentStreamError) => void;
    onTool?: (name: string, detail: string) => void;
  },
  /** [중단] 을 누르면 이 신호로 스트림을 끊는다. 응답 헤더가 오기 전이어도 같다. */
  signal?: AbortSignal,
): Promise<void> {
  if (readOnly) {
    handlers.onError(READ_ONLY_MESSAGE);
    return;
  }
  let res: Response;
  try {
    res = await fetch(`/api/attempts/${attemptId}/scenarios/${scenarioId}/agent/messages`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
      signal,
    });
  } catch {
    // 응답이 오기 전에 멈췄다 — 서버에 닿지 못한 것이 아니므로 연결 경고를 띄우지 않는다
    if (signal?.aborted) return;
    reportApiFailure();
    handlers.onError(UNREACHABLE);
    return;
  }
  noteReachability(res);
  if (!res.ok || !res.body) {
    // 409(진행 중)·429(한도)·503(설정 없음)은 서버가 사유를 말한다. 엣지가 낸 502·504 는 본문이 JSON 이 아니다.
    let detail = res.status >= 500 ? UNREACHABLE : "요청을 처리하지 못했습니다";
    try {
      const data = await res.json();
      if (typeof data.detail === "string") detail = data.detail;
    } catch {
      /* ignore */
    }
    handlers.onError(detail);
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let ended = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        try {
          const data = JSON.parse(line.slice(5).trim());
          if (data.delta) handlers.onDelta(data.delta);
          if (data.tool) handlers.onTool?.(data.tool.name, data.tool.detail ?? "");
          if (data.error) {
            ended = true;
            handlers.onError(data.error, {
              code: data.code,
              correlationId: data.correlation_id,
              refunded: data.refunded === true,
            });
          }
          if (data.done) {
            ended = true;
            handlers.onDone();
          }
        } catch {
          /* 부분 청크 무시 */
        }
      }
    }
  } catch {
    if (signal?.aborted) return;
    // 도중에 연결이 끊겼다 — 서버가 무엇이 나왔는가로 소모 여부를 정해 기록한다
    if (!ended) handlers.onError("연결이 끊겨 답변을 받지 못했습니다", { code: "AI_DISCONNECTED" });
    return;
  }
  handlers.onDone();
}


/** 시나리오 대화형 설계 SSE — 대화 텍스트(delta)와 검증된 편집 명령(edit)이 섞여 온다 */
export async function streamScenarioAuthor(
  body: { messages: { role: "user" | "assistant"; content: string }[]; draft: unknown; provider_id?: string },
  handlers: {
    onDelta: (text: string) => void;
    onEdit: (op: import("./types").AuthorOp, label: string) => void;
    onWarning: (text: string) => void;
    onDone: (scenario: import("./types").ScenarioDraft, warnings: string[], raw: string) => void;
    onError: (message: string) => void;
  },
  signal?: AbortSignal,
): Promise<void> {
  if (readOnly) {
    handlers.onError(READ_ONLY_MESSAGE);
    return;
  }
  const res = await fetch(`/api/scenarios/author/stream`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    let detail = `HTTP ${res.status}`;
    try {
      const data = await res.json();
      if (typeof data.detail === "string") detail = data.detail;
    } catch {
      /* ignore */
    }
    handlers.onError(detail);
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finished = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      try {
        const data = JSON.parse(line.slice(5).trim());
        if (data.delta) handlers.onDelta(data.delta);
        if (data.edit) handlers.onEdit(data.edit, data.label ?? "");
        if (data.warning) handlers.onWarning(data.warning);
        if (data.error) handlers.onError(data.error);
        if (data.done) {
          finished = true;
          handlers.onDone(data.scenario, data.warnings ?? [], data.raw ?? "");
        }
      } catch {
        /* 부분 청크 무시 */
      }
    }
  }
  if (!finished) handlers.onError("응답이 끝나기 전에 연결이 끊겼습니다");
}

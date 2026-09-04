export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
    ...init,
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail ?? body);
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, detail);
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

/** 에이전트 SSE 스트리밍 (fetch 기반 — 쿠키 인증 유지) */
export async function streamAgentChat(
  attemptId: string,
  scenarioId: string,
  content: string,
  handlers: {
    onDelta: (text: string) => void;
    onDone: () => void;
    onError: (message: string) => void;
    onTool?: (name: string, detail: string) => void;
  },
): Promise<void> {
  const res = await fetch(`/api/attempts/${attemptId}/scenarios/${scenarioId}/agent/messages`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
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
        if (data.error) handlers.onError(data.error);
        if (data.done) handlers.onDone();
      } catch {
        /* 부분 청크 무시 */
      }
    }
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

/** 편집기 저장기 — IDE·문서·표가 같은 규칙으로 파일을 서버에 쓴다.
 *
 *  채점은 **서버가 가진 파일**만 본다. 편집기 안에만 있는 글자는 존재하지 않는 것과 같아서,
 *  저장의 작은 틈 하나가 곧 작업 유실이다. 그래서 규칙을 한곳에 모으고 React 없이 시험한다
 *  (autosave.test.ts).
 *
 *  1. **더티는 내용으로 판단한다.** "저장이 끝났다" 가 아니라 "지금 내용이 서버에 쓴 내용과
 *     같다" 일 때만 저장됨이다. 저장 요청이 떠 있는 사이 친 글자가 저장됨으로 표시되던 경합이
 *     여기서 사라진다.
 *  2. **한 경로의 쓰기는 한 번에 하나.** 줄 선 쓰기는 실행되는 순간의 최신 내용을 쓴다 —
 *     예전 내용의 요청이 나중에 도착해 새 내용을 덮는 일이 없다.
 *  3. **서버가 바뀌었으면 덮지 않는다.** 쓰기에는 읽은 버전(sha256)을 싣고, 서버가 그 사이
 *     바뀌었으면(에이전트·터미널) 자동 저장을 멈추고 응시자에게 고르게 한다.
 *  4. **실패는 사실대로, 재시도는 알아서.** 연결 문제는 간격을 늘려 가며 다시 시도하고,
 *     다시 해도 안 되는 실패(시험 종료·용량 초과)는 이유를 보여 주고 멈춘다.
 */

export type SaveStatus =
  | { kind: "saved" }
  /** 편집됨 — 멈추면 저장한다 */
  | { kind: "pending" }
  | { kind: "saving" }
  /** 연결 문제 — 간격을 두고 다시 시도하는 중 */
  | { kind: "retrying"; attempt: number }
  /** 다시 해도 안 되는 실패 — 편집하거나 직접 저장하면 한 번 더 시도한다 */
  | { kind: "blocked"; message: string }
  /** 서버의 파일이 밖에서 바뀌었거나 사라졌다 — 응시자가 고를 때까지 쓰지 않는다 */
  | { kind: "conflict"; deleted: boolean };

export type SaveFailure =
  | { kind: "conflict"; deleted: boolean }
  | { kind: "retryable" }
  | { kind: "blocked"; message: string };

export interface ServerFile {
  content: string;
  sha256: string;
}

export interface Timers {
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
}

export interface SaverDeps {
  /** baseSha 가 있으면 조건부 저장 — 서버가 그 버전이 아니면 충돌로 실패해야 한다 */
  write: (path: string, content: string, baseSha: string | null) => Promise<{ sha256: string }>;
  /** 결과를 모르는 채 끝난 쓰기 뒤에 서버의 실제 내용을 확인한다. 파일이 없으면 null */
  read: (path: string) => Promise<ServerFile | null>;
  classify: (err: unknown) => SaveFailure;
  onChange: (path: string) => void;
  debounceMs?: number;
  backoffMs?: readonly number[];
  timers?: Timers;
}

export const AUTOSAVE_MS = 2000;
export const RETRY_BACKOFF_MS = [2000, 4000, 8000, 15000, 30000] as const;

interface Doc {
  content: string;
  /** 이 편집기가 서버에 있다고 확인한 내용 */
  saved: string;
  /** saved 의 서버 버전 — 조건부 저장의 기준 */
  sha: string | null;
  /** 이 편집기가 보았거나 쓴 버전들 — 파일 목록에 뒤늦게 온 옛 버전을 밖의 변경으로 오인하지 않는다 */
  known: Set<string>;
  status: SaveStatus;
  timer: unknown;
  writing: boolean;
  attempt: number;
  /** 결과를 모르는 채 끝난 쓰기의 내용 — 다음 시도 전에 서버가 이것을 가졌는지 본다 */
  uncertain: string | null;
  /** 응시자가 충돌에서 "내 편집으로 덮어쓰기" 를 골랐다 */
  force: boolean;
  lastSavedAt: number | null;
  /** open() 으로 새로 읽으면 바뀐다 — 그 전에 떠난 쓰기의 결과는 버린다 */
  gen: number;
}

const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class FileSaver {
  private docs = new Map<string, Doc>();
  private chains = new Map<string, Promise<unknown>>();
  private gens = 0;
  private retired: (() => void) | null = null;
  private readonly debounceMs: number;
  private readonly backoffMs: readonly number[];
  private readonly timers: Timers;
  private readonly deps: SaverDeps;

  constructor(deps: SaverDeps) {
    this.deps = deps;
    this.debounceMs = deps.debounceMs ?? AUTOSAVE_MS;
    this.backoffMs = deps.backoffMs ?? RETRY_BACKOFF_MS;
    this.timers = deps.timers ?? realTimers;
  }

  // ── 읽기 ──

  status(path: string): SaveStatus | null {
    return this.docs.get(path)?.status ?? null;
  }

  isDirty(path: string): boolean {
    const doc = this.docs.get(path);
    return Boolean(doc && (doc.content !== doc.saved || doc.force));
  }

  dirtyPaths(): string[] {
    return [...this.docs.keys()].filter((p) => this.isDirty(p));
  }

  lastSavedAt(path: string): number | null {
    return this.docs.get(path)?.lastSavedAt ?? null;
  }

  // ── 문서 수명 ──

  /** 서버에서 읽은 내용으로 기준을 세운다. 편집 중이던 내용은 버린다 (불러오기·되돌리기) */
  open(path: string, content: string, sha: string | null): void {
    const prev = this.docs.get(path);
    if (prev) this.clearTimer(prev);
    this.gens += 1;
    this.docs.set(path, {
      content,
      saved: content,
      sha,
      known: new Set([...(prev?.known ?? []), ...(sha ? [sha] : [])]),
      status: { kind: "saved" },
      timer: null,
      writing: false,
      attempt: 0,
      uncertain: null,
      force: false,
      lastSavedAt: prev?.lastSavedAt ?? null,
      gen: this.gens,
    });
    this.changed(path);
  }

  close(path: string): void {
    const doc = this.docs.get(path);
    if (!doc) return;
    this.clearTimer(doc);
    this.docs.delete(path);
    this.changed(path);
  }

  rename(from: string, to: string): void {
    const doc = this.docs.get(from);
    if (!doc) return;
    this.docs.delete(from);
    this.docs.set(to, doc);
    this.changed(from);
    this.changed(to);
  }

  // ── 편집 ──

  edit(path: string, content: string): void {
    const doc = this.docs.get(path);
    if (!doc || doc.content === content) return;
    doc.content = content;
    const kind = doc.status.kind;
    // 충돌은 응시자가 고를 때까지 쓰지 않는다. 재시도 중이면 예약된 시도가 최신 내용을 가져간다 —
    // 타이핑할 때마다 재시도를 앞당기면 끊긴 서버를 두드리기만 한다.
    if (kind === "conflict" || kind === "retrying") return this.changed(path);
    if (!this.isDirty(path) && !doc.writing) {
      this.clearTimer(doc);
      doc.status = { kind: "saved" };
      return this.changed(path);
    }
    if (!doc.writing) doc.status = { kind: "pending" };
    this.schedule(path, doc, this.debounceMs);
    this.changed(path);
  }

  /** 지금 내용을 서버에 둔다고 보고 편집을 버린다 — 되돌리기 직전에 예약된 저장을 없앤다 */
  discard(path: string): void {
    const doc = this.docs.get(path);
    if (!doc) return;
    this.clearTimer(doc);
    doc.content = doc.saved;
    doc.force = false;
    doc.status = { kind: "saved" };
    this.changed(path);
  }

  // ── 저장 ──

  /** 지금 저장한다. true 면 이 호출이 실행된 시점의 내용이 서버에 있다 */
  save(path: string): Promise<boolean> {
    const doc = this.docs.get(path);
    if (doc) this.clearTimer(doc);
    return this.serial(path, () => this.writeOnce(path));
  }

  /** 충돌에서 응시자가 "내 편집으로 덮어쓰기" 를 골랐다 */
  keepMine(path: string): Promise<boolean> {
    const doc = this.docs.get(path);
    if (!doc) return Promise.resolve(true);
    doc.force = true;
    doc.status = { kind: "pending" };
    this.changed(path);
    return this.save(path);
  }

  /** 한 파일의 편집을 서버에 밀어 넣는다 — 그 사이 계속 편집되면 몇 번 따라간다 */
  async flushOne(path: string): Promise<boolean> {
    for (let round = 0; round < 3; round += 1) {
      const doc = this.docs.get(path);
      if (!doc) return true;
      if (!this.isDirty(path) && doc.uncertain === null && !this.chains.has(path)) return true;
      if (doc.status.kind === "conflict" && !doc.force) return false;
      if (!(await this.save(path))) return false;
    }
    return !this.isDirty(path);
  }

  /** 모든 편집을 밀어 넣는다. 저장하지 못한 경로를 돌려준다 */
  async flush(): Promise<string[]> {
    const failed: string[] = [];
    await Promise.all(
      [...this.docs.keys()].map(async (path) => {
        if (!(await this.flushOne(path))) failed.push(path);
      }),
    );
    return failed;
  }

  // ── 밖에서 온 변경 ──

  /** 파일 목록이 알려 준 서버 버전을 본다.
   *  "reload" — 편집하지 않은 문서라 다시 읽으면 된다. "conflict" — 편집 중이라 자동 저장을 멈췄다. */
  noteServerVersion(path: string, sha: string): "same" | "reload" | "conflict" {
    const doc = this.docs.get(path);
    // 쓰는 중이면 목록이 그 쓰기보다 앞이거나 뒤일 수 있다 — 끝난 뒤의 목록으로 판단한다
    if (!doc || doc.known.has(sha) || doc.writing || this.chains.has(path)) return "same";
    // 결과를 모르는 쓰기가 있다 — 모르는 버전은 그 쓰기일 수 있다. 다음 시도가 서버를 읽고 판단한다.
    if (doc.uncertain !== null) return "same";
    if (doc.status.kind === "conflict") return "conflict";
    if (this.isDirty(path)) {
      this.clearTimer(doc);
      doc.status = { kind: "conflict", deleted: false };
      this.changed(path);
      return "conflict";
    }
    return "reload";
  }

  // ── 편집기가 사라질 때 ──

  /** 창이 닫혔다. 남은 편집은 끝까지 저장하고, 더 할 수 있는 일이 없을 때 done 을 부른다.
   *  돌려받는 경로는 결국 저장하지 못한 것들이다 (충돌·차단). */
  retire(done: (unsaved: string[]) => void): void {
    this.retired = () => {
      const stuck = this.dirtyPaths();
      const working = stuck.some((p) => {
        const kind = this.docs.get(p)?.status.kind;
        return kind === "pending" || kind === "saving" || kind === "retrying" || this.chains.has(p);
      });
      if (working) return;
      this.retired = null;
      this.dispose();
      done(stuck);
    };
    void this.flush().then(() => this.retired?.());
  }

  dispose(): void {
    for (const doc of this.docs.values()) this.clearTimer(doc);
  }

  // ── 내부 ──

  private async writeOnce(path: string): Promise<boolean> {
    const doc = this.docs.get(path);
    if (!doc) return true;
    if (doc.status.kind === "conflict" && !doc.force) return false;
    if (!this.isDirty(path) && doc.uncertain === null) {
      if (doc.status.kind !== "saved") {
        doc.status = { kind: "saved" };
        this.changed(path);
      }
      return true;
    }
    const gen = doc.gen;
    const snapshot = doc.content;
    doc.writing = true;
    doc.status = { kind: "saving" };
    this.changed(path);
    let stage: "read" | "write" = "read";
    try {
      if (doc.uncertain !== null) {
        // 지난 쓰기의 결과를 모른다(응답 전에 연결이 끊김). 서버가 이미 그 내용을 가졌으면 그것을 기준으로
        // 삼아야, 이어지는 쓰기가 "내가 쓴 것" 과 충돌하지 않는다.
        const server = await this.deps.read(path);
        if (gen !== doc.gen) return false;
        if (server && (server.content === doc.uncertain || server.content === doc.saved)) {
          doc.saved = server.content;
          doc.sha = server.sha256;
          doc.known.add(server.sha256);
        }
        doc.uncertain = null;
        if (!this.isDirty(path)) {
          this.settle(path, doc);
          return true;
        }
      }
      stage = "write";
      const result = await this.deps.write(path, snapshot, doc.force ? null : doc.sha);
      if (gen !== doc.gen) return false;
      doc.saved = snapshot;
      doc.sha = result.sha256;
      doc.known.add(result.sha256);
      doc.attempt = 0;
      doc.force = false;
      doc.lastSavedAt = Date.now();
      this.settle(path, doc);
      return true;
    } catch (err) {
      if (gen !== doc.gen) return false;
      doc.writing = false;
      const failure = this.deps.classify(err);
      if (failure.kind === "conflict") {
        doc.force = false;
        doc.status = { kind: "conflict", deleted: failure.deleted };
      } else if (failure.kind === "retryable") {
        if (stage === "write") doc.uncertain = snapshot;
        doc.attempt += 1;
        doc.status = { kind: "retrying", attempt: doc.attempt };
        const delay = this.backoffMs[Math.min(doc.attempt - 1, this.backoffMs.length - 1)];
        this.schedule(path, doc, delay);
      } else {
        doc.status = { kind: "blocked", message: failure.message };
      }
      this.changed(path);
      return false;
    }
  }

  /** 쓰기가 끝난 뒤의 상태 — 그 사이 편집이 있었으면 저장됨이 아니다 */
  private settle(path: string, doc: Doc): void {
    doc.writing = false;
    if (this.isDirty(path)) {
      doc.status = { kind: "pending" };
      if (!doc.timer) this.schedule(path, doc, this.debounceMs);
    } else {
      doc.status = { kind: "saved" };
    }
    this.changed(path);
  }

  private serial<T>(path: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(path) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => undefined);
    this.chains.set(path, tail);
    void tail.then(() => {
      if (this.chains.get(path) === tail) this.chains.delete(path);
      this.retired?.();
    });
    return run;
  }

  private schedule(path: string, doc: Doc, ms: number): void {
    this.clearTimer(doc);
    doc.timer = this.timers.set(() => {
      doc.timer = null;
      void this.save(path);
    }, ms);
  }

  private clearTimer(doc: Doc): void {
    if (doc.timer !== null) {
      this.timers.clear(doc.timer);
      doc.timer = null;
    }
  }

  private changed(path: string): void {
    this.deps.onChange(path);
  }
}

/** 저장 실패를 세 갈래로 나눈다 — ApiError 모양(status·code)만 본다. */
export function classifySaveError(err: unknown): SaveFailure {
  const status = (err as { status?: unknown } | null)?.status;
  const code = (err as { code?: unknown } | null)?.code;
  // fetch 자체가 실패했다 — 서버에 닿지 못한 것이다
  if (typeof status !== "number") return { kind: "retryable" };
  if (status === 409 && (code === "FILE_CHANGED" || code === "FILE_DELETED")) {
    return { kind: "conflict", deleted: code === "FILE_DELETED" };
  }
  if (status >= 500 || status === 429 || status === 408) return { kind: "retryable" };
  const message = err instanceof Error && err.message ? err.message : "저장할 수 없습니다";
  return { kind: "blocked", message };
}

/** 상태 줄의 문구 — 응시자가 지금 안전한지 한눈에 알 수 있어야 한다 */
export function saveStatusText(status: SaveStatus | null, savedAt?: number | null): string {
  switch (status?.kind) {
    case "pending":
      return "편집 중 — 멈추면 자동 저장";
    case "saving":
      return "저장 중…";
    case "retrying":
      return "저장 실패 — 연결되면 다시 저장합니다";
    case "blocked":
      return `저장할 수 없음 — ${status.message}`;
    case "conflict":
      return status.deleted ? "다른 곳에서 삭제됨 — 자동 저장 멈춤" : "다른 곳에서 바뀜 — 자동 저장 멈춤";
    case "saved":
      return savedAt
        ? `저장됨 ${new Date(savedAt).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}`
        : "저장됨";
    default:
      return "";
  }
}

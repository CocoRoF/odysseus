/** 되돌리기·다시하기 — 값 하나를 통째로 기억하는 가장 단순한 방식.
 *
 *  표나 글처럼 "지금 상태"가 하나의 값인 편집기에서는, 무엇이 바뀌었는지를 따로 적는 것보다 그때의
 *  값을 통째로 두는 편이 훨씬 안전하다. 되돌리기가 빗나가는 대부분의 버그는 변경 기록과 실제 상태가
 *  어긋나서 생기기 때문이다. 대신 개수를 제한해 기억이 무한히 늘지 않게 한다.
 *
 *  **묶기(coalesce)** 가 하나 필요하다. 한 칸에 "1234" 를 치면 네 번 바뀌는데, 되돌리기 한 번에
 *  네 번 되돌아가야 사람의 기대와 맞는다. 같은 자리(label)에서 짧은 시간 안에 이어진 변화는 한 걸음으로
 *  합친다.
 */

export interface HistoryOptions {
  /** 기억할 최대 걸음 수 */
  limit?: number;
  /** 같은 자리에서 이 시간(ms) 안에 이어진 변화는 한 걸음으로 묶는다 */
  coalesceMs?: number;
  /** 지금 시각 — 테스트가 시계를 쥔다 */
  now?: () => number;
}

interface Step<T> {
  value: T;
  label: string;
  at: number;
}

export class History<T> {
  private past: Step<T>[] = [];
  private future: Step<T>[] = [];
  private current: Step<T>;
  private readonly limit: number;
  private readonly coalesceMs: number;
  private readonly now: () => number;

  constructor(initial: T, options: HistoryOptions = {}) {
    this.limit = options.limit ?? 200;
    this.coalesceMs = options.coalesceMs ?? 600;
    this.now = options.now ?? (() => Date.now());
    this.current = { value: initial, label: "init", at: this.now() };
  }

  get value(): T {
    return this.current.value;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  /** 새 상태를 올린다. ``label`` 이 같고 시간이 가까우면 앞 걸음에 합친다. */
  push(value: T, label = ""): void {
    const at = this.now();
    const mergeable =
      label !== "" && label === this.current.label && at - this.current.at <= this.coalesceMs;
    if (!mergeable) {
      this.past.push(this.current);
      if (this.past.length > this.limit) this.past.shift();
    }
    this.current = { value, label, at };
    this.future = [];
  }

  /** 되돌리기 전에 지금 상태를 걸음으로 못 박는다 — 묶기가 다음 입력을 삼키지 않게. */
  seal(): void {
    this.current = { ...this.current, label: "" };
  }

  /** 되돌린다. 더 되돌릴 것이 없으면 지금 값을 그대로 돌려준다. */
  undo(): T {
    const prev = this.past.pop();
    if (!prev) return this.current.value;
    this.future.push(this.current);
    this.current = prev;
    return this.current.value;
  }

  redo(): T {
    const next = this.future.pop();
    if (!next) return this.current.value;
    this.past.push(this.current);
    this.current = next;
    return this.current.value;
  }

  /** 다른 파일을 열었다 — 이력을 통째로 새로 시작한다. */
  reset(value: T): void {
    this.past = [];
    this.future = [];
    this.current = { value, label: "reset", at: this.now() };
  }
}

/** 이 키 조합이 되돌리기/다시하기인가 — 창마다 따로 적으면 반드시 어긋난다.
 *
 *  윈도우 관습: 되돌리기는 Ctrl+Z, 다시하기는 Ctrl+Y 와 Ctrl+Shift+Z 둘 다 쓴다(문서 프로그램과
 *  IDE 가 서로 다르게 굳었다). 맥은 Cmd+Z / Cmd+Shift+Z 다. 셋 다 받는다.
 */
export function undoRedoIntent(e: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): "undo" | "redo" | null {
  if (!(e.ctrlKey || e.metaKey)) return null;
  const key = e.key.toLowerCase();
  if (key === "z") return e.shiftKey ? "redo" : "undo";
  if (key === "y" && !e.metaKey) return "redo";
  return null;
}

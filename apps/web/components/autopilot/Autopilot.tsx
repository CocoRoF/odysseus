"use client";

/** 자동 진행 — 계획(plans.ts)을 시험 화면 위에서 사람이 하듯 실행한다.
 *
 *  보이는 커서가 버튼까지 움직여 누르고, 입력칸에는 사람 속도로 친다. 동료의 답장과 에이전트의 작업은 화면의 표시가
 *  끝날 때까지 기다린다. 앱이 받는 것은 실제 클릭·입력과 같은 DOM 이벤트라, 서버에는 사람이 한 것과 똑같은 기록이 남는다.
 *
 *  보는 사람이 끼어들어 순서가 꼬이지 않게 진행 중에는 실제 마우스·키보드 입력을 막는다(위의 진행 막대만 받는다).
 *  [일시정지] 하면 막이 걷혀 직접 만질 수 있고, [직접 하기] 를 누르면 자동 진행을 끝내고 그 자리부터 사람이 이어 한다.
 *  진행 단계는 이 탭의 sessionStorage 에 남겨 새로 고침 뒤에는 멈춘 채로 다시 뜬다(이어서 할지 사람이 정한다).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { autopilotKey } from "./catalog";
import { planFor, type Step } from "./plans";

type Status = "running" | "paused" | "error" | "done";

class Stopped extends Error {}

type MonacoEditor = {
  getDomNode(): HTMLElement | null;
  getModel(): { getFullModelRange(): unknown; getLineCount(): number; getLineMaxColumn(n: number): number } | null;
  executeEdits(source: string, edits: { range: unknown; text: string }[]): boolean;
  setSelection(range: unknown): void;
  setPosition(p: { lineNumber: number; column: number }): void;
  revealLine(n: number): void;
  focus(): void;
};
type MonacoGlobal = { editor: { getEditors(): MonacoEditor[] }; Range: new (a: number, b: number, c: number, d: number) => unknown };

const APP_IDS: Record<string, string> = {
  메신저: "messenger",
  IDE: "ide",
  터미널: "terminal",
  "AI 에이전트": "agent",
  문서: "docs",
};

const visible = (el: Element | null): el is HTMLElement =>
  !!el && el instanceof HTMLElement && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";

function byText(root: ParentNode, selector: string, text: string, exact = false): HTMLElement | null {
  for (const el of Array.from(root.querySelectorAll<HTMLElement>(selector))) {
    const t = (el.textContent || "").trim();
    if ((exact ? t === text : t.includes(text)) && visible(el)) return el;
  }
  return null;
}

/** React 가 관리하는 입력칸에 값을 넣는다 — 값을 바로 바꾸면 React 가 모르므로 원래 setter 로 넣고 input 을 알린다 */
function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function key(target: EventTarget, k: string, mods: { ctrlKey?: boolean } = {}) {
  target.dispatchEvent(new KeyboardEvent("keydown", { key: k, code: k === " " ? "Space" : k, bubbles: true, cancelable: true, ...mods }));
}

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export function Autopilot({
  attemptId,
  title,
  initialStep,
  startPaused,
  onExit,
}: {
  attemptId: string;
  title: string;
  initialStep: number;
  startPaused: boolean;
  onExit: () => void;
}) {
  const plan = planFor(title);
  const [stepIdx, setStepIdx] = useState(initialStep);
  const [status, setStatus] = useState<Status>(startPaused ? "paused" : "running");
  const [detail, setDetail] = useState("");
  const statusRef = useRef<Status>(status);
  statusRef.current = status;
  const stopped = useRef(false);
  const cursorRef = useRef<HTMLDivElement | null>(null);
  const rippleRef = useRef<HTMLDivElement | null>(null);
  const pos = useRef({ x: typeof window !== "undefined" ? window.innerWidth / 2 : 600, y: typeof window !== "undefined" ? window.innerHeight / 2 : 400 });
  const barRef = useRef<HTMLDivElement | null>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // ── 기다림과 멈춤 ───────────────────────────────────────────
  /** 멈춰 있으면 풀릴 때까지 기다리고, 끝났으면 던진다. 모든 동작 사이에 부른다. */
  const gate = useCallback(async () => {
    while (statusRef.current === "paused" || statusRef.current === "error") {
      if (stopped.current) throw new Stopped();
      await new Promise((r) => setTimeout(r, 120));
    }
    if (stopped.current) throw new Stopped();
  }, []);
  const sleep = useCallback(
    async (ms: number) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        await gate();
        await new Promise((r) => setTimeout(r, Math.min(100, Math.max(0, end - Date.now()))));
      }
      await gate();
    },
    [gate],
  );
  const waitFor = useCallback(
    async <T,>(fn: () => T | null | undefined | false, timeoutMs: number, what: string): Promise<T> => {
      const end = Date.now() + timeoutMs;
      for (;;) {
        await gate();
        const v = fn();
        if (v) return v as T;
        if (Date.now() > end) throw new Error(`${what}을(를) 찾지 못했습니다`);
        await new Promise((r) => setTimeout(r, 150));
      }
    },
    [gate],
  );

  // ── 커서 ──────────────────────────────────────────────────
  const place = (x: number, y: number) => {
    pos.current = { x, y };
    if (cursorRef.current) cursorRef.current.style.transform = `translate(${x}px, ${y}px)`;
  };
  const moveTo = useCallback(
    async (el: Element) => {
      await gate();
      const r = el.getBoundingClientRect();
      const tx = r.left + Math.min(r.width / 2, 160);
      const ty = r.top + r.height / 2;
      const { x: sx, y: sy } = pos.current;
      const dist = Math.hypot(tx - sx, ty - sy);
      const dur = Math.max(260, Math.min(760, dist * 0.9));
      const t0 = performance.now();
      await new Promise<void>((done) => {
        const tick = (now: number) => {
          const t = Math.min(1, (now - t0) / dur);
          const e = ease(t);
          place(sx + (tx - sx) * e, sy + (ty - sy) * e);
          if (t < 1) requestAnimationFrame(tick);
          else done();
        };
        requestAnimationFrame(tick);
      });
    },
    [gate],
  );
  const click = useCallback(
    async (el: HTMLElement, after = 350) => {
      await moveTo(el);
      const rp = rippleRef.current;
      if (rp) {
        rp.style.transform = `translate(${pos.current.x - 18}px, ${pos.current.y - 18}px)`;
        rp.classList.remove("autopilot-ripple-go");
        void rp.offsetWidth;
        rp.classList.add("autopilot-ripple-go");
      }
      el.focus?.({ preventScroll: true });
      el.click();
      await sleep(after);
    },
    [moveTo, sleep],
  );
  /** 사람 속도로 친다(초당 cps 글자). 화면마다 몇 글자씩 더해 넣는다. */
  const type = useCallback(
    async (el: HTMLInputElement | HTMLTextAreaElement, text: string, cps = 32) => {
      await click(el, 120);
      let shown = 0;
      let last = performance.now();
      setNativeValue(el, "");
      while (shown < text.length) {
        await gate();
        await new Promise((r) => requestAnimationFrame(r));
        const now = performance.now();
        const add = Math.max(1, Math.round(((now - last) / 1000) * cps));
        last = now;
        shown = Math.min(text.length, shown + add);
        setNativeValue(el, text.slice(0, shown));
        if (el instanceof HTMLTextAreaElement) el.scrollTop = el.scrollHeight;
      }
      await sleep(250);
    },
    [click, gate, sleep],
  );

  // ── 앱 다루기 ─────────────────────────────────────────────
  const appRoot = (id: string) => document.querySelector<HTMLElement>(`[data-app="${id}"]`);
  /** 바탕화면 아이콘을 눌러 앱을 연다(열려 있으면 앞으로). 아이콘이 창에 가려 있으면 창들을 먼저 내린다. */
  const openApp = useCallback(
    async (label: string) => {
      const id = APP_IDS[label];
      const icon = await waitFor(
        () => document.querySelector<HTMLElement>(`[data-desktop-icons] button[title="${label}"]`),
        15000,
        `${label} 아이콘`,
      );
      const r = icon.getBoundingClientRect();
      // 자동 진행의 막·커서는 빼고, 그 아래 실제로 무엇이 아이콘 자리를 덮고 있는지 본다
      const hit = document
        .elementsFromPoint(r.left + r.width / 2, r.top + r.height / 2)
        .find((el) => !el.closest(".autopilot-shield, .autopilot-cursor, .autopilot-ripple, .autopilot-bar"));
      const covered = !hit || !icon.contains(hit);
      if (covered) {
        document.querySelectorAll<HTMLElement>('[data-app] button[title="최소화"]').forEach((b) => b.click());
        await sleep(500);
      }
      await click(icon, 900);
      await waitFor(() => visible(appRoot(id)) && appRoot(id), 15000, `${label} 창`);
    },
    [click, sleep, waitFor],
  );

  const ask = useCallback(
    async (who: string, text: string) => {
      await openApp("메신저");
      const root = appRoot("messenger")!;
      const contact = await waitFor(() => byText(root, "button", who), 10000, `${who} 대화`);
      await click(contact, 900);
      const box = await waitFor(() => root.querySelector<HTMLTextAreaElement>("textarea"), 10000, "메시지 입력칸");
      await type(box, text, 34);
      const send = box.parentElement?.querySelector<HTMLButtonElement>("button");
      if (send && !send.disabled) await click(send, 600);
      else key(box, "Enter");
      // 답장이 오기 시작했다가(…중) 끝날 때까지
      const waiting = () => (root.textContent || "").includes("답장을 기다리는 중");
      await waitFor(waiting, 6000, "답장 시작").catch(() => undefined);
      await waitFor(() => !waiting(), 240000, "답장");
      await sleep(4500);
    },
    [openApp, waitFor, click, type, sleep],
  );

  /** IDE 탐색기에서 파일을 연다. 폴더가 접혀 있으면 펼친다. */
  const openInIde = useCallback(
    async (path: string, after = 2400) => {
      const root = appRoot("ide")!;
      const parts = path.split("/");
      const name = parts[parts.length - 1];
      const rowOf = (n: string) => byText(root, "span", n, true)?.parentElement ?? null;
      let row = rowOf(name);
      if (!row && parts.length > 1) {
        const folder = rowOf(parts[parts.length - 2]);
        if (folder) await click(folder, 500);
        row = rowOf(name);
      }
      await click(await waitFor(() => row ?? rowOf(name), 10000, `${path} 파일`), after);
    },
    [click, waitFor],
  );

  const ideEditor = (): MonacoEditor | null => {
    const m = (window as unknown as { monaco?: MonacoGlobal }).monaco;
    const eds = m?.editor.getEditors() ?? [];
    return eds.find((e) => {
      const n = e.getDomNode();
      return !!n && !!n.closest('[data-app="ide"]') && n.offsetParent !== null;
    }) ?? null;
  };

  const edit = useCallback(
    async (path: string, content: string) => {
      await openApp("IDE");
      await openInIde(path, 1600);
      const ed = await waitFor(() => ideEditor(), 15000, "편집기");
      const m = (window as unknown as { monaco: MonacoGlobal }).monaco;
      const model = ed.getModel();
      if (!model) throw new Error("편집기 내용이 없습니다");
      // 전부 골라 지운 뒤 한 줄씩 쳐 넣는다. 편집기의 자동 들여쓰기를 타지 않도록 입력이 아니라 편집으로 넣는다.
      ed.focus();
      ed.setSelection(model.getFullModelRange());
      await sleep(700);
      ed.executeEdits("autopilot", [{ range: model.getFullModelRange(), text: "" }]);
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i += 1) {
        await gate();
        const ln = model.getLineCount();
        const col = model.getLineMaxColumn(ln);
        ed.executeEdits("autopilot", [{ range: new m.Range(ln, col, ln, col), text: (i ? "\n" : "") + lines[i] }]);
        ed.revealLine(ln + 1);
        await new Promise((r) => setTimeout(r, 45));
      }
      // 마지막으로 계획의 내용과 한 글자도 다르지 않게 맞춘다(같으면 보이는 변화 없음)
      ed.executeEdits("autopilot", [{ range: model.getFullModelRange(), text: content }]);
      ed.setPosition({ lineNumber: 1, column: 1 });
      ed.revealLine(1);
      await sleep(600);
      key(window, "s", { ctrlKey: true });
      const root = appRoot("ide")!;
      await waitFor(() => (root.textContent || "").includes("저장됨"), 15000, "저장").catch(() => undefined);
      await sleep(1500);
    },
    [openApp, openInIde, waitFor, sleep, gate],
  );

  const term = useCallback(
    async (cmds: string[]) => {
      await openApp("터미널");
      const root = appRoot("terminal")!;
      for (const cmd of cmds) {
        const input = await waitFor(
          () => root.querySelector<HTMLInputElement>('input[aria-label="terminal"]:not([disabled])'),
          60000,
          "터미널 입력칸",
        );
        await type(input, cmd, 48);
        key(input, "Enter");
        await sleep(1200);
        await waitFor(() => root.querySelector('input[aria-label="terminal"]:not([disabled])'), 60000, "명령 실행");
        await sleep(2600);
      }
    },
    [openApp, waitFor, type, sleep],
  );

  const agent = useCallback(
    async (text: string) => {
      await openApp("AI 에이전트");
      const root = appRoot("agent")!;
      const box = await waitFor(() => root.querySelector<HTMLTextAreaElement>("textarea:not([disabled])"), 15000, "에이전트 입력칸");
      await type(box, text, 40);
      key(box, "Enter");
      const busy = () => root.querySelector('[title="요청 중단"]');
      await waitFor(busy, 10000, "에이전트 작업 시작").catch(() => undefined);
      await waitFor(() => !busy(), 360000, "에이전트 작업");
      await sleep(5500);
    },
    [openApp, waitFor, type, sleep],
  );

  const doc = useCallback(
    async (path: string, content: string) => {
      await openApp("문서");
      const root = appRoot("docs")!;
      await click(await waitFor(() => root.querySelector<HTMLElement>('button[title="새 문서"]'), 10000, "새 문서 단추"), 600);
      const name = await waitFor(() => root.querySelector<HTMLInputElement>('input[placeholder="output/report.md"]'), 10000, "문서 이름 칸");
      await type(name, path, 30);
      await click(await waitFor(() => byText(root, "button", "만들기", true), 10000, "만들기 단추"), 1000);
      const area = await waitFor(
        () => root.querySelector<HTMLTextAreaElement>('textarea[placeholder="여기에 문서를 작성하세요."]'),
        15000,
        "문서 편집칸",
      );
      await type(area, content, 110);
      await sleep(800);
      const save = byText(root, "button", "저장", true);
      if (save) await click(save, 600);
      else key(area, "s", { ctrlKey: true });
      await sleep(2000);
    },
    [openApp, click, waitFor, type, sleep],
  );

  /** 시작 브리핑 — 시네마틱이면 타자를 넘기고 [임무 시작], 카드면 [업무 시작하기]. 부팅 연출은 잠깐 보여 주고 넘긴다. */
  const intro = useCallback(async () => {
    // 시네마틱의 [임무 시작] 은 타자가 끝날 때까지 자리만 잡고 보이지 않는다 — 보이든 말든 있는 것으로 찾는다
    const startBtn = () =>
      Array.from(document.querySelectorAll<HTMLElement>("button")).find((b) =>
        ["임무 시작", "업무 시작하기"].includes((b.textContent || "").trim()),
      ) ?? null;
    const btn = await waitFor(
      () => startBtn() ?? (document.querySelector('[data-app="messenger"]') && "desk"),
      30000,
      "시작 브리핑",
    );
    if (btn === "desk") return;
    if ((btn as HTMLElement).textContent?.includes("임무 시작")) {
      await sleep(3500);
      if (!visible(startBtn())) key(window, "Enter"); // 타자를 끝까지 넘긴다
      await sleep(4000);
      await waitFor(() => visible(startBtn()) && startBtn(), 10000, "임무 시작 단추");
    } else {
      await sleep(5000);
    }
    const b = startBtn();
    if (b) await click(b, 600);
    // 부팅 화면이 떴으면 잠깐 보여 주고 넘긴다
    await sleep(2600);
    if (!document.querySelector('[data-app="messenger"]')) key(window, "Escape");
    await waitFor(() => document.querySelector('[data-app="messenger"]'), 60000, "업무 화면");
    await sleep(3500);
  }, [waitFor, sleep, click]);

  const submit = useCallback(async () => {
    const end = await waitFor(() => byText(document, "[data-taskbar] button", "시험 종료"), 10000, "시험 종료 단추");
    await click(end, 1200);
    const ok = await waitFor(() => byText(document, "[role=dialog] button", "종료 및 제출", true), 10000, "제출 확인");
    try {
      sessionStorage.removeItem(autopilotKey(attemptId));
    } catch {
      /* 저장소가 없어도 제출은 한다 */
    }
    await click(ok, 400);
  }, [waitFor, click, attemptId]);

  const runStep = useCallback(
    async (s: Step) => {
      switch (s.kind) {
        case "intro":
          return intro();
        case "ask":
          return ask(s.who, s.text);
        case "read":
          await openApp("IDE");
          for (const f of s.files) await openInIde(f);
          return sleep(800);
        case "edit":
          return edit(s.path, s.content);
        case "term":
          return term(s.cmds);
        case "agent":
          return agent(s.text);
        case "doc":
          return doc(s.path, s.content);
        case "submit":
          return submit();
      }
    },
    [intro, ask, openApp, openInIde, sleep, edit, term, agent, doc, submit],
  );

  // ── 진행 ──────────────────────────────────────────────────
  const running = useRef(false);
  const run = useCallback(
    async (from: number) => {
      if (!plan || running.current) return;
      running.current = true;
      try {
        for (let i = from; i < plan.steps.length; i += 1) {
          setStepIdx(i);
          try {
            sessionStorage.setItem(autopilotKey(attemptId), JSON.stringify({ step: i }));
          } catch {
            /* 이어하기만 못 할 뿐이다 */
          }
          await gate();
          await runStep(plan.steps[i]);
        }
        setStatus("done");
      } catch (e) {
        if (!(e instanceof Stopped)) {
          setDetail(e instanceof Error ? e.message : "알 수 없는 오류");
          setStatus("error");
        }
      } finally {
        running.current = false;
      }
    },
    [plan, attemptId, gate, runStep],
  );

  useEffect(() => {
    if (!plan) {
      onExit();
      return;
    }
    void run(initialStep);
    return () => {
      stopped.current = true;
    };
    // 한 번만 시작한다 — 이후의 진행은 run 안에서 이어진다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 진행 중에는 실제 키보드 입력을 막는다(진행 막대 안의 단추는 예외). 자동 진행이 보내는 이벤트는 isTrusted=false 라 지나간다.
  useEffect(() => {
    if (status !== "running") return;
    const block = (e: Event) => {
      if (!e.isTrusted) return;
      if (barRef.current && e.target instanceof Node && barRef.current.contains(e.target)) return;
      e.stopImmediatePropagation();
      e.preventDefault();
    };
    const kinds = ["keydown", "keypress", "keyup", "paste", "wheel"] as const;
    kinds.forEach((k) => window.addEventListener(k, block, { capture: true, passive: false }));
    return () => kinds.forEach((k) => window.removeEventListener(k, block, { capture: true }));
  }, [status]);

  const retry = () => {
    setDetail("");
    setStatus("running");
    void run(stepIdx);
  };
  const takeOver = () => {
    stopped.current = true;
    try {
      sessionStorage.removeItem(autopilotKey(attemptId));
    } catch {
      /* 무시 */
    }
    onExit();
  };

  if (!plan || !mounted) return null;
  const total = plan.steps.length;
  const cur = plan.steps[Math.min(stepIdx, total - 1)];
  const label =
    status === "done"
      ? "자동 진행을 마쳤습니다"
      : status === "error"
        ? `멈췄습니다: ${detail}`
        : `${stepIdx + 1}/${total} · ${cur.say}`;

  return createPortal(
    <>
      {status === "running" && <div className="autopilot-shield" aria-hidden="true" />}
      <div ref={rippleRef} className="autopilot-ripple" aria-hidden="true" />
      <div
        ref={cursorRef}
        className="autopilot-cursor"
        style={{ transform: `translate(${pos.current.x}px, ${pos.current.y}px)`, opacity: status === "running" ? 1 : 0.35 }}
        aria-hidden="true"
      >
        <svg width="24" height="24" viewBox="0 0 24 24">
          <path d="M4 2l15 9.2-6.6 1.4L9.6 19z" fill="#fff" stroke="#0f172a" strokeWidth="1.4" strokeLinejoin="round" />
        </svg>
      </div>
      <div ref={barRef} className="autopilot-bar" role="status" aria-live="polite" data-autopilot={status}>
        <span className="autopilot-dot" data-state={status} />
        <span className="autopilot-tag">자동 진행</span>
        <span className="autopilot-say">{label}</span>
        <span className="autopilot-progress" aria-hidden="true">
          <i style={{ width: `${((status === "done" ? total : stepIdx) / total) * 100}%` }} />
        </span>
        {status === "running" && (
          <button type="button" onClick={() => setStatus("paused")}>
            일시정지
          </button>
        )}
        {status === "paused" && (
          <button type="button" onClick={() => (running.current ? setStatus("running") : retry())}>
            {running.current ? "계속" : "이어서 자동 진행"}
          </button>
        )}
        {status === "error" && (
          <button type="button" onClick={retry}>
            다시 시도
          </button>
        )}
        {status !== "done" && (
          <button type="button" onClick={takeOver} className="autopilot-quiet">
            직접 하기
          </button>
        )}
      </div>
    </>,
    document.body,
  );
}

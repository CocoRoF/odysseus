"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import type { ReferenceConfig, SystemInfo } from "@/lib/types";
import { useWorkspace } from "./workspace";

/**
 * 부팅 연출 — [임무 시작] 을 누르면 옛 DOS 기계가 켜지듯 화면이 살아난다.
 *
 * BIOS/POST → 부트로더 → 서비스 기동 → 로그인 → 데스크톱. 화면에 흐르는 것은
 * 장식이 아니라 **이 시험의 실제 사양**이다: 워크스페이스 파일 수, 설치된 언어의
 * 진짜 버전, 메신저에 대기 중인 등장인물, 에이전트·참고 자료 앱의 허용 여부,
 * 제한 시간. 그래서 응시자는 첫 화면에서 자기 환경을 한 번 훑고 시작한다.
 *
 * 아무 키나 Esc 로 건너뛸 수 있고, 모션 축소 설정이면 곧바로 끝난다.
 */

type Tone = "dim" | "text" | "bright" | "ok" | "warn" | "amber" | "skip";
interface Line {
  id: number;
  text: string;
  tone: Tone;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function BootSequence({
  userName,
  assessmentTitle,
  chapter,
  characters,
  agentEnabled,
  durationMin,
  onReveal,
  onDone,
}: {
  userName: string;
  assessmentTitle: string;
  chapter: string | null;
  characters: { name: string; role: string }[];
  agentEnabled: boolean;
  durationMin: number;
  /** 화면이 밝아지기 시작할 때 — 이때 데스크톱을 열어 두면 밝아지는 동안 창이 떠오른다 */
  onReveal: () => void;
  /** 완전히 밝아진 뒤 — 이 컴포넌트를 내려도 된다 */
  onDone: () => void;
}) {
  const ws = useWorkspace();
  const [lines, setLines] = useState<Line[]>([]);
  // run: CRT 로그 → dim: 화면이 어두워진다 → logo: 검은 화면에 로고가 떠올랐다 가라앉는다 → reveal: OS 가 밝아온다
  const [phase, setPhase] = useState<"run" | "dim" | "logo" | "reveal">("run");
  const cancelled = useRef(false);
  const doneRef = useRef(false);
  const phaseRef = useRef<"run" | "dim" | "logo" | "reveal">("run");
  phaseRef.current = phase;
  const idRef = useRef(1);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sysRef = useRef<SystemInfo | null>(null);
  const refRef = useRef<ReferenceConfig | null>(null);
  const filesRef = useRef(ws.files.length);
  filesRef.current = ws.files.length;

  const reveal = () => {
    setPhase("reveal"); // 검은 막이 걷히며 OS 가 밝아온다
    onReveal();
    setTimeout(onDone, 1100);
  };
  /** 로그가 끝났을 때 — 어두워지고, 로고가 떠올랐다 가라앉고, 밝아온다 */
  const finish = () => {
    if (doneRef.current) return;
    doneRef.current = true;
    cancelled.current = true;
    setPhase("dim");
    setTimeout(() => {
      setPhase("logo");
      setTimeout(reveal, 2600);
    }, 520);
  };
  /** 건너뛰기 — 로고까지 생략하고 곧바로 밝아온다 */
  const skip = () => {
    if (phaseRef.current === "reveal") return;
    doneRef.current = true;
    cancelled.current = true;
    reveal();
  };

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [lines]);

  // 아무 키 / Esc / 클릭 → 건너뛰기
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "Enter" || e.key === " ") skip();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // 실제 사양을 미리 받아 둔다 — 못 받아도 연출은 진행한다
    api.get<SystemInfo>("/reference/system").then((s) => (sysRef.current = s)).catch(() => undefined);
    api.get<ReferenceConfig>("/reference/config").then((c) => (refRef.current = c)).catch(() => undefined);

    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const speed = reduced ? 0 : 1; // 0 이면 대기 없이 즉시

    const push = (text: string, tone: Tone = "text"): number => {
      const id = idRef.current++;
      setLines((l) => [...l, { id, text, tone }]);
      return id;
    };
    const set = (id: number, text: string, tone?: Tone) =>
      setLines((l) => l.map((x) => (x.id === id ? { ...x, text, tone: tone ?? x.tone } : x)));
    const wait = async (ms: number) => {
      if (cancelled.current) throw new Error("cancelled");
      await sleep(ms * speed);
      if (cancelled.current) throw new Error("cancelled");
    };
    const typed = async (prefix: string, text: string, tone: Tone = "text", cps = 28) => {
      const id = push(prefix, tone);
      for (let i = 1; i <= text.length; i++) {
        set(id, prefix + text.slice(0, i));
        await wait(1000 / cps);
      }
      return id;
    };
    const ok = (text: string) => push(`[  OK  ] ${text}`, "ok");
    const stamp = (() => {
      let t = 0.011;
      return () => {
        t += 0.017 + Math.random() * 0.09;
        return `[${t.toFixed(3).padStart(8, " ")}]`;
      };
    })();

    (async () => {
      try {
        await wait(380);

        // ── POST ──
        push("ODYSSEUS BIOS (C) 2026 Odysseus Systems, Inc.", "bright");
        push("BIOS Version 1.0.0  —  Workstation Class", "dim");
        push("", "dim");
        await wait(320);
        push("CPU : Odysseus Virtual Core @ 3.00GHz");
        await wait(180);
        const memKb = ((sysRef.current?.limits?.memory_mb ?? 4096) * 1024) | 0;
        const memId = push("Memory Test :        0 KB");
        const steps = 22;
        for (let i = 1; i <= steps; i++) {
          set(memId, `Memory Test : ${String(Math.round((memKb * i) / steps)).padStart(8, " ")} KB`);
          await wait(48);
        }
        set(memId, `Memory Test : ${String(memKb).padStart(8, " ")} KB  OK`);
        await wait(220);
        const files = filesRef.current;
        push(`Detecting Workspace Disk ... /home/user  [${files > 0 ? `${files} files` : "mounting"}]`);
        await wait(200);
        push("Detecting Sandbox Runtime ... namespaces: pid mount ipc uts  [isolated]");
        await wait(200);
        push("Detecting Network ........... NONE  (reference proxies only)", "warn");
        await wait(360);
        push("", "dim");
        push("Booting from ODYSSEUS/OS ...", "dim");
        await wait(420);

        // ── 부트로더 ──
        push("", "dim");
        push("Loading ODYSSEUS/OS 1.0", "amber");
        const barId = push("[                              ]   0%", "amber");
        for (let i = 1; i <= 30; i++) {
          const pct = Math.round((i / 30) * 100);
          set(barId, `[${"#".repeat(i)}${" ".repeat(30 - i)}] ${String(pct).padStart(3, " ")}%`);
          await wait(i < 22 ? 42 : 90);
        }
        await wait(240);
        push("", "dim");

        // ── 서비스 기동 (실제 사양) ──
        push(`${stamp()} ODYSSEUS/OS kernel starting — ${assessmentTitle}${chapter ? ` · ${chapter}` : ""}`, "bright");
        await wait(200);
        ok(`Mounted workspace at /home/user (${filesRef.current} files)`);
        await wait(140);
        ok("Started sandbox isolation (per-run uid, private /tmp, no network)");
        await wait(160);
        const langs = sysRef.current?.languages ?? [];
        if (langs.length) {
          ok(`Loaded runtimes: ${langs.slice(0, 6).map((l) => `${l.name} ${l.version.split("-")[0]}`).join(", ")}`);
        } else {
          ok("Loaded runtimes: Python, Node.js, Go, Java, GCC");
        }
        await wait(160);
        const tools = sysRef.current?.tools ?? [];
        if (tools.length) {
          ok(`Loaded tools: ${tools.slice(0, 7).map((t) => t.name.toLowerCase()).join(", ")}`);
          await wait(140);
        }
        ok("Started messenger daemon");
        await wait(120);
        for (const c of characters) {
          push(`           ● ${c.name}${c.role ? ` (${c.role})` : ""} — online`, "dim");
          await wait(110);
        }
        await wait(120);
        if (agentEnabled) ok("Started AI agent bridge (workspace tools attached)");
        else push("[ SKIP ] AI agent disabled for this exam", "skip");
        await wait(140);
        const rc = refRef.current;
        const proxies = [rc?.github_enabled !== false ? "github.com" : null, rc?.web_enabled !== false ? "web search" : null].filter(Boolean);
        if (proxies.length) ok(`Started reference proxies: ${proxies.join(", ")}`);
        else push("[ SKIP ] Reference apps disabled for this exam", "skip");
        await wait(140);
        ok(`Armed exam timer: ${durationMin} min`);
        await wait(120);
        ok("Session recorder active — all activity is logged");
        await wait(380);

        // ── 로그인 ──
        push("", "dim");
        await typed("odysseus login: ", "candidate", "text", 22);
        await wait(260);
        await typed("Password: ", "••••••••", "text", 18);
        await wait(420);
        push("", "dim");
        push(`Welcome, ${userName || "candidate"}.`, "bright");
        push(`Last login: never — first day on the team.`, "dim");
        await wait(520);
        await typed("", "Starting desktop environment ...", "amber", 34);
        await wait(700);
        finish();
      } catch {
        /* cancelled — 건너뛰기 */
      }
    })();

    return () => {
      cancelled.current = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toneCls: Record<Tone, string> = {
    dim: "text-[#7a8a7a]",
    text: "text-[#c8d3c8]",
    bright: "text-white",
    ok: "text-[#c8d3c8] [&>span]:text-[#4ade80]",
    warn: "text-[#fbbf24]",
    amber: "text-[#f5c451]",
    skip: "text-[#9aa5b1]",
  };

  return (
    <div
      className={`boot-screen absolute inset-0 z-[9600] overflow-hidden ${phase === "reveal" ? "boot-reveal" : "bg-black"}`}
      onClick={skip}
      data-boot
      data-phase={phase}
    >
      {/* 로고 스플래시 — 로그가 끝난 뒤, 데스크톱이 밝아오기 전 */}
      {phase === "logo" && (
        <div className="boot-logo absolute inset-0 flex items-center justify-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/odysseus-logo.png" alt="Odysseus" className="w-[min(60vw,720px)] select-none" draggable={false} />
        </div>
      )}
      {(phase === "run" || phase === "dim") && <div className="boot-crt pointer-events-none absolute inset-0" />}
      <div
        ref={scrollRef}
        className={`boot-text absolute inset-0 overflow-hidden px-10 py-8 font-mono text-[15px] leading-[1.45] ${
          phase === "run" ? "boot-text-in" : phase === "dim" ? "boot-dim" : "hidden"
        }`}
      >
        {lines.map((l) => (
          <div key={l.id} className={`whitespace-pre ${toneCls[l.tone]}`}>
            {l.tone === "ok" ? (
              <>
                <span>[  OK  ]</span>
                {l.text.slice(8)}
              </>
            ) : (
              l.text || " "
            )}
          </div>
        ))}
        {phase === "run" && <span className="boot-cursor inline-block h-[15px] w-[9px] bg-[#c8d3c8] align-middle" />}
      </div>
      {(phase === "run" || phase === "logo") && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            skip();
          }}
          className="absolute bottom-5 right-6 rounded-md border border-white/15 px-3 py-1.5 font-mono text-[11px] text-white/40 transition hover:border-white/40 hover:text-white/80"
        >
          건너뛰기  [Esc]
        </button>
      )}
    </div>
  );
}

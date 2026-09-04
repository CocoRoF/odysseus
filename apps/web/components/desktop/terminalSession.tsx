"use client";

import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { api, ApiError } from "@/lib/api";
import type { Execution } from "@/lib/types";
import { useWorkspace } from "./workspace";

/**
 * 터미널은 **하나의 세션**이다.
 *
 * IDE 안의 패널로 열든, 바탕화면의 [터미널] 앱으로 열든 같은 셸이다 — 작업
 * 디렉터리도, 히스토리도, 출력도 공유한다. 그래서 상태를 이 프로바이더로
 * 끌어올려 두 표면이 같은 것을 보게 한다 (AI 에이전트와 같은 규약).
 */

export interface CloneResult {
  repo: string;
  dest: string;
  ref: string;
  files: number;
  skipped_binary: number;
  skipped_large: number;
  truncated: boolean;
  /** "repo" = 저장소가 커서, "workspace" = 워크스페이스가 차서 */
  limit: string;
}

export type TermLine =
  | { kind: "cmd"; cwd: string; text: string; cont?: boolean }
  | { kind: "out"; text: string }
  | { kind: "err"; text: string };

export const VHOME = "/home/user";

/** cd 인자 해석 — 실제 bash와 같은 오류 문구를 낸다. */
export function resolveCd(
  cwd: string,
  rawArg: string,
  dirs: Set<string>,
  filePaths: Set<string>,
): { cwd?: string; error?: string } {
  const arg = rawArg.trim();
  if (!arg || arg === "~" || arg === "$HOME") return { cwd: "" };
  let base: string[];
  let rest = arg;
  if (arg.startsWith("~/")) {
    base = [];
    rest = arg.slice(2);
  } else if (arg.startsWith("/")) {
    return { error: `bash: cd: ${arg}: No such file or directory` };
  } else {
    base = cwd ? cwd.split("/") : [];
  }
  for (const seg of rest.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (base.length === 0) return { error: `bash: cd: ${arg}: No such file or directory` };
      base.pop();
      continue;
    }
    base.push(seg);
  }
  const target = base.join("/");
  if (!target) return { cwd: "" };
  if (dirs.has(target)) return { cwd: target };
  if (filePaths.has(target)) return { error: `bash: cd: ${arg}: Not a directory` };
  return { error: `bash: cd: ${arg}: No such file or directory` };
}

function shellQuote(path: string): string {
  return `'${path.replace(/'/g, `'\\''`)}'`;
}

/** 참고 저장소가 모이는 곳 — 서버(reference.py CLONE_ROOT)와 같은 규약 */
export const CLONE_ROOT = "github";

/**
 * 아직 닫히지 않은 입력인지 — bash 처럼 `> ` 프롬프트로 다음 줄을 기다린다.
 * heredoc(`<<EOF`), 열린 따옴표, 줄 끝 백슬래시를 본다.
 */
export function needsContinuation(text: string): boolean {
  const first = text.split("\n")[0];
  const hd = first.match(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/);
  if (hd) {
    const term = hd[2];
    return !text.split("\n").slice(1).some((l) => l.replace(/^\t+/, "") === term);
  }
  let sq = false;
  let dq = false;
  let esc = false;
  for (const ch of text) {
    if (esc) {
      esc = false;
      continue;
    }
    if (ch === "\\" && !sq) {
      esc = true;
      continue;
    }
    if (ch === "'" && !dq) sq = !sq;
    else if (ch === '"' && !sq) dq = !dq;
  }
  return sq || dq || esc;
}

const REPL_HINT: Record<string, string> = {
  python: "python3 script.py  또는  python3 -c '...'",
  python3: "python3 script.py  또는  python3 -c '...'",
  ipython: "python3 script.py  또는  python3 -c '...'",
  node: "node script.js  또는  node -e '...'",
  bash: "bash script.sh",
  sh: "sh script.sh",
  sqlite3: "sqlite3 파일.db 'SELECT ...'",
  irb: "ruby 는 설치되어 있지 않습니다",
};
const EDITOR_HINT = new Set(["vim", "vi", "nano", "vim.tiny", "emacs"]);
const PAGERS = new Set(["less", "more"]);
const NO_NETWORK = new Set(["curl", "wget", "apt", "apt-get", "ssh", "scp"]);

/**
 * 대화형 프로그램·네트워크는 이 터미널로 할 수 없다 — 제한 시간까지 멈춰 있는 대신
 * 즉시 알려 준다. 대체 명령이 있으면(`less` → `cat`) 바꿔 실행한다.
 */
export function interactiveHint(command: string): { lines?: string[]; rewrite?: string } | null {
  const tokens = command.trim().split(/\s+/);
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
  const cmd = (tokens[i] ?? "").split("/").pop() ?? "";
  const args = tokens.slice(i + 1);
  const positional = args.filter((a) => !a.startsWith("-"));
  if (cmd in REPL_HINT && positional.length === 0 && !args.includes("-c") && !args.includes("-e") && !args.includes("-m"))
    return {
      lines: [
        `${cmd}: 이 터미널은 대화형 프롬프트를 열 수 없습니다 (입력을 받을 수 없습니다).`,
        `        ${REPL_HINT[cmd]}`,
      ],
    };
  if (EDITOR_HINT.has(cmd))
    return { lines: [`${cmd}: 이 터미널은 화면 편집기를 열 수 없습니다 — IDE 에서 파일을 열어 편집하세요.`] };
  if (PAGERS.has(cmd)) {
    if (positional.length === 0) return { lines: [`${cmd}: 파일 이름이 필요합니다 (예: cat 파일)`] };
    return { rewrite: ["cat", ...positional].join(" ") };
  }
  if (cmd === "top" || cmd === "htop") return { rewrite: "ps aux --sort=-%cpu | head -15" };
  if (cmd === "man") return { lines: [`man: 설명서는 설치되어 있지 않습니다 — ${positional[0] ?? "명령"} --help 를 사용하세요.`] };
  if (cmd === "sudo" || cmd === "su") return { lines: [`${cmd}: 이 워크스테이션에는 관리자 권한이 없습니다.`] };
  if (NO_NETWORK.has(cmd))
    return {
      lines: [
        `${cmd}: 이 워크스테이션은 인터넷에 직접 닿지 않습니다.`,
        `        참고 자료는 [인터넷]·[GitHub] 앱과 git clone 으로 가져올 수 있습니다.`,
      ],
    };
  if ((cmd === "pip" || cmd === "pip3" || cmd === "npm" || cmd === "npx" || cmd === "go") && positional[0] === "install" ||
      (cmd === "go" && positional[0] === "get"))
    return {
      lines: [
        `${cmd}: 이 워크스테이션은 인터넷에 직접 닿지 않아 패키지를 내려받을 수 없습니다.`,
        `        자주 쓰는 라이브러리는 미리 설치되어 있습니다 (pip list / npm ls -g).`,
      ],
    };
  return null;
}

/** 탭 완성 후보가 되는 명령들 — 흔히 쓰는 것만, 나머지는 경로 완성으로 충분하다. */
const COMMANDS = [
  "awk", "bc", "cat", "cd", "chmod", "clear", "cp", "cut", "date", "diff", "du", "echo", "env", "file", "find",
  "g++", "gcc", "git clone", "go", "grep", "head", "help", "java", "javac", "jq", "ls", "make", "mkdir", "mv",
  "node", "npm", "pip3", "printf", "ps", "pwd", "pytest", "python", "python3", "rg", "rm", "sed", "sort",
  "sqlite3", "tail", "tar", "touch", "tree", "uniq", "unzip", "wc", "which", "xargs", "zip",
];

export interface Completion {
  /** 바꿀 입력 전체 (완성됐을 때) */
  input?: string;
  /** 후보가 여럿이면 보여 줄 목록 */
  candidates?: string[];
}

function commonPrefix(items: string[]): string {
  if (items.length === 0) return "";
  let p = items[0];
  for (const it of items.slice(1)) {
    let i = 0;
    while (i < p.length && i < it.length && p[i] === it[i]) i++;
    p = p.slice(0, i);
  }
  return p;
}

/**
 * bash 식 탭 완성 — 첫 단어는 명령, 그 뒤는 현재 폴더 기준 경로.
 * 후보가 하나면 채우고(폴더는 `/` 까지), 여럿이면 공통 접두어까지만 채우고 목록을 돌려준다.
 */
export function complete(
  input: string,
  cwd: string,
  children: Map<string, string[]>,
): Completion | null {
  const m = input.match(/(^|.*\s)(\S*)$/);
  if (!m) return null;
  const head = m[1];
  const token = m[2];
  const isCommand = head.trim() === "" || /(\||&&|;)\s*$/.test(head);
  let candidates: string[];
  let prefixDir = "";
  if (isCommand && !token.includes("/") && !token.startsWith(".")) {
    candidates = COMMANDS.filter((c) => c.startsWith(token));
  } else {
    const slash = token.lastIndexOf("/");
    prefixDir = slash === -1 ? "" : token.slice(0, slash + 1);
    const base = slash === -1 ? token : token.slice(slash + 1);
    let dir: string;
    if (prefixDir.startsWith("~/")) dir = prefixDir.slice(2);
    else if (prefixDir.startsWith("/")) return null;
    else dir = cwd ? `${cwd}/${prefixDir}` : prefixDir;
    const parts: string[] = [];
    for (const seg of dir.split("/")) {
      if (!seg || seg === ".") continue;
      if (seg === "..") parts.pop();
      else parts.push(seg);
    }
    const names = children.get(parts.join("/")) ?? [];
    candidates = names.filter((n) => n.startsWith(base) && (base.startsWith(".") || !n.startsWith(".")));
  }
  if (candidates.length === 0) return null;
  if (candidates.length === 1) {
    const c = candidates[0];
    const done = c.endsWith("/") || c.endsWith(" ") ? c : `${c} `;
    return { input: `${head}${prefixDir}${done}` };
  }
  const cp = commonPrefix(candidates);
  const tokenBase = token.slice(prefixDir.length);
  if (cp.length > tokenBase.length) return { input: `${head}${prefixDir}${cp}` };
  return { candidates: candidates.slice().sort() };
}

const HELP_LINES = [
  "Odysseus 워크스테이션 — 참고 명령",
  "  언어      python3 · node · go · java/javac · gcc/g++ · make   (python 은 python3 과 같습니다)",
  "  도구      git clone <github 주소> [폴더]  → github/<저장소> 에 받습니다 (그 외 git 명령은 없음)",
  "            jq · sqlite3 · rg · tree · pytest 등이 설치되어 있습니다",
  "  편집기    파일 편집은 IDE 에서 — vim/nano 는 열리지 않습니다",
  "  입력      Tab 완성 · ↑↓ 히스토리 · Ctrl+C 중단 · Ctrl+L 지우기 · 여러 줄은 \\ 나 <<EOF 로",
  "  제한      명령마다 새 셸에서 실행되어 export/변수/cd 는 다음 명령으로 이어지지 않습니다 (cd 제외)",
  "            인터넷 직접 접속 없음 · 실행 시간 30초 · 대화형 프로그램 없음",
];

/** `git clone <url|owner/repo> [dest]` 파싱 — 지원하는 형태만 받아들인다. */
export function parseGitClone(
  command: string,
): { owner: string; name: string; dest: string; branch: string } | { error: string } | null {
  const tokens = command.trim().split(/\s+/);
  if (tokens[0] !== "git") return null;
  if (tokens[1] !== "clone") {
    return {
      error:
        `git: '${tokens[1] ?? ""}' 은 이 환경에서 지원하지 않습니다.\n` +
        `이 워크스테이션의 git 은 참고 자료를 가져오는 clone 만 제공합니다.`,
    };
  }
  const args: string[] = [];
  let branch = "";
  for (let i = 2; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "-b" || t === "--branch") {
      branch = tokens[++i] ?? "";
      continue;
    }
    if (t.startsWith("--depth") || t === "--recursive" || t === "-q" || t === "--quiet") continue;
    if (t.startsWith("-")) continue;
    args.push(t);
  }
  const src = args[0];
  if (!src) return { error: "fatal: You must specify a repository to clone." };

  let slug = src.replace(/\.git$/, "");
  const m = slug.match(/^(?:https?:\/\/|git@)?(?:www\.)?github\.com[/:](.+)$/i);
  if (m) slug = m[1];
  else if (/^(https?:\/\/|git@|ssh:\/\/)/i.test(slug))
    return { error: `fatal: 이 환경에서는 github.com 저장소만 clone 할 수 있습니다.` };

  const parts = slug.split("/").filter(Boolean);
  if (parts.length !== 2) return { error: `fatal: repository '${src}' does not exist` };
  return { owner: parts[0], name: parts[1], dest: args[1] ?? "", branch };
}

interface TerminalSessionValue {
  lines: TermLine[];
  input: string;
  setInput: (v: string) => void;
  cwd: string;
  running: boolean;
  print: (entries: TermLine[]) => void;
  clear: () => void;
  submit: (raw: string) => Promise<void>;
  /** 여러 줄 입력 중이면 첫 줄부터의 내용 — 화면은 `> ` 프롬프트를 보인다 */
  pending: string | null;
  handleKey: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  /** IDE 가 더티 탭을 저장할 기회를 얻는다 — 실행은 서버 파일 기준이므로 */
  registerPreRun: (fn: () => Promise<void>) => () => void;
  /** 실행으로 파일이 바뀌었을 때 열린 탭을 갱신하도록 알린다 */
  registerFilesChanged: (fn: (paths: string[]) => void) => () => void;
  /** git clone — GitHub 앱의 [clone] 버튼도 이 경로를 쓴다 */
  cloneRepo: (owner: string, name: string, dest?: string, branch?: string) => Promise<CloneResult>;
  /** clone 결과를 셸 출력으로 남긴다 (GitHub 앱에서 받았을 때도 동일하게) */
  printCloneResult: (res: CloneResult) => void;
}

const Ctx = createContext<TerminalSessionValue | null>(null);

export function useTerminalSession(): TerminalSessionValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useTerminalSession must be used within TerminalSessionProvider");
  return v;
}

export function TerminalSessionProvider({
  onActivity,
  children,
}: {
  onActivity?: () => void;
  children: ReactNode;
}) {
  const ws = useWorkspace();
  const [lines, setLines] = useState<TermLine[]>([]);
  const [input, setInput] = useState("");
  const [cwd, setCwd] = useState("");
  const [running, setRunning] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const historyKey = `odysseus:term:${ws.attemptId}`;
  const historyRef = useRef<string[]>([]);
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(historyKey);
      if (raw) historyRef.current = JSON.parse(raw);
    } catch {
      /* 없으면 빈 히스토리 */
    }
  }, [historyKey]);
  const histPosRef = useRef(-1);
  const cancelRef = useRef<string | null>(null);
  const runIdRef = useRef<string | null>(null);
  const preRunRef = useRef<Set<() => Promise<void>>>(new Set());
  const filesChangedRef = useRef<Set<(paths: string[]) => void>>(new Set());

  const dirSet = useMemo(() => {
    const set = new Set<string>();
    for (const f of ws.files) {
      const parts = f.path.split("/");
      for (let i = 1; i < parts.length; i++) set.add(parts.slice(0, i).join("/"));
    }
    return set;
  }, [ws.files]);
  const fileSet = useMemo(() => new Set(ws.files.map((f) => f.path)), [ws.files]);
  /** 폴더 → 직계 항목 이름(폴더는 `/` 붙임) — 탭 완성용 */
  const childrenMap = useMemo(() => {
    const m = new Map<string, Set<string>>();
    const add = (dir: string, name: string) => {
      if (!m.has(dir)) m.set(dir, new Set());
      m.get(dir)!.add(name);
    };
    for (const f of ws.files) {
      const parts = f.path.split("/");
      for (let i = 1; i < parts.length; i++) add(parts.slice(0, i - 1).join("/"), `${parts[i - 1]}/`);
      if (!parts[parts.length - 1].startsWith(".keep")) add(parts.slice(0, -1).join("/"), parts[parts.length - 1]);
    }
    const out = new Map<string, string[]>();
    for (const [k, v] of m) out.set(k, [...v].sort());
    return out;
  }, [ws.files]);

  const print = useCallback((entries: TermLine[]) => {
    setLines((l) => [...l, ...entries]);
  }, []);
  const clear = useCallback(() => setLines([]), []);

  const registerPreRun = useCallback((fn: () => Promise<void>) => {
    preRunRef.current.add(fn);
    return () => {
      preRunRef.current.delete(fn);
    };
  }, []);
  const registerFilesChanged = useCallback((fn: (paths: string[]) => void) => {
    filesChangedRef.current.add(fn);
    return () => {
      filesChangedRef.current.delete(fn);
    };
  }, []);

  const cloneRepo = useCallback(
    async (owner: string, name: string, dest = "", branch = "") => {
      const params = new URLSearchParams({ owner, name });
      if (dest) params.set("dest", dest);
      if (branch) params.set("ref", branch);
      const res = await api.post<CloneResult>(
        `/attempts/${ws.attemptId}/scenarios/${ws.scenarioId}/github/clone?${params}`,
        {},
      );
      await ws.refresh();
      return res;
    },
    [ws],
  );

  /** clone 결과를 실제 git 출력처럼 보여준다 — 상한 때문에 잘렸으면 정직하게 알린다 */
  const printCloneResult = useCallback(
    (res: CloneResult) => {
      if (res.files === 0) {
        print([
          {
            kind: "err",
            text:
              res.limit === "workspace"
                ? "fatal: 워크스페이스 파일 한도에 도달해 한 파일도 받지 못했습니다. 필요 없는 디렉터리를 지우고 다시 시도하세요."
                : "fatal: 가져올 수 있는 텍스트 파일이 없습니다.",
          },
        ]);
        return;
      }
      const out: TermLine[] = [
        { kind: "err", text: `remote: Enumerating objects: ${res.files}, done.` },
        { kind: "err", text: `remote: Total ${res.files} (delta 0), reused ${res.files} (delta 0)` },
        { kind: "err", text: `Receiving objects: 100% (${res.files}/${res.files}), done.` },
        { kind: "out", text: `'${res.dest}' 에 ${res.repo} (${res.ref}) 를 받았습니다.` },
      ];
      const notes: string[] = [];
      if (res.limit === "workspace")
        notes.push("워크스페이스 파일 한도에 도달해 나머지는 받지 못했습니다");
      else if (res.truncated) notes.push("저장소가 커서 일부만 가져왔습니다");
      if (res.skipped_binary) notes.push(`바이너리 ${res.skipped_binary}개 제외`);
      if (res.skipped_large) notes.push(`큰 파일 ${res.skipped_large}개 제외`);
      if (notes.length) out.push({ kind: "err", text: `note: ${notes.join(", ")}` });
      print(out);
    },
    [print],
  );

  const runServerCommand = useCallback(
    async (command: string, atCwd: string) => {
      for (const fn of Array.from(preRunRef.current)) await fn();
      setRunning(true);
      onActivity?.();
      const wrapped = atCwd ? `cd ${shellQuote(atCwd)} && (${command})` : command;
      try {
        const exec = await api.post<Execution>(
          `/attempts/${ws.attemptId}/scenarios/${ws.scenarioId}/run`,
          { command: wrapped },
        );
        runIdRef.current = exec.id;
        let done: Execution = exec;
        // 짧은 명령은 곧바로 돌아오도록 처음엔 촘촘히, 오래 걸리면 완만히 확인한다
        const started = Date.now();
        let delay = 120;
        while (Date.now() - started < 75_000) {
          await new Promise((r) => setTimeout(r, delay));
          delay = Math.min(650, Math.round(delay * 1.5));
          if (cancelRef.current === exec.id) return;
          done = await api.get<Execution>(`/executions/${exec.id}`);
          if (done.status === "done" || done.status === "error") break;
        }
        if (cancelRef.current === exec.id) return;
        const out: TermLine[] = [];
        if (done.stdout)
          out.push(
            ...done.stdout.replace(/\n$/, "").split("\n").map((t) => ({ kind: "out" as const, text: t })),
          );
        if (done.stderr)
          out.push(
            ...done.stderr.replace(/\n$/, "").split("\n").map((t) => ({ kind: "err" as const, text: t })),
          );
        if (done.status !== "done" && done.status !== "error")
          out.push({ kind: "err", text: "bash: 실행이 완료되지 않았습니다" });
        print(out);
        const changed = (done.changed_files ?? []).map((c) => c.path);
        if (changed.length > 0) {
          await ws.refresh();
          filesChangedRef.current.forEach((fn) => fn(changed));
        }
      } catch (e) {
        print([{ kind: "err", text: e instanceof ApiError ? `bash: ${e.message}` : "bash: 실행 요청 실패" }]);
      } finally {
        runIdRef.current = null;
        setRunning(false);
      }
    },
    [ws, print, onActivity],
  );

  const submit = useCallback(
    async (raw: string) => {
      // 여러 줄 입력 — 닫힐 때까지 모은다
      const whole = pending !== null ? `${pending}\n${raw}` : raw;
      print([{ kind: "cmd", cwd, text: raw, cont: pending !== null }]);
      if (needsContinuation(whole)) {
        setPending(whole);
        return;
      }
      setPending(null);
      const command = whole.trim();
      if (command) {
        historyRef.current = [...historyRef.current.filter((c) => c !== command), command].slice(-100);
        try {
          sessionStorage.setItem(historyKey, JSON.stringify(historyRef.current));
        } catch {
          /* 저장 실패는 무시 */
        }
      }
      histPosRef.current = -1;
      if (!command) return;

      if (command === "clear" || command === "reset") {
        setLines([]);
        return;
      }
      if (command === "help" || command === "?") {
        print(HELP_LINES.map((text) => ({ kind: "out" as const, text })));
        return;
      }
      if (command === "exit" || command === "logout") {
        print([{ kind: "out", text: "이 터미널은 시험이 끝날 때까지 열려 있습니다. 창을 닫으려면 ✕ 를 누르세요." }]);
        return;
      }
      if (command === "pwd") {
        print([{ kind: "out", text: cwd ? `${VHOME}/${cwd}` : VHOME }]);
        return;
      }
      if (command === "cd" || command.startsWith("cd ")) {
        const r = resolveCd(cwd, command === "cd" ? "" : command.slice(3), dirSet, fileSet);
        if (r.error) print([{ kind: "err", text: r.error }]);
        else setCwd(r.cwd ?? "");
        return;
      }

      // git — 러너에는 네트워크가 없다. clone 만 서버가 대신 받아 워크스페이스에 푼다.
      const git = parseGitClone(command);
      if (git) {
        if ("error" in git) {
          print(git.error.split("\n").map((text) => ({ kind: "err" as const, text })));
          return;
        }
        // 폴더를 지정하지 않으면 현재 위치와 무관하게 github/<저장소> 로 모은다
        const dest = git.dest || `${CLONE_ROOT}/${git.name}`;
        const full = git.dest && cwd && !dest.startsWith("/") ? `${cwd}/${dest}` : dest;
        setRunning(true);
        print([{ kind: "err", text: `Cloning into '${full}'...` }]);
        try {
          printCloneResult(await cloneRepo(git.owner, git.name, full, git.branch));
        } catch (e) {
          print([
            {
              kind: "err",
              text: `fatal: ${e instanceof ApiError ? e.message : "저장소를 가져오지 못했습니다"}`,
            },
          ]);
        } finally {
          setRunning(false);
        }
        return;
      }

      const hint = interactiveHint(command);
      if (hint?.lines) {
        print(hint.lines.map((text) => ({ kind: "err" as const, text })));
        return;
      }
      await runServerCommand(hint?.rewrite ?? command, cwd);
    },
    [cwd, pending, historyKey, dirSet, fileSet, print, runServerCommand, cloneRepo, printCloneResult],
  );

  const handleKey = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.ctrlKey && (e.key === "c" || e.key === "C")) {
        e.preventDefault();
        if (running && runIdRef.current) {
          cancelRef.current = runIdRef.current;
          runIdRef.current = null;
          setRunning(false);
          print([{ kind: "out", text: "^C" }]);
        } else {
          print([{ kind: "cmd", cwd, text: `${input}^C`, cont: pending !== null }]);
          setInput("");
          setPending(null);
          histPosRef.current = -1;
        }
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        if (running || pending !== null) return;
        const c = complete(input, cwd, childrenMap);
        if (!c) return;
        if (c.input !== undefined) setInput(c.input);
        else if (c.candidates) {
          print([
            { kind: "cmd", cwd, text: input },
            { kind: "out", text: c.candidates.join("  ") },
          ]);
        }
        return;
      }
      if (e.ctrlKey && (e.key === "l" || e.key === "L")) {
        e.preventDefault();
        setLines([]);
        return;
      }
      if (running) return;
      if (e.key === "Enter" && !e.nativeEvent.isComposing) {
        const v = input;
        setInput("");
        void submit(v);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        const h = historyRef.current;
        if (h.length === 0) return;
        const pos = histPosRef.current === -1 ? h.length - 1 : Math.max(0, histPosRef.current - 1);
        histPosRef.current = pos;
        setInput(h[pos]);
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        const h = historyRef.current;
        if (histPosRef.current === -1) return;
        const pos = histPosRef.current + 1;
        if (pos >= h.length) {
          histPosRef.current = -1;
          setInput("");
        } else {
          histPosRef.current = pos;
          setInput(h[pos]);
        }
      }
    },
    [running, input, cwd, pending, childrenMap, print, submit],
  );

  const value = useMemo(
    () => ({
      lines,
      input,
      setInput,
      cwd,
      running,
      print,
      clear,
      submit,
      pending,
      handleKey,
      registerPreRun,
      registerFilesChanged,
      cloneRepo,
      printCloneResult,
    }),
    [
      lines, input, cwd, running, print, clear, submit, pending, handleKey,
      registerPreRun, registerFilesChanged, cloneRepo, printCloneResult,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

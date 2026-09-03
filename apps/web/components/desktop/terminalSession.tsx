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
  | { kind: "cmd"; cwd: string; text: string }
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
  const historyRef = useRef<string[]>([]);
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
        for (let i = 0; i < 90; i++) {
          await new Promise((r) => setTimeout(r, 650));
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
      const command = raw.trim();
      print([{ kind: "cmd", cwd, text: raw }]);
      if (command) {
        historyRef.current = [...historyRef.current.filter((c) => c !== command), command].slice(-100);
      }
      histPosRef.current = -1;
      if (!command) return;

      if (command === "clear" || command === "reset") {
        setLines([]);
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
        const dest = git.dest || git.name;
        const full = cwd && !dest.startsWith("/") ? `${cwd}/${dest}` : dest;
        setRunning(true);
        print([{ kind: "err", text: `Cloning into '${dest}'...` }]);
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

      await runServerCommand(command, cwd);
    },
    [cwd, dirSet, fileSet, print, runServerCommand, cloneRepo, printCloneResult],
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
          print([{ kind: "cmd", cwd, text: `${input}^C` }]);
          setInput("");
          histPosRef.current = -1;
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
    [running, input, cwd, print, submit],
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
      handleKey,
      registerPreRun,
      registerFilesChanged,
      cloneRepo,
      printCloneResult,
    }),
    [
      lines, input, cwd, running, print, clear, submit, handleKey,
      registerPreRun, registerFilesChanged, cloneRepo, printCloneResult,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

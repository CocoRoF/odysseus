"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "@/lib/api";
import type { GhEntry, GhFile, GhRepo, GhRepoView, GhSearchResult, GhTree } from "@/lib/types";
import { Markdown } from "@/components/Markdown";
import { useToast } from "@/components/toast";
import { copyText } from "@/lib/clipboard";
import {
  IconArrowLeft,
  IconArrowRight,
  IconBook,
  IconBranch,
  IconChevronLeft,
  IconChevronRight,
  IconCopy,
  IconDownload,
  IconFile,
  IconFolder,
  IconGithub,
  IconLock,
  IconRefresh,
  IconSearch,
  IconStar,
} from "@/components/icons";
import { useTerminalSession } from "../terminalSession";
import { useWorkspace } from "../workspace";

/**
 * GitHub 앱 — 시험장 안의 "인터넷"은 여기까지다.
 *
 * 주소창은 장식이 아니라 실제 경계다: github.com 이외의 주소는 아예 요청되지
 * 않는다. 검색 → 저장소 → 파일 열람 → `clone` 까지가 한 흐름이고, clone 은
 * 터미널의 `git clone` 과 **같은 경로**를 쓴다 (러너에 네트워크가 없으므로
 * 서버가 대신 받아 워크스페이스에 푼다).
 */

type View =
  | { kind: "home" }
  | { kind: "search"; q: string; page: number }
  | { kind: "repo"; owner: string; name: string; path: string }
  | { kind: "file"; owner: string; name: string; path: string };

const LANG_COLOR: Record<string, string> = {
  Python: "#3572A5",
  TypeScript: "#3178c6",
  JavaScript: "#f1e05a",
  Go: "#00ADD8",
  Rust: "#dea584",
  Java: "#b07219",
  C: "#555555",
  "C++": "#f34b7d",
  Shell: "#89e051",
  Ruby: "#701516",
  Kotlin: "#A97BFF",
  Swift: "#F05138",
  Dockerfile: "#384d54",
  HCL: "#844FBA",
  Jupyter: "#DA5B0B",
  "Jupyter Notebook": "#DA5B0B",
};

/** 탐색 주제 — 시험장에서 무엇을 찾아볼 수 있는지 힌트를 준다 (문제 정답은 아니다) */
const TOPICS = [
  { label: "LLM 서빙", q: "llm inference server" },
  { label: "vLLM", q: "vllm" },
  { label: "Kubernetes", q: "kubernetes gpu operator" },
  { label: "Docker Compose", q: "docker compose example" },
  { label: "KVM / 가상화", q: "kvm libvirt gpu passthrough" },
  { label: "데이터 파이프라인", q: "data pipeline python" },
  { label: "API 게이트웨이", q: "api gateway" },
  { label: "관측성", q: "prometheus grafana observability" },
];

function timeAgo(iso: string | null): string {
  if (!iso) return "";
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 3600) return `${Math.max(1, Math.round(d / 60))}분 전`;
  if (d < 86400) return `${Math.round(d / 3600)}시간 전`;
  if (d < 86400 * 30) return `${Math.round(d / 86400)}일 전`;
  if (d < 86400 * 365) return `${Math.round(d / 86400 / 30)}개월 전`;
  return `${Math.round(d / 86400 / 365)}년 전`;
}

function compactNum(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return String(n);
}

function LangDot({ language }: { language: string | null }) {
  if (!language) return null;
  return (
    <span className="flex items-center gap-1.5">
      <span
        className="h-[10px] w-[10px] rounded-full ring-1 ring-inset ring-white/15"
        style={{ background: LANG_COLOR[language] ?? "#8b949e" }}
      />
      {language}
    </span>
  );
}

const README_RE = /^readme(\.md|\.rst|\.txt)?$/i;

export function GithubApp({ readOnly = false }: { readOnly?: boolean }) {
  const { toast } = useToast();
  const ws = useWorkspace();
  const term = useTerminalSession();

  const [history, setHistory] = useState<View[]>([{ kind: "home" }]);
  const [cursor, setCursor] = useState(0);
  const view = history[cursor];

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<GhSearchResult | null>(null);
  const [repo, setRepo] = useState<GhRepoView | null>(null);
  const [tree, setTree] = useState<GhTree | null>(null);
  const [file, setFile] = useState<GhFile | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [cloning, setCloning] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  const go = useCallback(
    (next: View) => {
      setHistory((h) => [...h.slice(0, cursor + 1), next]);
      setCursor((c) => c + 1);
    },
    [cursor],
  );

  const address = useMemo(() => {
    if (view.kind === "home") return "github.com";
    if (view.kind === "search")
      return `github.com/search?q=${encodeURIComponent(view.q)}${view.page > 1 ? `&p=${view.page}` : ""}`;
    if (view.kind === "repo")
      return `github.com/${view.owner}/${view.name}${view.path ? `/tree/${view.path}` : ""}`;
    return `github.com/${view.owner}/${view.name}/blob/${view.path}`;
  }, [view]);

  // ── 데이터 적재 ──
  useEffect(() => {
    let alive = true;
    setError("");
    if (view.kind === "home") return;

    (async () => {
      setLoading(true);
      try {
        if (view.kind === "search") {
          const r = await api.get<GhSearchResult>(
            `/reference/github/search?q=${encodeURIComponent(view.q)}&page=${view.page}` +
              `&attempt_id=${ws.attemptId}&scenario_id=${ws.scenarioId}`,
          );
          if (alive) setResults(r);
        } else if (view.kind === "repo") {
          const [rv, tr] = await Promise.all([
            api.get<GhRepoView>(
              `/reference/github/repo?owner=${view.owner}&name=${view.name}&attempt_id=${ws.attemptId}&scenario_id=${ws.scenarioId}`,
            ),
            api.get<GhTree>(
              `/reference/github/tree?owner=${view.owner}&name=${view.name}&path=${encodeURIComponent(view.path)}`,
            ),
          ]);
          if (alive) {
            setRepo(rv);
            setTree(tr);
          }
        } else if (view.kind === "file") {
          const f = await api.get<GhFile>(
            `/reference/github/file?owner=${view.owner}&name=${view.name}&path=${encodeURIComponent(view.path)}`,
          );
          if (alive) setFile(f);
        }
      } catch (e) {
        if (alive) setError(e instanceof ApiError ? e.message : "불러오지 못했습니다");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [view, ws.attemptId, ws.scenarioId]);

  const submitSearch = (raw: string) => {
    const q = raw.trim();
    if (!q) return;
    // 주소를 그대로 붙여넣어도 저장소로 간다 (브라우저처럼)
    const m = q.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)/i);
    if (m) {
      go({ kind: "repo", owner: m[1], name: m[2].replace(/\.git$/, ""), path: "" });
      return;
    }
    const slug = q.match(/^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/);
    if (slug) {
      go({ kind: "repo", owner: slug[1], name: slug[2], path: "" });
      return;
    }
    go({ kind: "search", q, page: 1 });
  };

  const doClone = async (r: GhRepo) => {
    if (readOnly || cloning) return;
    setCloning(true);
    try {
      const res = await term.cloneRepo(r.owner, r.name, r.name, r.default_branch);
      // 터미널에도 남긴다 — 어디서 받았든 셸에서 이어서 작업하게 된다
      term.print([{ kind: "cmd", cwd: "", text: `git clone https://github.com/${r.full_name}.git` }]);
      term.printCloneResult(res);
      if (res.files === 0) {
        toast(
          res.limit === "workspace"
            ? "워크스페이스 파일 한도에 도달했습니다 — 필요 없는 파일을 정리한 뒤 다시 시도하세요"
            : "가져올 수 있는 텍스트 파일이 없습니다",
          "error",
        );
      } else {
        toast(
          res.limit === "workspace"
            ? `${res.dest}/ 에 ${res.files}개 — 워크스페이스 한도로 나머지는 받지 못했습니다`
            : res.truncated
              ? `${res.dest}/ 에 ${res.files}개 파일을 받았습니다 (저장소가 커서 일부만)`
              : `${res.dest}/ 에 ${res.files}개 파일을 받았습니다`,
          res.limit === "workspace" ? "info" : "success",
        );
      }
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "clone 에 실패했습니다", "error");
    } finally {
      setCloning(false);
    }
  };

  // ── 크롬 (주소창) ──
  const chrome = (
    <div className="flex h-11 shrink-0 items-center gap-2 border-b border-[#30363d] bg-[#161b22] px-2.5">
      <div className="flex items-center gap-0.5">
        <button
          title="뒤로"
          disabled={cursor === 0}
          onClick={() => setCursor((c) => Math.max(0, c - 1))}
          className="flex h-7 w-7 items-center justify-center rounded-md text-[#7d8590] transition enabled:hover:bg-white/10 enabled:hover:text-white disabled:opacity-30"
        >
          <IconArrowLeft size={15} />
        </button>
        <button
          title="앞으로"
          disabled={cursor >= history.length - 1}
          onClick={() => setCursor((c) => Math.min(history.length - 1, c + 1))}
          className="flex h-7 w-7 items-center justify-center rounded-md text-[#7d8590] transition enabled:hover:bg-white/10 enabled:hover:text-white disabled:opacity-30"
        >
          <IconArrowRight size={15} />
        </button>
        <button
          title="새로고침"
          onClick={() => setHistory((h) => [...h])}
          className="flex h-7 w-7 items-center justify-center rounded-md text-[#7d8590] transition hover:bg-white/10 hover:text-white"
        >
          <IconRefresh size={13} />
        </button>
      </div>
      <div className="flex min-w-0 flex-1 items-center gap-2 rounded-full border border-[#30363d] bg-[#0d1117] px-3 py-1.5">
        <IconLock size={11} className="shrink-0 text-emerald-500" />
        <span className="truncate font-mono text-[11.5px] text-[#7d8590]">{address}</span>
      </div>
      <form
        className="flex w-64 shrink-0 items-center gap-1.5 rounded-md border border-[#30363d] bg-[#0d1117] px-2.5 py-1.5 focus-within:border-[#2f81f7]"
        onSubmit={(e) => {
          e.preventDefault();
          submitSearch(query);
        }}
      >
        <IconSearch size={12} className="shrink-0 text-[#7d8590]" />
        <input
          ref={searchRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="저장소 검색"
          className="min-w-0 flex-1 border-0 bg-transparent p-0 text-[12.5px] text-[#e6edf3] outline-none placeholder:text-[#6e7681]"
        />
      </form>
    </div>
  );

  // ── 홈 ──
  const home = (
    <div className="flex h-full flex-col items-center justify-center px-8 text-center">
      <span className="mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-[#e6edf3] text-[#0d1117] shadow-lg">
        <IconGithub size={36} />
      </span>
      <h2 className="text-2xl font-bold text-[#e6edf3]">무엇을 찾고 있나요?</h2>
      <p className="mt-1.5 text-[13px] text-[#7d8590]">
        오픈소스 저장소를 검색하고, 읽고, 워크스페이스로 <code className="rounded bg-white/10 px-1 py-0.5 font-mono text-[11.5px]">clone</code> 할 수 있습니다.
      </p>
      <form
        className="mt-6 flex w-full max-w-xl items-center gap-2 rounded-xl border border-[#30363d] bg-[#0d1117] px-4 py-3 shadow-lg transition focus-within:border-[#2f81f7] focus-within:shadow-[0_0_0_3px_rgba(47,129,247,0.18)]"
        onSubmit={(e) => {
          e.preventDefault();
          submitSearch(query);
        }}
      >
        <IconSearch size={16} className="shrink-0 text-[#7d8590]" />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="저장소 이름, 키워드, 또는 owner/repo"
          className="min-w-0 flex-1 border-0 bg-transparent p-0 text-[15px] text-[#e6edf3] outline-none placeholder:text-[#6e7681]"
        />
        <button
          type="submit"
          className="shrink-0 rounded-lg bg-[#238636] px-3.5 py-1.5 text-[13px] font-semibold text-white transition hover:bg-[#2ea043]"
        >
          검색
        </button>
      </form>
      <div className="mt-7 w-full max-w-xl">
        <p className="mb-2.5 text-[11px] font-semibold uppercase tracking-wider text-[#6e7681]">
          자주 찾는 주제
        </p>
        <div className="flex flex-wrap justify-center gap-2">
          {TOPICS.map((t) => (
            <button
              key={t.label}
              onClick={() => {
                setQuery(t.q);
                go({ kind: "search", q: t.q, page: 1 });
              }}
              className="rounded-full border border-[#30363d] bg-[#161b22] px-3 py-1.5 text-[12px] text-[#7d8590] transition hover:border-[#2f81f7] hover:text-[#e6edf3]"
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>
      <p className="mt-8 flex items-center gap-1.5 text-[11px] text-[#6e7681]">
        <IconLock size={10} /> 이 워크스테이션에서는 github.com 만 열 수 있습니다
      </p>
    </div>
  );

  // ── 검색 결과 ──
  // GitHub 검색 API 는 1,000건(20건 × 10페이지)까지만 돌려준다
  const PER_PAGE = 20;
  const API_PAGE_CAP = 10;
  const totalPages =
    view.kind === "search" && results
      ? Math.min(API_PAGE_CAP, Math.max(1, Math.ceil(results.total / PER_PAGE)))
      : 1;
  const pageWindow: (number | null)[] = [];
  if (view.kind === "search" && totalPages > 1) {
    const cur = view.page;
    const nums = new Set<number>([1, totalPages, cur, cur - 1, cur + 1]);
    const sorted = [...nums].filter((n) => n >= 1 && n <= totalPages).sort((a, b) => a - b);
    sorted.forEach((n, i) => {
      if (i > 0 && n - sorted[i - 1] > 1) pageWindow.push(null);
      pageWindow.push(n);
    });
  }

  const searchView =
    view.kind === "search" ? (
      <div className="mx-auto w-full max-w-4xl px-6 py-5">
        <div className="flex items-baseline justify-between gap-3 border-b border-[#21262d] pb-3">
          <p className="text-[15px] font-semibold text-[#e6edf3]">
            저장소 결과 {results ? `${results.total.toLocaleString()}건` : ""}
          </p>
          {results && totalPages > 1 && (
            <span className="shrink-0 text-[12px] text-[#7d8590]">
              {view.page} / {totalPages} 페이지
            </span>
          )}
        </div>
        <ul className="divide-y divide-[#21262d]">
          {(results?.items ?? []).map((r) => (
            <li key={r.full_name} className="py-4">
              <div className="flex items-start gap-3">
                <button
                  onClick={() => go({ kind: "repo", owner: r.owner, name: r.name, path: "" })}
                  className="text-left text-[16px] font-semibold text-[#2f81f7] hover:underline"
                >
                  {r.owner}/<span className="font-bold">{r.name}</span>
                </button>
                {r.archived && (
                  <span className="mt-1 rounded-full border border-[#9e6a03] px-2 py-0.5 text-[10px] text-[#d29922]">
                    Archived
                  </span>
                )}
                {!readOnly && (
                  <button
                    onClick={() => doClone(r)}
                    disabled={cloning}
                    title="워크스페이스로 clone"
                    className="ml-auto flex shrink-0 items-center gap-1.5 rounded-md border border-[#30363d] bg-[#21262d] px-2.5 py-1 text-[11.5px] font-semibold text-[#e6edf3] transition hover:bg-[#30363d] disabled:opacity-50"
                  >
                    <IconDownload size={11} /> clone
                  </button>
                )}
              </div>
              {r.description && (
                <p className="mt-1.5 line-clamp-2 text-[13px] leading-relaxed text-[#7d8590]">
                  {r.description}
                </p>
              )}
              {r.topics.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {r.topics.slice(0, 6).map((t) => (
                    <span
                      key={t}
                      className="rounded-full bg-[#121d2f] px-2 py-0.5 text-[11px] text-[#4493f8]"
                    >
                      {t}
                    </span>
                  ))}
                </div>
              )}
              <div className="mt-2.5 flex flex-wrap items-center gap-4 text-[12px] text-[#7d8590]">
                <span className="flex items-center gap-1">
                  <IconStar size={12} /> {compactNum(r.stars)}
                </span>
                <LangDot language={r.language} />
                {r.license && <span>{r.license}</span>}
                <span>업데이트: {timeAgo(r.updated_at)}</span>
              </div>
            </li>
          ))}
        </ul>
        {results && results.items.length === 0 && !loading && (
          <p className="py-16 text-center text-sm text-[#7d8590]">일치하는 저장소가 없습니다.</p>
        )}

        {/* 페이지 이동 — GitHub 검색 API 는 최대 10 페이지(1,000건)까지 돌려준다 */}
        {results && totalPages > 1 && (
          <nav className="flex items-center justify-center gap-1 py-6">
            <button
              disabled={view.page <= 1}
              onClick={() => go({ kind: "search", q: view.q, page: view.page - 1 })}
              className="flex h-8 items-center gap-1 rounded-md border border-[#30363d] px-2.5 text-[12.5px] text-[#e6edf3] transition enabled:hover:bg-[#21262d] disabled:opacity-35"
            >
              <IconChevronLeft size={13} /> 이전
            </button>
            {pageWindow.map((p, i) =>
              p === null ? (
                <span key={`gap-${i}`} className="px-1.5 text-[12.5px] text-[#6e7681]">
                  …
                </span>
              ) : (
                <button
                  key={p}
                  onClick={() => go({ kind: "search", q: view.q, page: p })}
                  aria-current={p === view.page ? "page" : undefined}
                  className={`h-8 min-w-8 rounded-md border px-2 text-[12.5px] transition ${
                    p === view.page
                      ? "border-[#2f81f7] bg-[#2f81f7] font-semibold text-white"
                      : "border-[#30363d] text-[#e6edf3] hover:bg-[#21262d]"
                  }`}
                >
                  {p}
                </button>
              ),
            )}
            <button
              disabled={view.page >= totalPages}
              onClick={() => go({ kind: "search", q: view.q, page: view.page + 1 })}
              className="flex h-8 items-center gap-1 rounded-md border border-[#30363d] px-2.5 text-[12.5px] text-[#e6edf3] transition enabled:hover:bg-[#21262d] disabled:opacity-35"
            >
              다음 <IconChevronRight size={13} />
            </button>
          </nav>
        )}
      </div>
    ) : null;

  // ── 저장소 ──
  const crumbs = view.kind === "repo" && view.path ? view.path.split("/") : [];
  const readmeEntry =
    view.kind === "repo" && !view.path && repo?.readme ? repo.readme : null;

  const repoView =
    view.kind === "repo" && repo ? (
      <div className="mx-auto w-full max-w-6xl px-6 py-5">
        {/* 헤더 */}
        <div className="flex flex-wrap items-center gap-2 border-b border-[#21262d] pb-4">
          <IconBook size={16} className="text-[#7d8590]" />
          <h2 className="text-[19px] text-[#e6edf3]">
            <button
              onClick={() => go({ kind: "search", q: repo.repo.owner, page: 1 })}
              className="text-[#2f81f7] hover:underline"
            >
              {repo.repo.owner}
            </button>
            <span className="mx-1 text-[#7d8590]">/</span>
            <button
              onClick={() => go({ kind: "repo", owner: repo.repo.owner, name: repo.repo.name, path: "" })}
              className="font-bold text-[#2f81f7] hover:underline"
            >
              {repo.repo.name}
            </button>
          </h2>
          <span className="rounded-full border border-[#30363d] px-2 py-0.5 text-[11px] text-[#7d8590]">
            Public
          </span>
          <div className="ml-auto flex items-center gap-2">
            <span className="flex items-center gap-1.5 rounded-md border border-[#30363d] bg-[#21262d] px-2.5 py-1 text-[12px] text-[#e6edf3]">
              <IconStar size={12} /> Star <span className="text-[#7d8590]">{compactNum(repo.repo.stars)}</span>
            </span>
            {!readOnly && (
              <button
                onClick={() => doClone(repo.repo)}
                disabled={cloning}
                className="flex items-center gap-1.5 rounded-md bg-[#238636] px-3 py-1 text-[12px] font-semibold text-white transition hover:bg-[#2ea043] disabled:opacity-60"
              >
                <IconDownload size={12} /> {cloning ? "받는 중…" : "Clone"}
              </button>
            )}
          </div>
        </div>

        <div className="mt-4 flex flex-col gap-6 lg:flex-row">
          {/* 파일 트리 */}
          <div className="min-w-0 flex-1">
            <div className="mb-3 flex flex-wrap items-center gap-2 text-[12px]">
              <span className="flex items-center gap-1.5 rounded-md border border-[#30363d] bg-[#21262d] px-2.5 py-1 text-[#e6edf3]">
                <IconBranch size={12} /> {repo.repo.default_branch}
              </span>
              <span className="text-[#7d8590]">
                <button
                  onClick={() => go({ kind: "repo", owner: repo.repo.owner, name: repo.repo.name, path: "" })}
                  className="font-semibold text-[#2f81f7] hover:underline"
                >
                  {repo.repo.name}
                </button>
                {crumbs.map((c, i) => (
                  <span key={i}>
                    <span className="mx-1">/</span>
                    {i === crumbs.length - 1 ? (
                      <span className="text-[#e6edf3]">{c}</span>
                    ) : (
                      <button
                        onClick={() =>
                          go({
                            kind: "repo",
                            owner: repo.repo.owner,
                            name: repo.repo.name,
                            path: crumbs.slice(0, i + 1).join("/"),
                          })
                        }
                        className="text-[#2f81f7] hover:underline"
                      >
                        {c}
                      </button>
                    )}
                  </span>
                ))}
              </span>
            </div>

            <div className="overflow-hidden rounded-lg border border-[#30363d]">
              {view.path && (
                <button
                  onClick={() =>
                    go({
                      kind: "repo",
                      owner: repo.repo.owner,
                      name: repo.repo.name,
                      path: crumbs.slice(0, -1).join("/"),
                    })
                  }
                  className="flex w-full items-center gap-2.5 border-b border-[#21262d] px-4 py-2 text-[13px] text-[#2f81f7] transition hover:bg-[#161b22]"
                >
                  <IconFolder size={14} className="text-[#7d8590]" /> ..
                </button>
              )}
              {(tree?.entries ?? []).map((e: GhEntry) => (
                <button
                  key={e.path}
                  onClick={() =>
                    e.type === "dir"
                      ? go({ kind: "repo", owner: repo.repo.owner, name: repo.repo.name, path: e.path })
                      : go({ kind: "file", owner: repo.repo.owner, name: repo.repo.name, path: e.path })
                  }
                  className="flex w-full items-center gap-2.5 border-b border-[#21262d] px-4 py-2 text-left text-[13px] transition last:border-0 hover:bg-[#161b22]"
                >
                  <span className="shrink-0 text-[#7d8590]">
                    {e.type === "dir" ? <IconFolder size={14} className="text-[#54aeff]" /> : <IconFile size={14} />}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[#e6edf3] hover:text-[#2f81f7] hover:underline">
                    {e.name}
                  </span>
                  {e.type === "file" && e.size > 0 && (
                    <span className="shrink-0 text-[11px] text-[#6e7681]">
                      {e.size >= 1024 ? `${Math.round(e.size / 1024)} KB` : `${e.size} B`}
                    </span>
                  )}
                </button>
              ))}
              {!loading && (tree?.entries ?? []).length === 0 && (
                <p className="px-4 py-10 text-center text-[13px] text-[#7d8590]">비어 있는 디렉터리입니다.</p>
              )}
            </div>

            {/* README */}
            {readmeEntry && (
              <div className="mt-5 overflow-hidden rounded-lg border border-[#30363d]">
                <div className="flex items-center gap-2 border-b border-[#30363d] bg-[#161b22] px-4 py-2.5 text-[13px] font-semibold text-[#e6edf3]">
                  <IconBook size={13} className="text-[#7d8590]" /> {readmeEntry.path}
                </div>
                <div className="gh-readme max-h-[520px] overflow-y-auto px-6 py-5">
                  <Markdown dark>{readmeEntry.content}</Markdown>
                </div>
              </div>
            )}
          </div>

          {/* About */}
          <aside className="w-full shrink-0 lg:w-64">
            <p className="mb-2 text-[15px] font-semibold text-[#e6edf3]">About</p>
            <p className="text-[13px] leading-relaxed text-[#7d8590]">
              {repo.repo.description || "설명이 없습니다."}
            </p>
            {repo.repo.topics.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {repo.repo.topics.slice(0, 12).map((t) => (
                  <button
                    key={t}
                    onClick={() => go({ kind: "search", q: t, page: 1 })}
                    className="rounded-full bg-[#121d2f] px-2 py-0.5 text-[11px] text-[#4493f8] transition hover:bg-[#173054]"
                  >
                    {t}
                  </button>
                ))}
              </div>
            )}
            <dl className="mt-4 space-y-2 border-t border-[#21262d] pt-4 text-[12.5px] text-[#7d8590]">
              <div className="flex items-center gap-2">
                <IconStar size={13} /> {repo.repo.stars.toLocaleString()} stars
              </div>
              <div className="flex items-center gap-2">
                <IconBranch size={13} /> {repo.repo.forks.toLocaleString()} forks
              </div>
              {repo.repo.language && (
                <div className="flex items-center gap-2">
                  <LangDot language={repo.repo.language} />
                </div>
              )}
              {repo.repo.license && <div>라이선스 {repo.repo.license}</div>}
              <div>업데이트 {timeAgo(repo.repo.updated_at)}</div>
            </dl>
            {!readOnly && (
              <div className="mt-4 rounded-lg border border-[#30363d] bg-[#161b22] p-3">
                <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-[#6e7681]">
                  터미널에서도 가능
                </p>
                <code className="block break-all rounded bg-[#0d1117] px-2 py-1.5 font-mono text-[11px] text-[#7d8590]">
                  git clone https://github.com/{repo.repo.full_name}.git
                </code>
              </div>
            )}
          </aside>
        </div>
      </div>
    ) : null;

  // ── 파일 ──
  const fileView =
    view.kind === "file" ? (
      <div className="mx-auto w-full max-w-5xl px-6 py-5">
        <div className="mb-3 flex items-center gap-2 text-[13px]">
          <button
            onClick={() =>
              go({
                kind: "repo",
                owner: view.owner,
                name: view.name,
                path: view.path.includes("/") ? view.path.slice(0, view.path.lastIndexOf("/")) : "",
              })
            }
            className="flex items-center gap-1 text-[#2f81f7] hover:underline"
          >
            <IconChevronRight size={12} className="rotate-180" /> 돌아가기
          </button>
          <span className="truncate font-mono text-[#7d8590]">
            {view.owner}/{view.name} · {view.path}
          </span>
          {file && (
            <button
              onClick={async () => {
                if (await copyText(file.content)) toast("파일 내용을 복사했습니다", "success");
              }}
              className="ml-auto flex items-center gap-1.5 rounded-md border border-[#30363d] bg-[#21262d] px-2.5 py-1 text-[11.5px] text-[#e6edf3] transition hover:bg-[#30363d]"
            >
              <IconCopy size={11} /> 복사
            </button>
          )}
        </div>
        {file && (
          <div className="overflow-hidden rounded-lg border border-[#30363d]">
            {README_RE.test(file.path.split("/").pop() ?? "") ? (
              <div className="gh-readme overflow-x-auto px-6 py-5">
                <Markdown dark>{file.content}</Markdown>
              </div>
            ) : (
              <div className="overflow-auto bg-[#0d1117]">
                <table className="w-full border-collapse font-mono text-[12px] leading-[1.6]">
                  <tbody>
                    {file.content.split("\n").map((ln, i) => (
                      <tr key={i}>
                        <td className="w-12 select-none border-r border-[#21262d] px-3 text-right align-top text-[#6e7681]">
                          {i + 1}
                        </td>
                        <td className="whitespace-pre-wrap break-all px-4 text-[#e6edf3]">{ln || " "}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    ) : null;

  return (
    <div className="flex h-full flex-col bg-[#0d1117]">
      {chrome}
      <div className="thin-scroll min-h-0 flex-1 overflow-y-auto">
        {loading && (
          <div className="h-[3px] w-full overflow-hidden bg-[#161b22]">
            <div className="h-full w-1/3 animate-[gh-load_1.1s_ease-in-out_infinite] bg-[#2f81f7]" />
          </div>
        )}
        {error ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
            <IconGithub size={40} className="text-[#30363d]" />
            <p className="text-sm text-[#e6edf3]">{error}</p>
            <button
              onClick={() => setCursor(0)}
              className="rounded-md border border-[#30363d] bg-[#21262d] px-3 py-1.5 text-[12px] text-[#e6edf3] hover:bg-[#30363d]"
            >
              처음으로
            </button>
          </div>
        ) : view.kind === "home" ? (
          home
        ) : (
          <>
            {searchView}
            {repoView}
            {fileView}
          </>
        )}
      </div>
    </div>
  );
}

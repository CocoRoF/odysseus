"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "@/lib/api";
import type { WebPage, WebSearchResponse } from "@/lib/types";
import { useToast } from "@/components/toast";
import { copyText, selectedText } from "@/lib/clipboard";
import {
  IconArrowLeft,
  IconArrowRight,
  IconCopy,
  IconGlobe,
  IconLock,
  IconRefresh,
  IconSearch,
} from "@/components/icons";
import { ContextMenuView, MenuEntry, useContextMenu } from "../ContextMenu";
import { useWorkspace } from "../workspace";

/**
 * 인터넷 앱 — 검색과 읽기만 되는 브라우저.
 *
 * 임의의 주소를 치고 들어가는 창이 아니라 **검색으로 시작하는** 창이다. 페이지는
 * 스크립트를 걷어낸 읽기 화면으로 열리므로, 문서를 참고하는 용도 그대로 쓰인다.
 */

type View = { kind: "home" } | { kind: "search"; q: string } | { kind: "page"; url: string };

const SUGGESTIONS = [
  "vllm tensor parallel 설정",
  "docker compose gpu 예약",
  "kubernetes hpa custom metrics",
  "nginx reverse proxy timeout",
  "pandas groupby 집계",
  "prometheus histogram quantile",
];

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function BrowserApp() {
  const { toast } = useToast();
  const ws = useWorkspace();

  const [history, setHistory] = useState<View[]>([{ kind: "home" }]);
  const [cursor, setCursor] = useState(0);
  const view = history[cursor];

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<WebSearchResponse | null>(null);
  const [page, setPage] = useState<WebPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const { menu, open: openMenu, close: closeMenu } = useContextMenu();

  const go = useCallback(
    (next: View) => {
      setHistory((h) => [...h.slice(0, cursor + 1), next]);
      setCursor((c) => c + 1);
    },
    [cursor],
  );

  const address = useMemo(() => {
    if (view.kind === "home") return "search.odysseus.net";
    if (view.kind === "search") return `search.odysseus.net/?q=${encodeURIComponent(view.q)}`;
    return view.url;
  }, [view]);

  useEffect(() => {
    let alive = true;
    setError("");
    scrollRef.current?.scrollTo({ top: 0 });
    if (view.kind === "home") return;
    (async () => {
      setLoading(true);
      try {
        if (view.kind === "search") {
          const r = await api.get<WebSearchResponse>(
            `/reference/web/search?q=${encodeURIComponent(view.q)}&attempt_id=${ws.attemptId}&scenario_id=${ws.scenarioId}`,
          );
          if (alive) setResults(r);
        } else {
          const p = await api.get<WebPage>(
            `/reference/web/page?url=${encodeURIComponent(view.url)}&attempt_id=${ws.attemptId}&scenario_id=${ws.scenarioId}`,
          );
          if (alive) setPage(p);
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

  const submit = (raw: string) => {
    const q = raw.trim();
    if (q) go({ kind: "search", q });
  };

  const searchBar = (big: boolean) => (
    <form
      className={
        big
          ? "flex w-full max-w-2xl items-center gap-3 rounded-full border border-slate-300 bg-white px-5 py-3.5 shadow-[0_1px_6px_rgba(32,33,36,0.28)] transition focus-within:shadow-[0_1px_10px_rgba(32,33,36,0.34)]"
          : "flex min-w-0 flex-1 items-center gap-2.5 rounded-full border border-slate-300 bg-white px-4 py-2 focus-within:border-sky-400 focus-within:shadow-[0_0_0_3px_rgba(56,189,248,0.15)]"
      }
      onSubmit={(e) => {
        e.preventDefault();
        submit(query);
      }}
    >
      <IconSearch size={big ? 18 : 14} className="shrink-0 text-slate-400" />
      <input
        autoFocus={big}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="검색어를 입력하세요"
        className={`min-w-0 flex-1 border-0 bg-transparent p-0 text-slate-800 outline-none placeholder:text-slate-400 ${
          big ? "text-[16px]" : "text-[13px]"
        }`}
      />
      {big && (
        <button
          type="submit"
          className="shrink-0 rounded-full bg-sky-600 px-4 py-1.5 text-[13px] font-semibold text-white transition hover:bg-sky-500"
        >
          검색
        </button>
      )}
    </form>
  );

  const pageMenu = (e: React.MouseEvent) => {
    const sel = selectedText();
    const items: MenuEntry[] = [];
    if (sel) {
      items.push({ label: "선택 영역 복사", shortcut: "Ctrl+C", onClick: () => copyText(sel) });
      items.push({ label: `'${sel.slice(0, 18)}${sel.length > 18 ? "…" : ""}' 검색`, onClick: () => { setQuery(sel); go({ kind: "search", q: sel }); } });
    }
    if (view.kind === "page" && page) {
      items.push({ label: "페이지 내용 복사", onClick: () => copyText(page.text) });
      items.push({ label: "페이지 주소 복사", onClick: () => copyText(page.url) });
    }
    items.push("separator");
    items.push({ label: "뒤로", disabled: cursor === 0, onClick: () => setCursor((c) => Math.max(0, c - 1)) });
    items.push({
      label: "앞으로",
      disabled: cursor >= history.length - 1,
      onClick: () => setCursor((c) => Math.min(history.length - 1, c + 1)),
    });
    items.push({ label: "처음으로", onClick: () => setCursor(0) });
    openMenu(e, items);
  };

  return (
    <div className="flex h-full flex-col bg-white" onContextMenu={pageMenu}>
      <ContextMenuView menu={menu} onClose={closeMenu} />
      {/* 크롬 */}
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-slate-200 bg-slate-100 px-2.5">
        <div className="flex items-center gap-0.5">
          <button
            title="뒤로"
            disabled={cursor === 0}
            onClick={() => setCursor((c) => Math.max(0, c - 1))}
            className="flex h-7 w-7 items-center justify-center rounded-md text-slate-500 transition enabled:hover:bg-slate-200 disabled:opacity-30"
          >
            <IconArrowLeft size={15} />
          </button>
          <button
            title="앞으로"
            disabled={cursor >= history.length - 1}
            onClick={() => setCursor((c) => Math.min(history.length - 1, c + 1))}
            className="flex h-7 w-7 items-center justify-center rounded-md text-slate-500 transition enabled:hover:bg-slate-200 disabled:opacity-30"
          >
            <IconArrowRight size={15} />
          </button>
          <button
            title="새로고침"
            onClick={() => setHistory((h) => [...h])}
            className="flex h-7 w-7 items-center justify-center rounded-md text-slate-500 transition hover:bg-slate-200"
          >
            <IconRefresh size={13} />
          </button>
        </div>
        <div className="flex min-w-0 flex-[1.4] items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1.5">
          <IconLock size={11} className="shrink-0 text-emerald-600" />
          <span className="truncate font-mono text-[11.5px] text-slate-500">{address}</span>
        </div>
        {view.kind !== "home" && searchBar(false)}
      </div>

      {loading && (
        <div className="h-[3px] w-full overflow-hidden bg-slate-100">
          <div className="h-full w-1/3 animate-[gh-load_1.1s_ease-in-out_infinite] bg-sky-500" />
        </div>
      )}

      <div ref={scrollRef} className="thin-scroll min-h-0 flex-1 overflow-y-auto">
        {error ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
            <IconGlobe size={40} className="text-slate-300" />
            <p className="text-sm text-slate-700">{error}</p>
            <button
              onClick={() => setCursor(0)}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-[12px] text-slate-600 hover:bg-slate-50"
            >
              처음으로
            </button>
          </div>
        ) : view.kind === "home" ? (
          /* ── 시작 화면 ── */
          <div className="flex h-full flex-col items-center justify-center px-8">
            <div className="mb-8 flex items-center gap-3">
              <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-sky-400 via-blue-500 to-indigo-600 text-white shadow-lg">
                <IconGlobe size={26} />
              </span>
              <span className="text-[30px] font-bold tracking-tight text-slate-800">
                Odysseus <span className="text-sky-600">Search</span>
              </span>
            </div>
            {searchBar(true)}
            <div className="mt-8 w-full max-w-2xl">
              <p className="mb-2.5 text-center text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                이런 것을 찾아볼 수 있습니다
              </p>
              <div className="flex flex-wrap justify-center gap-2">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    onClick={() => {
                      setQuery(s);
                      go({ kind: "search", q: s });
                    }}
                    className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1.5 text-[12px] text-slate-600 transition hover:border-sky-300 hover:bg-white hover:text-slate-800"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
            <p className="mt-10 flex items-center gap-1.5 text-[11px] text-slate-400">
              <IconLock size={10} /> 검색과 읽기만 가능한 시험용 브라우저입니다
            </p>
          </div>
        ) : view.kind === "search" ? (
          /* ── 검색 결과 ── */
          <div className="mx-auto w-full max-w-3xl px-6 py-6">
            <p className="mb-4 text-[12px] text-slate-400">
              &lsquo;{view.q}&rsquo; 검색 결과 {results ? `약 ${results.results.length}건` : ""}
            </p>
            <ul className="space-y-6">
              {(results?.results ?? []).map((r, i) => (
                <li key={`${r.url}-${i}`}>
                  <div className="flex items-center gap-2 text-[12px] text-slate-500">
                    <span className="flex h-5 w-5 items-center justify-center rounded-full bg-slate-100 text-[9px] font-bold uppercase text-slate-500">
                      {hostOf(r.url).slice(0, 1)}
                    </span>
                    <span className="truncate">{hostOf(r.url)}</span>
                  </div>
                  <button
                    onClick={() => go({ kind: "page", url: r.url })}
                    className="mt-1 block text-left text-[18px] leading-snug text-[#1a0dab] hover:underline"
                  >
                    {r.title}
                  </button>
                  <p className="mt-1 line-clamp-3 text-[13.5px] leading-relaxed text-slate-600">
                    {r.snippet}
                  </p>
                </li>
              ))}
            </ul>
            {results && results.results.length === 0 && !loading && (
              <p className="py-16 text-center text-sm text-slate-500">검색 결과가 없습니다.</p>
            )}
          </div>
        ) : (
          /* ── 페이지 (읽기 화면) ── */
          page && (
            <div className="mx-auto w-full max-w-3xl px-8 py-7">
              <div className="flex items-start gap-3 border-b border-slate-200 pb-4">
                <div className="min-w-0 flex-1">
                  <h1 className="text-[22px] font-bold leading-snug text-slate-900">{page.title}</h1>
                  <p className="mt-1 truncate font-mono text-[11.5px] text-slate-400">{page.url}</p>
                </div>
                <button
                  onClick={async () => {
                    if (await copyText(page.text)) toast("페이지 내용을 복사했습니다", "success");
                  }}
                  className="flex shrink-0 items-center gap-1.5 rounded-md border border-slate-300 px-2.5 py-1 text-[11.5px] text-slate-600 transition hover:bg-slate-50"
                >
                  <IconCopy size={11} /> 복사
                </button>
              </div>
              <div className="mt-5 whitespace-pre-wrap text-[14px] leading-[1.75] text-slate-700">
                {page.text}
              </div>
              <p className="mt-8 border-t border-slate-200 pt-4 text-[11px] text-slate-400">
                읽기 화면입니다 — 스크립트와 스타일은 제거되었습니다.
              </p>
            </div>
          )
        )}
      </div>
    </div>
  );
}

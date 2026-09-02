"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError } from "@/lib/api";
import { fmtBytes, fmtDateTime } from "@/lib/format";
import { useToast } from "@/components/toast";
import {
  IconArrowLeft,
  IconArrowRight,
  IconArrowUp,
  IconChevronRight,
  IconClose,
  IconDelete,
  IconGridView,
  IconIde,
  IconListView,
  IconMonitor,
  IconRefresh,
  IconView,
} from "@/components/icons";
import { useWorkspace } from "../workspace";
import { typeLabel, FileGlyph, FolderGlyph } from "../fileicons";
import { FilePreview } from "../FilePreview";
import type { FileEntry } from "@/lib/types";

// ── 디렉터리 계산 ────────────────────────────────────────────

interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  updated_at: string;
  childCount: number;
}

function entriesOf(files: FileEntry[], cwd: string): DirEntry[] {
  const prefix = cwd ? `${cwd}/` : "";
  const dirs = new Map<string, DirEntry>();
  const out: DirEntry[] = [];
  for (const f of files) {
    if (!f.path.startsWith(prefix)) continue;
    const rest = f.path.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash === -1) {
      out.push({ name: rest, path: f.path, isDir: false, size: f.size, updated_at: f.updated_at, childCount: 0 });
    } else {
      const name = rest.slice(0, slash);
      const dpath = prefix + name;
      const existing = dirs.get(dpath);
      if (existing) {
        existing.childCount += 1;
        if (f.updated_at > existing.updated_at) existing.updated_at = f.updated_at;
      } else {
        dirs.set(dpath, { name, path: dpath, isDir: true, size: 0, updated_at: f.updated_at, childCount: 1 });
      }
    }
  }
  const sorted = [...dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
  out.sort((a, b) => a.name.localeCompare(b.name));
  return [...sorted, ...out];
}

function allDirs(files: FileEntry[]): string[] {
  const set = new Set<string>();
  for (const f of files) {
    const parts = f.path.split("/");
    for (let i = 1; i < parts.length; i++) set.add(parts.slice(0, i).join("/"));
  }
  return [...set].sort();
}

// ── 탐색기 본체 ──────────────────────────────────────────────

/** 폴더(탐색기) — Windows 탐색기 규약: 뒤로/앞으로/위로, 주소 표시줄, 목록/아이콘 보기,
 *  클릭=선택(+미리보기), 더블클릭=폴더 진입/뷰어 열기. */
export function FilesApp({ readOnly = false }: { readOnly?: boolean }) {
  const ws = useWorkspace();
  const { toast, confirm } = useToast();
  const [cwd, setCwd] = useState("");
  const [history, setHistory] = useState<string[]>([""]);
  const [histIdx, setHistIdx] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<"list" | "grid">("list");
  const [previewOn, setPreviewOn] = useState(readOnly); // 리뷰 화면은 기본 켜짐
  const [content, setContent] = useState<string | null>(null);
  const lastClickRef = useRef<{ path: string; t: number } | null>(null);

  const entries = useMemo(() => entriesOf(ws.files, cwd), [ws.files, cwd]);
  const dirs = useMemo(() => allDirs(ws.files), [ws.files]);
  const selectedEntry = entries.find((e) => e.path === selected) ?? null;

  const navigate = (path: string) => {
    if (path === cwd) return;
    const next = [...history.slice(0, histIdx + 1), path];
    setHistory(next);
    setHistIdx(next.length - 1);
    setCwd(path);
    setSelected(null);
  };
  const goBack = () => {
    if (histIdx > 0) {
      setHistIdx(histIdx - 1);
      setCwd(history[histIdx - 1]);
      setSelected(null);
    }
  };
  const goForward = () => {
    if (histIdx < history.length - 1) {
      setHistIdx(histIdx + 1);
      setCwd(history[histIdx + 1]);
      setSelected(null);
    }
  };
  const goUp = () => {
    if (!cwd) return;
    navigate(cwd.includes("/") ? cwd.slice(0, cwd.lastIndexOf("/")) : "");
  };

  // 파일 선택 시 미리보기 로드
  useEffect(() => {
    if (!previewOn || !selected || selectedEntry?.isDir) {
      setContent(null);
      return;
    }
    setContent(null);
    ws.loadContent(selected)
      .then((fc) => setContent(fc.content))
      .catch(() => setContent("(파일을 불러올 수 없습니다)"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, previewOn, selectedEntry?.updated_at]);

  // cwd가 사라졌으면(전체 삭제) 루트로 복귀
  useEffect(() => {
    if (cwd && !dirs.includes(cwd)) {
      setCwd("");
      setSelected(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirs.join("|")]);

  const activate = (e: DirEntry) => {
    if (e.isDir) navigate(e.path);
    else ws.openInViewer(e.path);
  };

  /** 클릭=선택. 같은 항목 400ms 내 재클릭=더블클릭으로 간주해 활성화. */
  const handleSelect = (e: DirEntry) => {
    const now = Date.now();
    const last = lastClickRef.current;
    lastClickRef.current = { path: e.path, t: now };
    if (last && last.path === e.path && now - last.t < 400) {
      activate(e);
      return;
    }
    setSelected(e.path);
  };

  const remove = async (path: string) => {
    if (!(await confirm({ title: "파일을 삭제할까요?", message: path, danger: true, confirmLabel: "삭제" })))
      return;
    try {
      await ws.deleteFile(path);
      if (selected === path) setSelected(null);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "삭제 실패", "error");
    }
  };

  const crumbs = cwd ? cwd.split("/") : [];
  const previewFile = previewOn && selectedEntry && !selectedEntry.isDir ? selectedEntry : null;

  const toolBtn =
    "flex h-7 w-7 items-center justify-center rounded-md text-slate-500 transition hover:bg-slate-200/70 hover:text-slate-700 disabled:pointer-events-none disabled:opacity-30";

  return (
    <div className="flex h-full min-h-0 flex-col bg-white">
      {/* 도구 모음 + 주소 표시줄 */}
      <div className="flex shrink-0 items-center gap-1 border-b border-slate-200 bg-slate-50/80 px-2 py-1.5">
        <button title="뒤로" className={toolBtn} onClick={goBack} disabled={histIdx === 0}>
          <IconArrowLeft size={15} />
        </button>
        <button title="앞으로" className={toolBtn} onClick={goForward} disabled={histIdx >= history.length - 1}>
          <IconArrowRight size={15} />
        </button>
        <button title="위로" className={toolBtn} onClick={goUp} disabled={!cwd}>
          <IconArrowUp size={15} />
        </button>
        {/* 주소 표시줄 (브레드크럼) */}
        <div className="mx-1 flex h-8 min-w-0 flex-1 items-center gap-0.5 overflow-hidden rounded-lg border border-slate-200 bg-white px-2 text-[13px]">
          <button
            onClick={() => navigate("")}
            className={`flex shrink-0 items-center gap-1.5 rounded px-1.5 py-0.5 hover:bg-slate-100 ${
              cwd ? "text-slate-600" : "font-semibold text-slate-800"
            }`}
          >
            <IconMonitor size={13} className="text-sky-500" />
            워크스페이스
          </button>
          {crumbs.map((seg, i) => {
            const path = crumbs.slice(0, i + 1).join("/");
            const last = i === crumbs.length - 1;
            return (
              <span key={path} className="flex min-w-0 shrink-0 items-center gap-0.5">
                <IconChevronRight size={12} className="shrink-0 text-slate-300" />
                <button
                  onClick={() => navigate(path)}
                  className={`truncate rounded px-1.5 py-0.5 hover:bg-slate-100 ${
                    last ? "font-semibold text-slate-800" : "text-slate-600"
                  }`}
                >
                  {seg}
                </button>
              </span>
            );
          })}
        </div>
        <button title="새로고침" className={toolBtn} onClick={() => ws.refresh()}>
          <IconRefresh size={13} />
        </button>
        <div className="mx-0.5 h-5 w-px bg-slate-200" />
        <button
          title="자세히 보기"
          className={`${toolBtn} ${view === "list" ? "bg-slate-200/80 text-slate-800" : ""}`}
          onClick={() => setView("list")}
        >
          <IconListView size={14} />
        </button>
        <button
          title="큰 아이콘 보기"
          className={`${toolBtn} ${view === "grid" ? "bg-slate-200/80 text-slate-800" : ""}`}
          onClick={() => setView("grid")}
        >
          <IconGridView size={14} />
        </button>
        <div className="mx-0.5 h-5 w-px bg-slate-200" />
        <button
          title="미리보기 패널"
          className={`${toolBtn} ${previewOn ? "bg-slate-200/80 text-slate-800" : ""}`}
          onClick={() => setPreviewOn((v) => !v)}
        >
          <IconView size={14} />
        </button>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* 사이드바 — 탐색 트리 */}
        <div className="thin-scroll w-48 shrink-0 overflow-y-auto border-r border-slate-200 bg-slate-50/60 py-2">
          <p className="px-3 pb-1 text-[10px] font-bold uppercase tracking-wider text-slate-400">탐색</p>
          <button
            onClick={() => navigate("")}
            className={`flex w-full items-center gap-2 px-3 py-1.5 text-[13px] ${
              cwd === "" ? "bg-sky-100/80 font-semibold text-sky-800" : "text-slate-600 hover:bg-slate-100"
            }`}
          >
            <IconMonitor size={14} className="shrink-0 text-sky-500" />
            워크스페이스
          </button>
          {dirs.map((d) => {
            const depth = d.split("/").length;
            return (
              <button
                key={d}
                onClick={() => navigate(d)}
                className={`flex w-full items-center gap-2 py-1.5 pr-2 text-[13px] ${
                  cwd === d ? "bg-sky-100/80 font-semibold text-sky-800" : "text-slate-600 hover:bg-slate-100"
                }`}
                style={{ paddingLeft: 12 + depth * 14 }}
              >
                <FolderGlyph size={15} />
                <span className="min-w-0 truncate">{d.split("/").pop()}</span>
              </button>
            );
          })}
        </div>

        {/* 메인 목록 — Del 키로 선택 항목 삭제 */}
        <div
          className="flex min-w-0 flex-1 flex-col outline-none"
          tabIndex={0}
          onClick={() => setSelected(null)}
          onKeyDown={(e) => {
            if (e.key === "Delete" && selectedEntry && !selectedEntry.isDir && !readOnly) {
              remove(selectedEntry.path);
            }
            if (e.key === "Enter" && selectedEntry) activate(selectedEntry);
            if (e.key === "Backspace") goUp();
          }}
        >
          {view === "list" ? (
            <div className="thin-scroll min-h-0 flex-1 overflow-y-auto">
              <table className="w-full border-collapse text-[13px]">
                <thead className="sticky top-0 bg-white">
                  <tr className="text-left text-xs text-slate-400">
                    <th className="border-b border-slate-200 px-3 py-1.5 font-medium">이름</th>
                    <th className="w-36 border-b border-slate-200 px-3 py-1.5 font-medium">수정한 날짜</th>
                    <th className="w-32 border-b border-slate-200 px-3 py-1.5 font-medium">유형</th>
                    <th className="w-20 border-b border-slate-200 px-3 py-1.5 text-right font-medium">크기</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((e) => (
                    <tr
                      key={e.path}
                      onClick={(ev) => {
                        ev.stopPropagation();
                        handleSelect(e);
                      }}
                      className={`cursor-default select-none ${
                        selected === e.path ? "bg-sky-100/80" : "hover:bg-slate-50"
                      }`}
                    >
                      <td className="px-3 py-1.5">
                        <span className="flex items-center gap-2">
                          {e.isDir ? <FolderGlyph size={17} /> : <FileGlyph path={e.path} size={14} />}
                          <span className="min-w-0 truncate text-slate-700">{e.name}</span>
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-3 py-1.5 text-slate-400">{fmtDateTime(e.updated_at)}</td>
                      <td className="whitespace-nowrap px-3 py-1.5 text-slate-400">
                        {e.isDir ? "파일 폴더" : typeLabel(e.path)}
                      </td>
                      <td className="whitespace-nowrap px-3 py-1.5 text-right text-slate-400">
                        {e.isDir ? "—" : fmtBytes(e.size)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {entries.length === 0 && (
                <p className="p-6 text-center text-xs text-slate-400">이 폴더는 비어 있습니다</p>
              )}
            </div>
          ) : (
            <div className="thin-scroll min-h-0 flex-1 overflow-y-auto p-3">
              <div className="grid grid-cols-[repeat(auto-fill,minmax(96px,1fr))] gap-1">
                {entries.map((e) => (
                  <button
                    key={e.path}
                    onClick={(ev) => {
                      ev.stopPropagation();
                      handleSelect(e);
                    }}
                    className={`flex flex-col items-center gap-1.5 rounded-lg border px-1 pb-2 pt-3 ${
                      selected === e.path
                        ? "border-sky-200 bg-sky-100/80"
                        : "border-transparent hover:bg-slate-50"
                    }`}
                  >
                    {e.isDir ? <FolderGlyph size={40} /> : <FileGlyph path={e.path} size={34} />}
                    <span className="max-w-full truncate text-center text-[11px] leading-tight text-slate-700">
                      {e.name}
                    </span>
                  </button>
                ))}
              </div>
              {entries.length === 0 && (
                <p className="p-6 text-center text-xs text-slate-400">이 폴더는 비어 있습니다</p>
              )}
            </div>
          )}

          {/* 상태 표시줄 */}
          <div className="flex h-7 shrink-0 items-center gap-3 border-t border-slate-200 bg-slate-50/70 px-3 text-[11px] text-slate-400">
            <span>{entries.length}개 항목</span>
            {selectedEntry && (
              <span className="min-w-0 truncate">
                선택: {selectedEntry.name}
                {!selectedEntry.isDir && ` (${fmtBytes(selectedEntry.size)})`}
                {selectedEntry.isDir && ` — 항목 ${selectedEntry.childCount}개`}
              </span>
            )}
          </div>
        </div>

        {/* 미리보기 패널 (토글) */}
        {previewOn && !previewFile && (
          <div className="flex w-[46%] min-w-[280px] shrink-0 items-center justify-center border-l border-slate-200 text-xs text-slate-400">
            파일을 선택하면 미리보기가 표시됩니다
          </div>
        )}
        {previewFile && (
          <div className="flex w-[46%] min-w-[280px] shrink-0 flex-col border-l border-slate-200">
            <div className="flex items-center justify-between gap-2 border-b border-slate-200 bg-slate-50/70 px-3 py-1.5">
              <span className="flex min-w-0 items-center gap-1.5">
                <FileGlyph path={previewFile.path} size={13} />
                <span className="min-w-0 truncate font-mono text-xs text-slate-600">{previewFile.name}</span>
              </span>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  title="IDE에서 열기"
                  onClick={() => ws.requestOpenInIde(previewFile.path)}
                  className="flex h-7 items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 text-xs text-slate-600 hover:bg-slate-50"
                >
                  <IconIde size={12} /> IDE
                </button>
                {!readOnly && (
                  <button
                    title="삭제"
                    onClick={() => remove(previewFile.path)}
                    className="flex h-7 w-7 items-center justify-center rounded-lg text-slate-400 hover:bg-red-50 hover:text-red-500"
                  >
                    <IconDelete size={13} />
                  </button>
                )}
                <button
                  title="미리보기 닫기"
                  onClick={() => setPreviewOn(false)}
                  className="flex h-7 w-7 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-200/70 hover:text-slate-600"
                >
                  <IconClose size={14} />
                </button>
              </div>
            </div>
            <div className="min-h-0 flex-1">
              {content === null ? (
                <p className="p-4 text-xs text-slate-400">불러오는 중...</p>
              ) : (
                <FilePreview path={previewFile.path} content={content} />
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

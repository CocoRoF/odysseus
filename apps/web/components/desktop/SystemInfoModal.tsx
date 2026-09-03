"use client";

import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import type { RuntimeEntry, SystemInfo } from "@/lib/types";
import { Spinner } from "@/components/ui";
import { IconClose, IconLock, IconMonitor } from "@/components/icons";

/**
 * 이 컴퓨터에 관하여 — 응시자가 자기 작업 공간을 확인하는 창.
 *
 * 서버 사양이 아니라 **내게 주어진 것**만 보여준다: 쓸 수 있는 자원, 설치된
 * 언어와 도구, 그리고 이 공간이 어떻게 격리되어 있는지. 설치 목록을 화면에
 * 적어 두면 이미지와 어긋나므로, 러너가 스스로 조사한 값만 쓴다.
 */

const TABS = [
  { key: "overview", label: "개요" },
  { key: "runtimes", label: "언어 · 도구" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50/70 px-3 py-2.5 text-center">
      <p className="text-[10.5px] font-semibold uppercase tracking-wider text-slate-400">{label}</p>
      <p className="mt-1 text-[17px] font-bold leading-tight text-slate-800">{value}</p>
      <p className="mt-0.5 text-[10.5px] text-slate-400">{sub}</p>
    </div>
  );
}

function RuntimeGrid({ title, entries }: { title: string; entries: RuntimeEntry[] }) {
  if (entries.length === 0) return null;
  return (
    <div className="mb-4">
      <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-400">{title}</p>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1">
        {entries.map((e) => (
          <div
            key={e.command}
            className="flex items-baseline justify-between gap-2 rounded-md border border-slate-200 bg-slate-50/70 px-2.5 py-1.5"
          >
            <span className="min-w-0 truncate text-[12.5px] font-medium text-slate-700">{e.name}</span>
            <span className="shrink-0 font-mono text-[11.5px] text-slate-500">{e.version}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function SystemInfoModal({
  open,
  onClose,
  userName,
}: {
  open: boolean;
  onClose: () => void;
  userName: string;
}) {
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<TabKey>("overview");

  useEffect(() => {
    if (!open || info) return;
    api
      .get<SystemInfo>("/reference/system")
      .then(setInfo)
      .catch((e) => setError(e instanceof ApiError ? e.message : "정보를 불러올 수 없습니다"));
  }, [open, info]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const limits = info?.limits;

  return (
    <div
      className="fixed inset-0 z-[9500] flex items-center justify-center bg-slate-950/50 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="window-in window-shadow w-[520px] max-w-[92vw] overflow-hidden rounded-2xl border border-slate-300/60 bg-white"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex h-10 items-center border-b border-slate-200 bg-slate-100 px-3">
          <span className="flex-1 text-center text-[12.5px] font-semibold text-slate-600">
            이 컴퓨터에 관하여
          </span>
          <button
            onClick={onClose}
            title="닫기"
            className="flex h-7 w-7 items-center justify-center rounded-lg text-slate-400 transition hover:bg-slate-200 hover:text-slate-700"
          >
            <IconClose size={15} />
          </button>
        </div>

        <div className="flex items-center gap-5 px-7 pb-5 pt-6">
          <span className="flex h-[70px] w-[70px] shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-slate-600 via-slate-700 to-slate-900 text-white shadow-lg">
            <IconMonitor size={34} />
          </span>
          <div className="min-w-0">
            <h2 className="truncate text-[19px] font-bold text-slate-900">
              {userName ? `${userName}의 컴퓨터` : "내 컴퓨터"}
            </h2>
            <p className="mt-1 text-[12px] text-slate-400">
              Odysseus Workstation{info?.os ? ` · ${info.os}` : ""}
            </p>
          </div>
        </div>

        <div className="flex gap-1 border-b border-slate-200 px-6">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`-mb-px border-b-2 px-3 py-2 text-[12.5px] font-medium transition ${
                tab === t.key
                  ? "border-sky-500 text-slate-900"
                  : "border-transparent text-slate-400 hover:text-slate-600"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="thin-scroll max-h-[46vh] min-h-[210px] overflow-y-auto px-7 py-5">
          {error ? (
            <p className="py-10 text-center text-sm text-slate-500">{error}</p>
          ) : !info || !limits ? (
            <div className="flex justify-center py-12">
              <Spinner />
            </div>
          ) : tab === "overview" ? (
            <div className="space-y-4">
              <div className="grid grid-cols-3 gap-2.5">
                <Stat label="메모리" value={`${(limits.memory_mb / 1024).toFixed(0)} GB`} sub="실행당 상한" />
                <Stat
                  label="실행 시간"
                  value={`${limits.max_timeout_s}초`}
                  sub={`기본 ${limits.timeout_s}초`}
                />
                <Stat
                  label="파일"
                  value={`${Math.round(limits.max_file_bytes / 1024)} KB`}
                  sub={`실행당 ${limits.max_changed_files}개`}
                />
              </div>

              <div className="rounded-xl border border-slate-200 bg-slate-50 p-3.5">
                <p className="flex items-center gap-1.5 text-[12px] font-semibold text-slate-700">
                  <IconLock size={12} className="text-emerald-600" />
                  {info.isolated ? "격리된 작업 공간" : "공유 작업 공간"}
                </p>
                <p className="mt-1.5 text-[11.5px] leading-relaxed text-slate-500">
                  {info.isolated
                    ? "명령은 실행할 때마다 자기만의 프로세스·파일 공간에서 돌아갑니다. 다른 응시자의 작업은 보이지 않고, 시험이 끝나면 흔적 없이 사라집니다."
                    : "이 환경은 격리 모드로 동작하지 않습니다."}
                </p>
              </div>

              <div className="rounded-xl border border-slate-200 p-3.5">
                <p className="text-[12px] font-semibold text-slate-700">네트워크</p>
                <p className="mt-1.5 text-[11.5px] leading-relaxed text-slate-500">
                  {limits.network ? (
                    "외부 네트워크를 사용할 수 있습니다."
                  ) : (
                    <>
                      작업 공간에서는 인터넷에 직접 연결할 수 없습니다. 외부 자료는{" "}
                      <b className="text-slate-600">GitHub</b>·<b className="text-slate-600">인터넷</b> 앱으로
                      찾아보고, 저장소는{" "}
                      <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[11px]">git clone</code> 으로
                      가져올 수 있습니다.
                    </>
                  )}
                </p>
              </div>
            </div>
          ) : (
            <>
              <RuntimeGrid title="언어" entries={info.languages} />
              <RuntimeGrid title="셸" entries={info.shells} />
              <RuntimeGrid title="도구" entries={info.tools} />
              {info.python_packages.length > 0 && (
                <div>
                  <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                    Python 패키지
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {info.python_packages.map((p) => (
                      <span
                        key={p.name}
                        className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11.5px] text-slate-600"
                      >
                        {p.name} <span className="font-mono text-slate-400">{p.version}</span>
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

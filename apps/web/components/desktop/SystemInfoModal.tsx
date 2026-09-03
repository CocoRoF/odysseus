"use client";

import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import type { RuntimeEntry, SystemInfo } from "@/lib/types";
import { Spinner } from "@/components/ui";
import { IconClose, IconLock, IconMonitor } from "@/components/icons";

/**
 * 이 컴퓨터에 관하여 — 응시자가 자기 실행 환경을 확인하는 창.
 *
 * 설치 목록을 화면에 적어 두면 이미지와 어긋난다. 러너가 뜰 때 스스로 조사한
 * 값만 보여주므로, 툴체인이 바뀌면 이 화면도 따라 바뀐다.
 */

const TABS = [
  { key: "overview", label: "개요" },
  { key: "runtimes", label: "언어 · 도구" },
  { key: "limits", label: "실행 정책" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-4 py-[5px]">
      <span className="w-28 shrink-0 text-right text-[12px] text-slate-500">{label}</span>
      <span className="min-w-0 flex-1 text-[12.5px] font-medium text-slate-800">{value}</span>
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
  assessmentTitle,
}: {
  open: boolean;
  onClose: () => void;
  userName: string;
  assessmentTitle: string;
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

  const machineName = userName ? `${userName}의 컴퓨터` : "내 컴퓨터";

  return (
    <div
      className="fixed inset-0 z-[9500] flex items-center justify-center bg-slate-950/50 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="window-in window-shadow w-[560px] max-w-[92vw] overflow-hidden rounded-2xl border border-slate-300/60 bg-white"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 타이틀바 — 창 장식만, 이동은 하지 않는다 */}
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

        {/* 머리 — 기기 정체성 */}
        <div className="flex items-center gap-5 px-7 pb-5 pt-6">
          <span className="flex h-20 w-20 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-slate-600 via-slate-700 to-slate-900 text-white shadow-lg">
            <IconMonitor size={40} />
          </span>
          <div className="min-w-0">
            <h2 className="truncate text-[19px] font-bold text-slate-900">{machineName}</h2>
            <p className="mt-0.5 truncate text-[12.5px] text-slate-500">{assessmentTitle}</p>
            <p className="mt-1.5 text-[11.5px] text-slate-400">
              Odysseus Workstation{info ? ` · ${info.os}` : ""}
            </p>
          </div>
        </div>

        {/* 탭 */}
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

        <div className="thin-scroll max-h-[46vh] min-h-[220px] overflow-y-auto px-7 py-5">
          {error ? (
            <p className="py-10 text-center text-sm text-slate-500">{error}</p>
          ) : !info ? (
            <div className="flex justify-center py-12">
              <Spinner />
            </div>
          ) : tab === "overview" ? (
            <div className="-ml-2">
              <Row label="운영체제" value={info.os} />
              <Row label="커널" value={<span className="font-mono text-[12px]">{info.kernel}</span>} />
              <Row label="아키텍처" value={<span className="font-mono text-[12px]">{info.arch}</span>} />
              <Row label="프로세서" value={info.cpu_count ? `${info.cpu_count} 코어` : "—"} />
              <Row
                label="메모리"
                value={
                  info.memory_total_mb
                    ? `${(info.memory_total_mb / 1024).toFixed(1)} GB (실행당 최대 ${(info.limits.memory_mb / 1024).toFixed(0)} GB)`
                    : "—"
                }
              />
              <Row label="셸" value={info.shells.map((s) => `${s.name} ${s.version}`).join(", ") || "—"} />
              <Row
                label="언어"
                value={info.languages.map((l) => `${l.name} ${l.version.split("-")[0]}`).join(" · ")}
              />
            </div>
          ) : tab === "runtimes" ? (
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
          ) : (
            <div className="space-y-3">
              <div className="-ml-2">
                <Row label="실행 시간" value={`기본 ${info.limits.timeout_s}초 · 최대 ${info.limits.max_timeout_s}초`} />
                <Row label="메모리" value={`${(info.limits.memory_mb / 1024).toFixed(0)} GB`} />
                <Row
                  label="파일"
                  value={`한 파일 ${Math.round(info.limits.max_file_bytes / 1024)} KB · 실행당 ${info.limits.max_changed_files}개까지 반영`}
                />
                <Row
                  label="네트워크"
                  value={
                    info.limits.network ? (
                      "사용 가능"
                    ) : (
                      <span className="text-slate-600">
                        차단됨 — 외부 자료는 <b>GitHub</b>·<b>인터넷</b> 앱으로 조회합니다
                      </span>
                    )
                  }
                />
              </div>
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-3.5">
                <p className="flex items-center gap-1.5 text-[12px] font-semibold text-slate-700">
                  <IconLock size={12} className="text-emerald-600" />
                  {info.isolated ? "격리된 실행 환경" : "공유 실행 환경"}
                </p>
                <p className="mt-1.5 text-[11.5px] leading-relaxed text-slate-500">
                  {info.isolated
                    ? "명령은 실행할 때마다 자기만의 프로세스·파일시스템 공간에서 돌아갑니다. 다른 응시자의 작업은 보이지 않고, 시험이 끝나면 흔적 없이 사라집니다."
                    : "이 환경은 격리 모드로 동작하지 않습니다."}
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

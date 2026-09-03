"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "@/lib/api";
import type { AdminResourceRow, AdminResources, AdminSessionRow } from "@/lib/types";
import { useUser } from "@/components/useUser";
import { Shell } from "@/components/Shell";
import { Button, Card, EmptyState, Spinner } from "@/components/ui";
import { useToast } from "@/components/toast";
import { fmtDateTime } from "@/lib/format";
import { IconRefresh, IconWarn } from "@/components/icons";

/**
 * 자원 관리 — 지금 무엇이 돌고 있고, 무엇이 자원만 붙들고 있는가.
 *
 * 러너가 1초마다 올리는 스냅샷을 읽는다. 러너가 죽으면 스냅샷이 만료되므로
 * "오프라인"을 그대로 보여준다 — 0으로 채워 정상인 척하지 않는다.
 */

const POLL_MS = 2000;
const HISTORY = 90;

function mb(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

function duration(seconds: number | null): string {
  if (seconds === null) return "—";
  if (seconds < 60) return `${seconds}초`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}분`;
  return `${Math.floor(seconds / 3600)}시간 ${Math.floor((seconds % 3600) / 60)}분`;
}

/** 시간에 따른 자원 추이 — 값 하나로는 추세를 알 수 없다 */
function Chart({ values, max, color, label, current }: {
  values: number[];
  max: number;
  color: string;
  label: string;
  current: string;
}) {
  const w = 100;
  const h = 40;
  const pts = values.map((v, i) => {
    const x = values.length <= 1 ? w : (i / (values.length - 1)) * w;
    const y = h - Math.min(1, max > 0 ? v / max : 0) * h;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">{label}</span>
        <span className="font-mono text-sm font-semibold text-slate-700">{current}</span>
      </div>
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="mt-1.5 h-11 w-full">
        {pts.length > 1 && (
          <>
            <polyline
              points={`0,${h} ${pts.join(" ")} ${w},${h}`}
              fill={color}
              fillOpacity={0.14}
              stroke="none"
            />
            <polyline
              points={pts.join(" ")}
              fill="none"
              stroke={color}
              strokeWidth={1.4}
              vectorEffect="non-scaling-stroke"
            />
          </>
        )}
      </svg>
    </div>
  );
}

export default function ResourcesPage() {
  const { user, loading } = useUser(["admin"]);
  const { toast, confirm } = useToast();
  const [data, setData] = useState<AdminResources | null>(null);
  const [busy, setBusy] = useState(false);
  const cpuHist = useRef<number[]>([]);
  const memHist = useRef<number[]>([]);
  const [, force] = useState(0);

  const load = useCallback(async () => {
    try {
      const d = await api.get<AdminResources>("/admin/resources");
      setData(d);
      cpuHist.current = [...cpuHist.current, d.container.cpu_percent].slice(-HISTORY);
      memHist.current = [...memHist.current, d.container.memory_bytes].slice(-HISTORY);
      force((n) => n + 1);
    } catch {
      /* 다음 주기에 회복 */
    }
  }, []);

  useEffect(() => {
    if (!user) return;
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [user, load]);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast(ok, "success");
      await load();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "요청에 실패했습니다", "error");
    } finally {
      setBusy(false);
    }
  };

  const killExecution = async (row: AdminResourceRow) => {
    const ok = await confirm({
      title: "실행 강제 종료",
      message: (
        <>
          실행 중인 명령을 즉시 끊습니다.
          <br />
          <code className="mt-1 inline-block rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs">
            {row.command || "(명령 없음)"}
          </code>
        </>
      ),
      confirmLabel: "종료",
      danger: true,
    });
    if (!ok) return;
    await act(
      () => api.post(`/admin/resources/executions/${row.execution_id}/kill`),
      "실행을 종료했습니다",
    );
  };

  const terminateSession = async (s: AdminSessionRow) => {
    const ok = await confirm({
      title: "응시 세션 종료",
      message: (
        <>
          <b>{s.user_name}</b> 님의 응시를 종료합니다. 진행 중인 실행도 함께 끊기며, 응시자는 더 이상
          작업할 수 없습니다.
        </>
      ),
      confirmLabel: "세션 종료",
      danger: true,
    });
    if (!ok) return;
    await act(
      () => api.post(`/admin/resources/attempts/${s.attempt_id}/terminate`),
      "세션을 종료했습니다",
    );
  };

  const cleanup = async () => {
    const ok = await confirm({
      title: "고아 자원 정리",
      message: "마감이 지난 응시를 닫고, 러너에서 사라진 실행을 정리합니다.",
      confirmLabel: "정리 실행",
    });
    if (!ok) return;
    setBusy(true);
    try {
      const r = await api.post<{ closed_attempts: number; freed_executions: number }>(
        "/admin/resources/cleanup",
      );
      toast(`세션 ${r.closed_attempts}건, 실행 ${r.freed_executions}건을 정리했습니다`, "success");
      await load();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "정리에 실패했습니다", "error");
    } finally {
      setBusy(false);
    }
  };

  if (loading || !user) return null;

  const c = data?.container;
  const memLimit = c?.memory_limit_bytes ?? 0;
  const cpuCap = (c?.cpu_count ?? 1) * 100;
  const orphans = (data?.sessions ?? []).filter((s) => s.orphan);

  return (
    <Shell user={user}>
      <div className="mx-auto max-w-6xl px-6 py-8">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold">자원 관리</h1>
            <p className="mt-1 text-sm text-slate-500">
              실행 러너의 자원 사용과 응시 세션을 지켜보고, 필요하면 끊습니다.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span
              className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${
                data?.online ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-600"
              }`}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${data?.online ? "animate-pulse bg-emerald-500" : "bg-red-500"}`}
              />
              러너 {data?.online ? "정상" : "응답 없음"}
            </span>
            <Button variant="secondary" onClick={load} disabled={busy}>
              <IconRefresh size={13} /> 새로고침
            </Button>
          </div>
        </div>

        {!data ? (
          <div className="flex justify-center py-24">
            <Spinner />
          </div>
        ) : (
          <>
            {/* 러너 개요 */}
            <div className="mt-6 grid gap-4 md:grid-cols-4">
              <Card className="p-5 md:col-span-2">
                <Chart
                  label="CPU"
                  values={cpuHist.current}
                  max={cpuCap}
                  color="#0ea5e9"
                  current={`${c?.cpu_percent.toFixed(1) ?? 0}% / ${cpuCap}%`}
                />
              </Card>
              <Card className="p-5 md:col-span-2">
                <Chart
                  label="메모리"
                  values={memHist.current}
                  max={memLimit}
                  color="#10b981"
                  current={`${mb(c?.memory_bytes ?? 0)} / ${mb(memLimit)}`}
                />
              </Card>
            </div>

            <div className="mt-4 grid gap-4 sm:grid-cols-4">
              {[
                ["실행 중", `${data.active.length}`, `동시 ${data.concurrency ?? "—"}`],
                ["대기 큐", `${data.queue_depth}`, "처리 대기"],
                ["진행 중 세션", `${data.sessions.length}`, "응시 중"],
                ["정리 대상", `${orphans.length + data.stuck_executions.length}`, "고아 세션·실행"],
              ].map(([label, value, sub]) => (
                <Card key={label} className="p-4">
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">{label}</p>
                  <p className="mt-1 text-2xl font-bold text-slate-800">{value}</p>
                  <p className="text-[11px] text-slate-400">{sub}</p>
                </Card>
              ))}
            </div>

            {/* 실행 중 */}
            <Card className="mt-6 p-5">
              <h2 className="font-bold">실행 중인 명령</h2>
              {data.active.length === 0 ? (
                <p className="py-8 text-center text-sm text-slate-400">실행 중인 명령이 없습니다.</p>
              ) : (
                <div className="mt-3 overflow-x-auto">
                  <table className="w-full text-sm [&_td]:px-2 [&_th]:px-2 [&_td:first-child]:pl-0 [&_th:first-child]:pl-0 [&_td:last-child]:pr-0 [&_th:last-child]:pr-0">
                    <thead>
                      <tr className="border-b border-slate-200 text-left text-[11px] uppercase tracking-wide text-slate-400">
                        <th className="pb-2 font-semibold">명령</th>
                        <th className="pb-2 font-semibold">출처</th>
                        <th className="pb-2 text-right font-semibold">CPU</th>
                        <th className="pb-2 text-right font-semibold">메모리</th>
                        <th className="pb-2 text-right font-semibold">프로세스</th>
                        <th className="pb-2 text-right font-semibold">경과</th>
                        <th className="pb-2" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {data.active.map((row) => (
                        <tr key={row.execution_id}>
                          <td className="max-w-md py-2">
                            <code className="block truncate font-mono text-xs text-slate-600">
                              {row.command || "—"}
                            </code>
                          </td>
                          <td className="py-2 text-xs text-slate-500">{row.source ?? "—"}</td>
                          <td className="py-2 text-right font-mono text-xs">{row.cpu_percent}%</td>
                          <td className="py-2 text-right font-mono text-xs">{mb(row.memory_bytes)}</td>
                          <td className="py-2 text-right font-mono text-xs text-slate-500">{row.processes}</td>
                          <td className="py-2 text-right font-mono text-xs text-slate-500">
                            {row.elapsed_s}s
                          </td>
                          <td className="py-2 text-right">
                            <Button variant="ghost" onClick={() => killExecution(row)} disabled={busy}>
                              종료
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>

            {/* 세션 */}
            <Card className="mt-6 p-5">
              <div className="flex items-center justify-between gap-3">
                <h2 className="font-bold">진행 중인 응시 세션</h2>
                {(orphans.length > 0 || data.stuck_executions.length > 0) && (
                  <Button variant="secondary" onClick={cleanup} disabled={busy}>
                    <IconWarn size={13} /> 고아 정리 ({orphans.length + data.stuck_executions.length})
                  </Button>
                )}
              </div>
              {data.sessions.length === 0 ? (
                <EmptyState message="진행 중인 응시가 없습니다." />
              ) : (
                <div className="mt-3 overflow-x-auto">
                  <table className="w-full text-sm [&_td]:px-2 [&_th]:px-2 [&_td:first-child]:pl-0 [&_th:first-child]:pl-0 [&_td:last-child]:pr-0 [&_th:last-child]:pr-0">
                    <thead>
                      <tr className="border-b border-slate-200 text-left text-[11px] uppercase tracking-wide text-slate-400">
                        <th className="pb-2 font-semibold">응시자</th>
                        <th className="pb-2 font-semibold">시험</th>
                        <th className="pb-2 text-right font-semibold">파일</th>
                        <th className="pb-2 text-right font-semibold">실행</th>
                        <th className="whitespace-nowrap pb-2 text-right font-semibold">마지막 활동</th>
                        <th className="whitespace-nowrap pb-2 font-semibold">마감</th>
                        <th className="pb-2" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {data.sessions.map((s) => (
                        <tr key={s.attempt_id} className={s.orphan ? "bg-amber-50/60" : ""}>
                          <td className="py-2">
                            <span className="font-medium text-slate-700">{s.user_name}</span>
                            {s.orphan && (
                              <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-700">
                                {s.expired ? "마감 초과" : "방치됨"}
                              </span>
                            )}
                            <span className="block text-[11px] text-slate-400">{s.user_email}</span>
                          </td>
                          <td className="max-w-[220px] truncate py-2 text-xs text-slate-500">
                            {s.assessment_title}
                          </td>
                          <td className="py-2 text-right font-mono text-xs text-slate-500">
                            {s.workspace_files}
                          </td>
                          <td className="py-2 text-right font-mono text-xs text-slate-500">{s.running}</td>
                          <td className="whitespace-nowrap py-2 text-right text-xs text-slate-500">
                            {duration(s.idle_seconds)} 전
                          </td>
                          <td className="whitespace-nowrap py-2 text-xs text-slate-500">
                            {s.deadline_at ? fmtDateTime(s.deadline_at) : "—"}
                          </td>
                          <td className="py-2 text-right">
                            <Button variant="ghost" onClick={() => terminateSession(s)} disabled={busy}>
                              세션 종료
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>

            {/* 유실된 실행 */}
            {data.stuck_executions.length > 0 && (
              <Card className="mt-6 p-5">
                <h2 className="font-bold">러너에서 사라진 실행</h2>
                <p className="mt-1 text-sm text-slate-500">
                  기록상 진행 중이지만 러너가 모르는 실행입니다 — 러너 재시작 등으로 유실된 것으로,
                  정리하면 종료 상태로 확정됩니다.
                </p>
                <ul className="mt-3 divide-y divide-slate-100 text-sm">
                  {data.stuck_executions.map((e) => (
                    <li key={e.execution_id} className="flex items-center gap-3 py-2">
                      <code className="min-w-0 flex-1 truncate font-mono text-xs text-slate-600">
                        {e.command || "—"}
                      </code>
                      <span className="shrink-0 text-xs text-slate-400">{e.status}</span>
                      <span className="shrink-0 text-xs text-slate-400">
                        {duration(e.age_seconds)} 전
                      </span>
                    </li>
                  ))}
                </ul>
              </Card>
            )}
          </>
        )}
      </div>
    </Shell>
  );
}

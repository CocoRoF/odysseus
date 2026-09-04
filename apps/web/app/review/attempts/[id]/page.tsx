"use client";

import { use, useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError } from "@/lib/api";
import type {
  AgentMessage,
  EvalProviderRef,
  EvalScenarioResult,
  Evaluation,
  Execution,
  ReviewAttempt,
  ReviewEvent,
} from "@/lib/types";
import { AWAY_EVENT_TYPES, EVENT_LABEL, fmtDateTime, fmtOffset, STATUS_LABEL } from "@/lib/format";
import { useUser } from "@/components/useUser";
import { Shell } from "@/components/Shell";
import { Markdown } from "@/components/Markdown";
import { useToast } from "@/components/toast";
import { Badge, Button, Card, EmptyState, Field, inputCls, Spinner } from "@/components/ui";
import { WorkspaceProvider } from "@/components/desktop/workspace";
import { MessengerApp } from "@/components/desktop/apps/MessengerApp";
import { FilesApp } from "@/components/desktop/apps/FilesApp";

const TABS = [
  { key: "overview", label: "개요 · 평가" },
  { key: "messenger", label: "메신저 대화" },
  { key: "workspace", label: "워크스페이스" },
  { key: "agent", label: "에이전트 사용" },
  { key: "runs", label: "실행 이력" },
  { key: "timeline", label: "타임라인" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

function ScoreBar({ pct }: { pct: number }) {
  const tone = pct >= 70 ? "bg-emerald-500" : pct >= 40 ? "bg-amber-500" : "bg-red-500";
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100">
      <div className={`h-full rounded-full ${tone}`} style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
    </div>
  );
}

function AutoEvalView({ ev }: { ev: Evaluation }) {
  const scores = ev.scores as {
    overall_score?: number;
    scenarios?: EvalScenarioResult[];
    evaluated_by?: { model?: string; name?: string };
  };
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4">
        <div>
          <p className="text-3xl font-black">
            {scores.overall_score ?? "?"}
            <span className="text-base font-medium text-slate-400"> / 100</span>
          </p>
          <p className="text-xs text-slate-400">
            자동평가 · {scores.evaluated_by?.name} ({scores.evaluated_by?.model}) · {fmtDateTime(ev.created_at)}
          </p>
        </div>
      </div>
      {(scores.scenarios ?? []).map((s) => (
        <Card key={s.scenario_id} className="space-y-4 p-5">
          <div className="flex items-center justify-between gap-3">
            <h3 className="font-bold">{s.title}</h3>
            <span className="shrink-0 text-sm font-bold text-slate-700">
              {s.earned_points} / {s.points}점 ({s.score_pct}%)
            </span>
          </div>
          <ScoreBar pct={s.score_pct} />

          {s.checks.length > 0 && (
            <div>
              <p className="mb-1.5 text-xs font-bold uppercase tracking-wide text-slate-400">자동 체크 ({s.checks_earned}/{s.checks_total}점)</p>
              <div className="space-y-1">
                {s.checks.map((c, i) => (
                  <div key={i} className="flex items-center gap-2 text-sm">
                    <span className={c.passed ? "text-emerald-500" : "text-red-500"}>{c.passed ? "✓" : "✗"}</span>
                    <span className="font-medium">{c.label}</span>
                    <span className="text-xs text-slate-400">{c.detail}</span>
                    <span className="ml-auto shrink-0 text-xs text-slate-500">{c.earned}/{c.points}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {(["process", "result"] as const).map((sec) => (
              <div key={sec}>
                <p className="mb-1.5 text-xs font-bold uppercase tracking-wide text-slate-400">
                  {sec === "process" ? "과정 평가" : "결과 평가"}
                </p>
                <div className="space-y-2">
                  {(s[sec] ?? []).map((it, i) => (
                    <div key={i}>
                      <div className="flex items-center justify-between text-sm">
                        <span className="font-medium">{it.name}</span>
                        <span className="text-slate-500">
                          {it.score}/{it.max}
                        </span>
                      </div>
                      {it.comment && <p className="text-xs text-slate-400">{it.comment}</p>}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>

          {s.requirement_discovery && (
            <div className="rounded-xl bg-sky-50 p-3 text-sm text-sky-900">
              <p className="mb-1 text-xs font-bold uppercase tracking-wide text-sky-500">요구사항 파악</p>
              {s.requirement_discovery}
            </div>
          )}
          {s.summary && <p className="text-sm text-slate-600">{s.summary}</p>}
          <div className="flex flex-wrap gap-4 text-xs">
            {s.strengths?.length > 0 && (
              <div className="min-w-40 flex-1">
                <p className="font-bold text-emerald-600">강점</p>
                <ul className="mt-1 list-inside list-disc text-slate-500">
                  {s.strengths.map((x, i) => (
                    <li key={i}>{x}</li>
                  ))}
                </ul>
              </div>
            )}
            {s.concerns?.length > 0 && (
              <div className="min-w-40 flex-1">
                <p className="font-bold text-amber-600">우려/개선</p>
                <ul className="mt-1 list-inside list-disc text-slate-500">
                  {s.concerns.map((x, i) => (
                    <li key={i}>{x}</li>
                  ))}
                </ul>
              </div>
            )}
            {s.integrity_flags?.length > 0 && (
              <div className="min-w-40 flex-1">
                <p className="font-bold text-red-600">무결성 신호</p>
                <ul className="mt-1 list-inside list-disc text-slate-500">
                  {s.integrity_flags.map((x, i) => (
                    <li key={i}>{x}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </Card>
      ))}
    </div>
  );
}

export default function ReviewAttemptPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { user, loading } = useUser(["admin", "evaluator"]);
  const { toast } = useToast();

  const [detail, setDetail] = useState<ReviewAttempt | null>(null);
  const [events, setEvents] = useState<ReviewEvent[] | null>(null);
  const [agentMsgs, setAgentMsgs] = useState<AgentMessage[] | null>(null);
  const [executions, setExecutions] = useState<Execution[] | null>(null);
  const [providers, setProviders] = useState<EvalProviderRef[]>([]);
  const [evalProviderId, setEvalProviderId] = useState("");
  const [tab, setTab] = useState<TabKey>("overview");
  const [scenarioId, setScenarioId] = useState<string | null>(null);
  const [evaluating, setEvaluating] = useState(false);
  const [humanScore, setHumanScore] = useState("");
  const [humanSummary, setHumanSummary] = useState("");
  const [timelineFilter, setTimelineFilter] = useState<string>("all");

  const load = useCallback(async () => {
    const d = await api.get<ReviewAttempt>(`/review/attempts/${id}`);
    setDetail(d);
    setScenarioId((s) => s ?? d.scenarios[0]?.scenario_id ?? null);
  }, [id]);

  useEffect(() => {
    if (!user) return;
    load();
    api.get<ReviewEvent[]>(`/review/attempts/${id}/events`).then(setEvents);
    api.get<EvalProviderRef[]>("/review/ai-providers").then((rows) => {
      setProviders(rows);
      const d = rows.find((r) => r.is_eval_default);
      if (d) setEvalProviderId(d.id);
    });
  }, [user, id, load]);

  useEffect(() => {
    if (!user || !scenarioId) return;
    api.get<AgentMessage[]>(`/attempts/${id}/scenarios/${scenarioId}/agent/messages`).then(setAgentMsgs);
    api.get<Execution[]>(`/attempts/${id}/scenarios/${scenarioId}/executions`).then(setExecutions);
  }, [user, id, scenarioId]);

  const scenario = useMemo(
    () => detail?.scenarios.find((s) => s.scenario_id === scenarioId) ?? null,
    [detail, scenarioId],
  );

  const runAutoEval = async () => {
    setEvaluating(true);
    try {
      await api.post(`/review/attempts/${id}/autoeval`, { provider_id: evalProviderId || null });
      await load();
      toast("자동평가가 완료되었습니다", "success");
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "자동평가 실패", "error");
    } finally {
      setEvaluating(false);
    }
  };

  const saveHumanEval = async () => {
    try {
      await api.post(`/review/attempts/${id}/evaluate`, {
        scores: { overall_score: humanScore ? Number(humanScore) : null },
        summary: humanSummary,
      });
      setHumanScore("");
      setHumanSummary("");
      await load();
      toast("평가가 저장되었습니다", "success");
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "저장 실패", "error");
    }
  };

  const filteredEvents = useMemo(() => {
    if (!events) return [];
    if (timelineFilter === "all") return events;
    if (timelineFilter === "away") return events.filter((e) => AWAY_EVENT_TYPES.includes(e.type) || e.type.endsWith("_visible") || e.type.endsWith("_focus"));
    if (timelineFilter === "files") return events.filter((e) => e.type.startsWith("file_") || e.type.startsWith("run_"));
    if (timelineFilter === "chat") return events.filter((e) => e.type.startsWith("msg_") || e.type === "agent_turn");
    // 무엇을 찾아봤는지는 그 자체로 평가 자료다 — 별도 필터로 모아 본다
    if (timelineFilter === "reference")
      return events.filter((e) => e.type.startsWith("reference_") || e.type === "github_clone");
    return events;
  }, [events, timelineFilter]);

  if (loading || !user || !detail) return <Spinner />;

  const autoEvals = detail.evaluations.filter((e) => e.kind === "auto");
  const humanEvals = detail.evaluations.filter((e) => e.kind === "human");

  return (
    <Shell user={user}>
      {/* 헤더 */}
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-bold">{detail.user.name}</h1>
            <Badge value={detail.status} label={STATUS_LABEL[detail.status] ?? detail.status} />
            {detail.superseded && (
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500">재응시 이전 기록</span>
            )}
          </div>
          <p className="mt-0.5 text-sm text-slate-500">
            {detail.assessment.title} · {fmtDateTime(detail.started_at)} 시작
            {detail.submitted_at && ` · ${fmtDateTime(detail.submitted_at)} 종료`}
          </p>
        </div>
        {detail.scenarios.length > 1 && (
          <select className={`${inputCls} max-w-64`} value={scenarioId ?? ""} onChange={(e) => setScenarioId(e.target.value)}>
            {detail.scenarios.map((s, i) => (
              <option key={s.scenario_id} value={s.scenario_id}>
                {i + 1}. {s.title}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* 탭 */}
      <div className="mb-5 flex flex-wrap gap-1 border-b border-slate-200">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`-mb-px border-b-2 px-4 py-2.5 text-sm font-medium transition ${
              tab === t.key ? "border-slate-900 text-slate-900" : "border-transparent text-slate-400 hover:text-slate-600"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ── 개요·평가 ── */}
      {tab === "overview" && (
        <div className="space-y-6">
          {scenario && (
            <Card className="space-y-3 p-5">
              <h2 className="font-bold">시나리오: {scenario.title}</h2>
              <details>
                <summary className="cursor-pointer text-sm font-medium text-red-600">숨은 요구사항 보기 (응시자 비공개였음)</summary>
                <div className="mt-2 rounded-xl bg-red-50/50 p-4">
                  <Markdown>{scenario.objectives_md || "(없음)"}</Markdown>
                </div>
              </details>
            </Card>
          )}

          <Card className="space-y-3 p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="font-bold">LLM 자동평가</h2>
              <div className="flex items-center gap-2">
                <select className={`${inputCls} max-w-56`} value={evalProviderId} onChange={(e) => setEvalProviderId(e.target.value)}>
                  <option value="">기본 평가 공급자</option>
                  {providers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} — {p.model}
                    </option>
                  ))}
                </select>
                <Button onClick={runAutoEval} disabled={evaluating}>
                  {evaluating ? "평가 중... (체크 실행 포함)" : autoEvals.length ? "다시 평가" : "자동평가 실행"}
                </Button>
              </div>
            </div>
            {autoEvals.length === 0 ? (
              <EmptyState message="아직 자동평가가 없습니다. 체크 실행 + LLM 루브릭 평가를 수행합니다." />
            ) : (
              <AutoEvalView ev={autoEvals[0]} />
            )}
          </Card>

          <Card className="space-y-3 p-5">
            <h2 className="font-bold">평가자 수동 평가</h2>
            {humanEvals.map((ev) => (
              <div key={ev.id} className="rounded-xl border border-slate-200 p-3 text-sm">
                <p className="font-semibold">
                  {(ev.scores as { overall_score?: number }).overall_score ?? "-"}점 · {ev.evaluator} · {fmtDateTime(ev.created_at)}
                </p>
                {ev.summary && <p className="mt-1 whitespace-pre-wrap text-slate-600">{ev.summary}</p>}
              </div>
            ))}
            <div className="flex items-start gap-2">
              <input
                className={`${inputCls} max-w-24`}
                placeholder="점수"
                type="number"
                min={0}
                max={100}
                value={humanScore}
                onChange={(e) => setHumanScore(e.target.value)}
              />
              <textarea
                className={`${inputCls} min-h-20 flex-1`}
                placeholder="총평..."
                value={humanSummary}
                onChange={(e) => setHumanSummary(e.target.value)}
              />
              <Button variant="secondary" onClick={saveHumanEval} disabled={!humanScore && !humanSummary.trim()}>
                저장
              </Button>
            </div>
          </Card>
        </div>
      )}

      {/* ── 메신저 ── */}
      {tab === "messenger" && scenario && (
        <Card className="h-[600px] overflow-hidden p-0">
          <MessengerApp
            attemptId={id}
            scenarioId={scenario.scenario_id}
            characters={scenario.characters}
            readOnly
          />
        </Card>
      )}

      {/* ── 워크스페이스 ── */}
      {tab === "workspace" && scenario && (
        <Card className="h-[600px] overflow-hidden p-0">
          <WorkspaceProvider attemptId={id} scenarioId={scenario.scenario_id} onOpenIde={() => undefined}>
            <FilesApp readOnly />
          </WorkspaceProvider>
        </Card>
      )}

      {/* ── 에이전트 ── */}
      {tab === "agent" && (
        <Card className="p-5">
          {!agentMsgs ? (
            <Spinner />
          ) : agentMsgs.length === 0 ? (
            <EmptyState message="에이전트 사용 기록이 없습니다." />
          ) : (
            <div className="space-y-4">
              {agentMsgs.map((m) => (
                <div key={m.id} className={m.role === "user" ? "flex justify-end" : ""}>
                  {m.role === "user" ? (
                    <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-slate-800 px-3.5 py-2 text-sm text-white">
                      {m.content}
                    </div>
                  ) : (
                    <div className="space-y-1.5">
                      {(m.meta?.steps ?? []).length > 0 && (
                        <div className="flex flex-wrap gap-1">
                          {(m.meta.steps ?? []).map((s, i) => (
                            <span key={i} className="rounded-full border border-sky-200 bg-sky-50 px-2 py-0.5 text-[11px] text-sky-700">
                              {s.tool} {s.detail}
                            </span>
                          ))}
                        </div>
                      )}
                      <div className="max-w-[90%] rounded-2xl rounded-tl-md border border-slate-200 bg-slate-50 px-3.5 py-2 text-sm">
                        <Markdown>{m.content}</Markdown>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      {/* ── 실행 이력 ── */}
      {tab === "runs" && (
        <Card className="p-5">
          {!executions ? (
            <Spinner />
          ) : executions.length === 0 ? (
            <EmptyState message="실행 기록이 없습니다." />
          ) : (
            <div className="space-y-3">
              {executions.map((e) => (
                <details key={e.id} className="rounded-xl border border-slate-200 p-3">
                  <summary className="flex cursor-pointer items-center gap-2 text-sm">
                    <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-500">{e.source}</span>
                    <code className="min-w-0 flex-1 truncate font-mono text-xs">{e.command}</code>
                    <span className={`shrink-0 text-xs font-semibold ${e.exit_code === 0 ? "text-emerald-600" : "text-red-500"}`}>
                      exit {e.exit_code ?? "?"}
                    </span>
                    <span className="shrink-0 text-xs text-slate-400">{fmtDateTime(e.created_at)}</span>
                  </summary>
                  <div className="mt-2 space-y-2 font-mono text-xs">
                    {e.stdout && <pre className="thin-scroll max-h-56 overflow-auto whitespace-pre-wrap rounded-lg bg-slate-900 p-3 text-slate-200">{e.stdout}</pre>}
                    {e.stderr && <pre className="thin-scroll max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-red-950 p-3 text-red-200">{e.stderr}</pre>}
                    {(e.changed_files ?? []).length > 0 && (
                      <p className="text-slate-500">변경: {(e.changed_files ?? []).map((c) => c.path).join(", ")}</p>
                    )}
                  </div>
                </details>
              ))}
            </div>
          )}
        </Card>
      )}

      {/* ── 타임라인 ── */}
      {tab === "timeline" && (
        <Card className="p-5">
          <div className="mb-4 flex gap-1.5">
            {[
              ["all", "전체"],
              ["chat", "대화/에이전트"],
              ["files", "파일/실행"],
              ["reference", "참고 자료"],
              ["away", "이탈"],
            ].map(([k, label]) => (
              <button
                key={k}
                onClick={() => setTimelineFilter(k)}
                className={`rounded-full px-3 py-1 text-xs font-medium ${
                  timelineFilter === k ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-500 hover:bg-slate-200"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          {!events ? (
            <Spinner />
          ) : (
            <div className="thin-scroll max-h-[560px] space-y-0.5 overflow-y-auto">
              {filteredEvents.map((e) => (
                <div key={e.id} className="flex items-baseline gap-3 rounded-lg px-2 py-1 text-sm hover:bg-slate-50">
                  <span className="w-16 shrink-0 font-mono text-xs text-slate-400">
                    {fmtOffset(detail.started_at, e.created_at)}
                  </span>
                  <span className="w-28 shrink-0 font-medium">{EVENT_LABEL[e.type] ?? e.type}</span>
                  {e.source === "client_untrusted" && (
                    <span
                      title="응시자 브라우저가 보고한 값 — 위조·누락될 수 있어 단독 근거로 쓰지 않습니다"
                      className="shrink-0 rounded border border-amber-200 bg-amber-50 px-1 text-[10px] font-medium text-amber-700"
                    >
                      브라우저 보고
                    </span>
                  )}
                  <span className="min-w-0 flex-1 truncate text-xs text-slate-400">
                    {JSON.stringify(e.payload)}
                  </span>
                </div>
              ))}
              {filteredEvents.length === 0 && <EmptyState message="이벤트가 없습니다." />}
            </div>
          )}
        </Card>
      )}
    </Shell>
  );
}

"use client";

import { use, useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { aiErrorNotice, candidateEndedNote, isCandidateEnded } from "@/lib/ai-errors";
import type {
  AttemptGrantRecord,
  AgentMessage,
  AiIncidents,
  EvalProviderRef,
  EvalScenarioResult,
  Evaluation,
  Execution,
  ReviewAttempt,
  ReviewEvent,
  ReviewScenario,
} from "@/lib/types";
import { AWAY_EVENT_TYPES, EVENT_LABEL, fmtDateTime, fmtOffset, STATUS_LABEL } from "@/lib/format";
import { groupEvents, hasRawDetail } from "@/lib/timeline";
import { IconCheck, IconClose } from "@/components/icons";
import { useUser } from "@/components/useUser";
import { Shell } from "@/components/Shell";
import { Markdown } from "@/components/Markdown";
import { useToast } from "@/components/toast";
import { Badge, Button, Card, EmptyState, Field, inputBaseCls, inputCls, Spinner } from "@/components/ui";
import { WorkspaceProvider } from "@/components/desktop/workspace";
import { MessengerApp } from "@/components/desktop/apps/MessengerApp";
import { MessengerSessionProvider } from "@/components/desktop/messengerSession";
import { FilesApp } from "@/components/desktop/apps/FilesApp";
import { APP_META } from "@/components/desktop/Window";
import { MailReview } from "@/components/review/MailReview";
import { FileWorkReview } from "@/components/review/FileWorkReview";
import { ReferenceReview } from "@/components/review/ReferenceReview";

const ALL_TABS = [
  { key: "overview", label: "개요 · 평가" },
  { key: "messenger", label: "메신저 대화" },
  { key: "mail", label: "메일" },
  { key: "docs", label: "문서" },
  { key: "sheet", label: "OdyCell" },
  { key: "reference", label: "참고자료" },
  { key: "workspace", label: "워크스페이스" },
  { key: "agent", label: "에이전트 사용" },
  { key: "runs", label: "실행 이력" },
  { key: "timeline", label: "타임라인" },
] as const;

type TabKey = (typeof ALL_TABS)[number]["key"];

/** 이 시나리오에서 볼 수 있는 탭 — **활동이 일어난 앱**만 따라간다.
 *
 *  시나리오는 어떤 앱을 띄울지 스스로 정하지만(desktop_apps), 제공한 것과 쓴 것은 다르다. 표를
 *  준 과제에서 표를 한 번도 열지 않았다면 [OdyCell] 을 열어 비어 있음을 확인하는 일은 채점자의
 *  시간만 쓴다. 반대로 쓴 흔적이 있는데 목록에 없다는 이유로 감추면 증거가 사라진다.
 *
 *  그래서 판단은 서버가 기록에서 한다(app_usage.py). 화면은 고르지 않는다 — 자동 평가와 같은
 *  함수를 쓰므로 둘이 보는 것이 갈라지지 않는다.
 *
 *  개요·메신저·워크스페이스·타임라인은 언제나 있다. 메신저는 이 플랫폼이 문제를 건네는 수단
 *  자체이고(한 마디도 안 했다는 사실 자체가 평가 자료다), 워크스페이스와 타임라인은 앱과 무관하게
 *  "무엇이 남았고 무엇을 했는가" 이기 때문이다.
 */
function tabsFor(scenario: ReviewScenario | null): readonly { key: TabKey; label: string }[] {
  const act = scenario?.app_activity;
  // 서버가 아직 알려 주지 않는 옛 응답이면 감추지 않는다 — 모를 때는 보여 주는 쪽이 안전하다.
  if (!act) return ALL_TABS;
  const used = (app: string) => Boolean(act[app]?.used);
  const has = (key: TabKey) => {
    if (key === "mail" || key === "docs" || key === "sheet") return used(key);
    if (key === "reference") return used("github");
    if (key === "agent") return used("agent");
    // 실행은 터미널·IDE 에서, 또는 에이전트가 대신 돌렸을 때 일어난다
    if (key === "runs") return Boolean(act.terminal?.runs) || Boolean(act.agent?.acted);
    return true;
  };
  return ALL_TABS.filter((t) => has(t.key));
}

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
                    <span
                      className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full ${
                        c.passed ? "bg-emerald-100 text-emerald-600" : "bg-red-100 text-red-500"
                      }`}
                      aria-label={c.passed ? "통과" : "실패"}
                    >
                      {c.passed ? <IconCheck size={10} /> : <IconClose size={10} />}
                    </span>
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

const AI_ERROR_LABEL: Record<string, string> = {
  AI_TIMEOUT: "응답 지연",
  AI_RATE_LIMIT: "공급자 호출 한도",
  AI_QUOTA: "공급자 사용량 소진",
  AI_AUTH: "공급자 인증 실패",
  AI_UNAVAILABLE: "공급자 연결 실패",
  AI_BAD_RESPONSE: "응답 해석 실패",
  AI_BACKEND_ERROR: "기타 오류",
  // 서버가 사고 집계에서 빼는 코드지만, 목록이 어긋나도 코드 문자열이 그대로 보이지 않게 적어 둔다
  AI_CANCELLED: "응시자 중단",
  AI_DISCONNECTED: "응시자 쪽 연결 끊김",
  AI_INTERRUPTED: "응시자 쪽에서 멈춤",
};

/** 이 응시 중 AI 가 답을 만들지 못한 건수.
 *
 *  채점 전에 눈에 띄어야 하는 정보다. 이것이 없으면 평가자는 장애로 끊긴 대화를 응시자의
 *  소통 능력으로 읽는다 — 물어봤는데 답이 없었던 것과 묻지 않은 것이 기록상 같아 보인다.
 *  응시자 쪽에서 연결이 끊긴 턴은 서버가 이 집계에서 뺀다(장애가 아니다). */
/** 채점 전에 먼저 봐야 하는 수치 — 점수, 걸린 시간, 얼마나 물었는가, 무엇을 남겼는가.
 *
 *  예전에는 이 자리가 비어 있어서, 평가자가 탭을 하나씩 열어 보고서야 "이 응시가 어땠는지" 를
 *  짐작할 수 있었다. */
function AttemptSummary({ detail, score }: { detail: ReviewAttempt; score: number | null }) {
  const started = Date.parse(detail.started_at);
  const ended = detail.submitted_at ? Date.parse(detail.submitted_at) : null;
  const spentMin = ended ? Math.max(0, Math.round((ended - started) / 60000)) : null;
  const usage = detail.usage;
  const cells: [string, React.ReactNode, string?][] = [
    ["점수", score === null ? <span className="text-slate-300">미평가</span> : `${score}점`],
    [
      "걸린 시간",
      spentMin === null ? <span className="text-slate-300">진행 중</span> : `${spentMin}분`,
      `제한 ${detail.assessment.duration_min}분`,
    ],
    [
      "에이전트 질문",
      usage ? `${usage.agent_turns}회` : "—",
      detail.agent_turn_limit ? `한도 ${detail.agent_turn_limit}회` : "쓰지 않는 시험",
    ],
    [
      "메신저 질문",
      usage ? `${usage.messenger_turns}회` : "—",
      detail.messenger_turn_limit ? `한도 ${detail.messenger_turn_limit}건` : undefined,
    ],
    ["산출물", usage ? `${usage.files}개` : "—", usage ? `실행 ${usage.executions}회` : undefined],
  ];
  return (
    <div className="mb-5 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-slate-200 bg-slate-200 sm:grid-cols-5">
      {cells.map(([label, value, hint]) => (
        <div key={label} className="bg-white px-4 py-3">
          <p className="text-xs text-slate-400">{label}</p>
          <p className="mt-0.5 text-lg font-bold text-slate-800">{value}</p>
          {hint && <p className="text-[11px] text-slate-400">{hint}</p>}
        </div>
      ))}
    </div>
  );
}

/** 관리자 보정 — 이 응시는 원래 조건보다 시간·질문을 더 받았다. 사유와 함께 채점 전에 보인다. */
function GrantNotice({ grants }: { grants?: AttemptGrantRecord[] }) {
  if (!grants?.length) return null;
  return (
    <div className="mb-5 rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-xs text-sky-800">
      <p className="text-sm font-bold">관리자 보정 {grants.length}건 — 원래 조건보다 더 받은 응시입니다</p>
      <ul className="mt-1 space-y-0.5">
        {grants.map((g, i) => {
          const parts = [
            g.extra_minutes > 0 && `시간 +${g.extra_minutes}분`,
            g.agent_turns > 0 && `에이전트 질문 +${g.agent_turns}`,
            g.messenger_turns > 0 && `메시지 +${g.messenger_turns}`,
          ].filter(Boolean);
          return (
            <li key={i}>
              {fmtDateTime(g.at)} · {parts.join(" · ")} · {g.reason}
              {g.by && ` (${g.by})`}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function AiIncidentBanner({ incidents }: { incidents?: AiIncidents }) {
  if (!incidents || incidents.total <= 0) return null;
  const parts = Object.entries(incidents.by_code)
    .sort((a, b) => b[1] - a[1])
    .map(([code, n]) => `${AI_ERROR_LABEL[code] ?? code} ${n}건`);
  return (
    <div className="mb-5 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3">
      <p className="text-sm font-bold text-amber-800">
        이 응시 중 AI 오류 {incidents.total}건 — 대화 기록이 불완전할 수 있습니다
      </p>
      <p className="mt-1 text-xs leading-relaxed text-amber-700">
        메신저 {incidents.messenger}건 · 에이전트 {incidents.agent}건 ({parts.join(" · ")})
        {incidents.refunded > 0 && ` · 응시자에게 질문 ${incidents.refunded}회를 돌려주었습니다`}
      </p>
      <p className="mt-1 text-xs text-amber-700/80">
        응답을 받지 못한 질문은 메신저 대화·에이전트 사용 탭에 노란 알림으로 표시됩니다. 응시자가 묻지
        않은 것과 물었으나 답을 받지 못한 것을 구분해 채점하세요.
      </p>
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
  /** 원본 payload 를 펴 둔 줄 — 평소에는 사람이 읽는 설명만 보인다 */
  const [rawOpen, setRawOpen] = useState<Set<string>>(new Set());

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

  const tabs = useMemo(() => tabsFor(scenario), [scenario]);

  /** 보낸 메일의 파일 — [메일] 탭이 다루므로 [문서]·[OdyCell] 목록에서는 뺀다 */
  const sentMailPaths = useMemo(
    () =>
      new Set(
        (events ?? [])
          .filter((e) => e.type === "mail_sent" && e.scenario_id === scenarioId)
          .map((e) => String(e.payload.path ?? "")),
      ),
    [events, scenarioId],
  );

  // 시나리오를 바꾸면 보고 있던 탭이 그 시나리오에는 없을 수 있다 (메일 과제 → 코딩 과제)
  useEffect(() => {
    if (!tabs.some((t) => t.key === tab)) setTab("overview");
  }, [tabs, tab]);

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
    if (timelineFilter === "away")
      return events.filter(
        (e) => AWAY_EVENT_TYPES.includes(e.type) || e.type.endsWith("_visible") || e.type.endsWith("_focus") || e.type === "screenshot_key",
      );
    if (timelineFilter === "files") return events.filter((e) => e.type.startsWith("file_") || e.type.startsWith("run_"));
    if (timelineFilter === "chat") return events.filter((e) => e.type.startsWith("msg_") || e.type === "agent_turn");
    // 무엇을 찾아봤는지는 그 자체로 평가 자료다 — 별도 필터로 모아 본다
    if (timelineFilter === "reference")
      return events.filter((e) => e.type.startsWith("reference_") || e.type === "github_clone");
    return events;
  }, [events, timelineFilter]);

  // 연달아 같은 일이 벌어진 줄은 묶는다 (lib/timeline)
  const timelineRows = useMemo(() => groupEvents(filteredEvents), [filteredEvents]);

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
          <select className={`${inputBaseCls} w-full max-w-md`} value={scenarioId ?? ""} onChange={(e) => setScenarioId(e.target.value)}>
            {detail.scenarios.map((s, i) => (
              <option key={s.scenario_id} value={s.scenario_id}>
                {i + 1}. {s.title}
              </option>
            ))}
          </select>
        )}
      </div>

      <AttemptSummary detail={detail} score={
        (humanEvals[0]?.scores as { overall_score?: number } | undefined)?.overall_score ??
        (autoEvals[0]?.scores as { overall_score?: number } | undefined)?.overall_score ??
        null
      } />
      <AiIncidentBanner incidents={detail.ai_incidents} />
      <GrantNotice grants={detail.grants} />

      {/* 탭 */}
      <div className="mb-5 flex flex-wrap gap-1 border-b border-slate-200">
        {tabs.map((t) => (
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
              {/* 쥐고 있던 도구와, 그중 실제로 쓴 것. 없는 도구로 못 한 일을 감점하지 않도록,
                  그리고 준 도구를 한 번도 열지 않았다는 사실도 놓치지 않도록 먼저 밝힌다. */}
              <div className="flex flex-wrap items-center gap-1.5 text-xs">
                <span className="text-slate-400">제공된 앱</span>
                {(scenario.desktop_apps ?? []).map((a) => {
                  const act = scenario.app_activity?.[a];
                  const used = act?.used;
                  return (
                    <span
                      key={a}
                      title={used ? `${act?.what} ${act?.count}번` : "이 시험에서 열지 않았습니다"}
                      className={`rounded-full px-2 py-0.5 ${
                        used ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-400"
                      }`}
                    >
                      {APP_META[a]?.title ?? a}
                      {used ? ` ${act?.count}` : " · 안 씀"}
                    </span>
                  );
                })}
                {scenario.agent_enabled !== false && (
                  <span
                    title={
                      scenario.app_activity?.agent?.acted
                        ? `질문 ${scenario.app_activity.agent.count}번 · 파일·실행 ${scenario.app_activity.agent.acted}번`
                        : "이 시험에서 쓰지 않았습니다"
                    }
                    className={`rounded-full px-2 py-0.5 ${
                      scenario.app_activity?.agent?.used ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-400"
                    }`}
                  >
                    AI 에이전트
                    {scenario.app_activity?.agent?.used ? ` ${scenario.app_activity.agent.count}` : " · 안 씀"}
                  </span>
                )}
              </div>
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
                <select className={`${inputBaseCls} w-56`} value={evalProviderId} onChange={(e) => setEvalProviderId(e.target.value)}>
                  <option value="">기본 평가 공급자</option>
                  {providers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} — {p.model}
                    </option>
                  ))}
                </select>
                <Button onClick={runAutoEval} disabled={evaluating} write>
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
                className={`${inputBaseCls} w-24`}
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
              <Button variant="secondary" onClick={saveHumanEval} disabled={!humanScore && !humanSummary.trim()} write>
                저장
              </Button>
            </div>
          </Card>
        </div>
      )}

      {/* ── 메신저 ── */}
      {tab === "messenger" && scenario && (
        <Card className="h-[600px] overflow-hidden p-0">
          <MessengerSessionProvider
            key={scenario.scenario_id}
            attemptId={id}
            scenarioId={scenario.scenario_id}
            characters={scenario.characters}
            readOnly
          >
            <MessengerApp />
          </MessengerSessionProvider>
        </Card>
      )}

      {/* ── 메일·문서·OdyCell ── 응시자가 그 앱으로 한 일을, 그 앱의 모양으로 ── */}
      {(tab === "mail" || tab === "docs" || tab === "sheet") && scenario && (
        <Card className="h-[600px] overflow-hidden p-0">
          <WorkspaceProvider
            key={`${tab}-${scenario.scenario_id}`}
            attemptId={id}
            scenarioId={scenario.scenario_id}
            onOpenIde={() => undefined}
          >
            {tab === "mail" ? (
              <MailReview scenarioId={scenario.scenario_id} events={events} />
            ) : (
              <FileWorkReview kind={tab} exclude={sentMailPaths} />
            )}
          </WorkspaceProvider>
        </Card>
      )}

      {/* ── 참고자료 ── 무엇을 모르고, 어떻게 찾았는가 ── */}
      {tab === "reference" && scenario && (
        <Card className="h-[600px] overflow-hidden p-0">
          <ReferenceReview scenarioId={scenario.scenario_id} events={events} />
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
                      {m.content && (
                        <div className="max-w-[90%] rounded-2xl rounded-tl-md border border-slate-200 bg-slate-50 px-3.5 py-2 text-sm">
                          <Markdown>{m.content}</Markdown>
                        </div>
                      )}
                      {/* 실패한 턴 — 빈 말풍선으로 두면 에이전트가 아무 말도 안 한 것처럼 보인다.
                          응시자가 멈추거나 끊은 턴은 장애가 아니므로 노란 알림이 아니라 회색 메모로 구분한다. */}
                      {m.meta?.error &&
                        (isCandidateEnded(m.meta) ? (
                          <p className="max-w-[90%] rounded-lg bg-slate-100 px-3 py-1.5 text-xs text-slate-500">
                            {candidateEndedNote(m.meta, Boolean(m.content))}
                          </p>
                        ) : (
                          <div className="max-w-[90%] rounded-xl border border-amber-300 bg-amber-50 px-3.5 py-2">
                            <p className="text-xs font-semibold text-amber-800">답변 실패 (평가 참고)</p>
                            <p className="mt-0.5 text-xs leading-relaxed text-amber-700">
                              {aiErrorNotice(m.meta)}
                              {m.content ? " — 위 내용까지 받고 끊겼습니다" : ""}
                            </p>
                          </div>
                        ))}
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
              {timelineRows.map((row) => {
                const open = rawOpen.has(row.key);
                const raw = hasRawDetail(row.payloads);
                return (
                  <div key={row.key} className="rounded-lg px-2 py-1 text-sm hover:bg-slate-50">
                    <div className="flex items-baseline gap-3">
                      <span className="w-16 shrink-0 font-mono text-xs text-slate-400">
                        {fmtOffset(detail.started_at, row.createdAt)}
                      </span>
                      <span className="flex w-32 shrink-0 items-baseline gap-1 font-medium">
                        {row.label}
                        {row.count > 1 && (
                          <span className="rounded bg-slate-100 px-1 text-[10px] font-semibold text-slate-500">
                            ×{row.count}
                          </span>
                        )}
                      </span>
                      {row.untrusted && (
                        <span
                          title="응시자 브라우저가 보고한 값 — 위조·누락될 수 있어 단독 근거로 쓰지 않습니다"
                          aria-label="브라우저 보고"
                          className="shrink-0 text-[11px] text-amber-500"
                        >
                          ◦
                        </span>
                      )}
                      <span className="min-w-0 flex-1 truncate text-xs text-slate-500">{row.detail}</span>
                      {raw && (
                        <button
                          onClick={() =>
                            setRawOpen((prev) => {
                              const next = new Set(prev);
                              if (next.has(row.key)) next.delete(row.key);
                              else next.add(row.key);
                              return next;
                            })
                          }
                          className="shrink-0 text-[11px] text-slate-300 transition hover:text-slate-600"
                        >
                          {open ? "닫기" : "자세히"}
                        </button>
                      )}
                    </div>
                    {open && (
                      <pre className="thin-scroll mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap break-all rounded-lg bg-slate-50 px-2 py-1.5 font-mono text-[11px] leading-relaxed text-slate-500">
                        {row.payloads.map((p) => JSON.stringify(p)).join("\n")}
                      </pre>
                    )}
                  </div>
                );
              })}
              {timelineRows.length === 0 && <EmptyState message="이벤트가 없습니다." />}
            </div>
          )}
        </Card>
      )}
    </Shell>
  );
}

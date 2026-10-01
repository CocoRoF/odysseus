"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "@/lib/api";
import type {
  BlockedIp,
  GuestPolicy,
  GuestStats,
  ReferenceSettings,
  UiSettings,
  AiModelInfo,
  AiProviderMeta,
  AiProviderRow,
  AiSettingsMeta,
  AiTestResult,
} from "@/lib/types";
import { useUser } from "@/components/useUser";
import { Shell } from "@/components/Shell";
import { Button, Card, EmptyState, Field, IconButton, inputCls, Modal, Spinner } from "@/components/ui";
import { useReadOnly, writeProps } from "@/components/readonly";
import { DataTable } from "@/components/DataTable";
import { IconDelete } from "@/components/icons";
import { fmtDateTime } from "@/lib/format";
import { useToast } from "@/components/toast";

interface ProviderForm {
  name: string;
  provider: string;
  base_url: string;
  api_key: string; // 빈 값 = 기존 유지 (편집 시)
  clearKey: boolean;
  model: string;
  temperature: number;
  max_tokens: number;
  enabled: boolean;
}

const emptyForm = (meta: AiProviderMeta | null): ProviderForm => ({
  name: meta ? meta.label : "",
  provider: meta?.provider ?? "openai",
  base_url: meta?.default_base_url ?? "",
  api_key: "",
  clearKey: false,
  model: "",
  temperature: 0.2,
  max_tokens: 4096,
  enabled: true,
});

interface AiHealth {
  window_minutes: number;
  total: number;
  provider_faults: number;
  by_model: Record<string, Record<string, number>>;
  degraded: boolean;
}

const AI_ERROR_LABEL: Record<string, string> = {
  AI_TIMEOUT: "응답 지연",
  AI_RATE_LIMIT: "호출 한도",
  AI_AUTH: "인증 실패",
  AI_UNAVAILABLE: "연결 실패",
  AI_BAD_RESPONSE: "응답 해석 실패",
  AI_BACKEND_ERROR: "기타 오류",
  AI_CANCELLED: "응시자 중단",
};

/** 최근 AI 실패 현황.
 *
 *  공급자 키가 소진되거나 차단됐을 때, 지금까지 관리자가 그것을 아는 경로는 **응시자의
 *  항의**뿐이었다. 항의하지 않는 응시자는 조용히 손해를 봤다. 여기서 자동으로 끄지는
 *  않는다 — 시험이 공급자를 명시적으로 지정하고 있으면 끄는 순간 진행 중인 응시가 전부
 *  멈춘다. 사실만 보여 주고 판단은 사람이 한다. */
/** 긴 설명은 접어 둔다 — 읽을 사람은 펴서 읽고, 아는 사람은 조작 칸부터 본다. */
function Collapsible({ summary, children }: { summary: string; children: React.ReactNode }) {
  return (
    <details className="mb-5 mt-1 text-sm text-slate-500">
      <summary className="cursor-pointer list-none text-xs font-medium text-slate-400 transition hover:text-slate-600">
        {summary} ▾
      </summary>
      <p className="mt-2 leading-relaxed">{children}</p>
    </details>
  );
}

function AiHealthBanner({ health }: { health: AiHealth | null }) {
  if (!health || !health.degraded) return null;
  const lines = Object.entries(health.by_model).map(([model, codes]) => {
    const parts = Object.entries(codes)
      .sort((a, b) => b[1] - a[1])
      .map(([code, n]) => `${AI_ERROR_LABEL[code] ?? code} ${n}건`);
    return `${model} — ${parts.join(" · ")}`;
  });
  return (
    <div className="mb-5 rounded-xl border border-red-300 bg-red-50 px-4 py-3">
      <p className="text-sm font-bold text-red-700">
        최근 {health.window_minutes}분 동안 AI 공급자 오류 {health.provider_faults}건 — 키 소진이나 차단일 수
        있습니다
      </p>
      <ul className="mt-1 space-y-0.5 text-xs text-red-700/90">
        {lines.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
      <p className="mt-1.5 text-xs text-red-700/80">
        응시자에게는 실패한 질문 횟수를 자동으로 돌려주고 있습니다. 공급자를 비활성화하면 그 공급자를
        지정한 <b>진행 중인 응시가 멈추므로</b>, 키를 교체하거나 기본 공급자를 바꾸는 쪽이 안전합니다.
      </p>
    </div>
  );
}

export default function SettingsPage() {
  const readOnly = useReadOnly();
  const { user, loading } = useUser(["admin"]);
  const [meta, setMeta] = useState<AiSettingsMeta | null>(null);
  const [rows, setRows] = useState<AiProviderRow[] | null>(null);
  const [editing, setEditing] = useState<{ row: AiProviderRow | null } | null>(null);
  const [testResults, setTestResults] = useState<Record<string, AiTestResult>>({});
  const [busyId, setBusyId] = useState<string>("");
  const [health, setHealth] = useState<AiHealth | null>(null);
  const { confirm } = useToast();

  const load = useCallback(async () => {
    const [m, r, h] = await Promise.all([
      api.get<AiSettingsMeta>("/admin/settings/ai/meta"),
      api.get<AiProviderRow[]>("/admin/settings/ai/providers"),
      // 실패해도 화면은 떠야 한다 — 장애 현황은 있으면 좋은 것이지 필수가 아니다.
      api.get<AiHealth>("/admin/settings/ai/health").catch(() => null),
    ]);
    setMeta(m);
    setRows(r);
    setHealth(h);
  }, []);

  useEffect(() => {
    if (user) load();
  }, [user, load]);

  const testProvider = async (row: AiProviderRow) => {
    setBusyId(`test:${row.id}`);
    try {
      const result = await api.post<AiTestResult>("/admin/settings/ai/test", { provider_id: row.id });
      setTestResults((prev) => ({ ...prev, [row.id]: result }));
    } catch (e) {
      setTestResults((prev) => ({
        ...prev,
        [row.id]: { ok: false, error: e instanceof ApiError ? e.message : "테스트 실패" },
      }));
    } finally {
      setBusyId("");
    }
  };

  const setDefault = async (row: AiProviderRow, kind: "chat" | "eval") => {
    setBusyId(`default:${row.id}`);
    try {
      await api.put("/admin/settings/ai/defaults", {
        chat_provider_id: kind === "chat" ? row.id : null,
        eval_provider_id: kind === "eval" ? row.id : null,
      });
      await load();
    } finally {
      setBusyId("");
    }
  };

  const toggleEnabled = async (row: AiProviderRow) => {
    await api.put(`/admin/settings/ai/providers/${row.id}`, {
      name: row.name,
      provider: row.provider,
      base_url: row.base_url,
      api_key: null,
      model: row.model,
      temperature: row.temperature,
      max_tokens: row.max_tokens,
      enabled: !row.enabled,
    });
    await load();
  };

  const remove = async (row: AiProviderRow) => {
    if (!(await confirm({ title: "공급자를 삭제할까요?", message: row.name, danger: true, confirmLabel: "삭제" }))) return;
    await api.del(`/admin/settings/ai/providers/${row.id}`);
    await load();
  };

  if (loading || !user) return <Spinner />;

  const catalogOf = (provider: string) => meta?.catalog.find((c) => c.provider === provider);

  return (
    <Shell user={user}>
      <div className="mb-3 flex items-center justify-between">
        <h1 className="text-xl font-bold">설정</h1>
        <Button onClick={() => setEditing({ row: null })}>+ 공급자 추가</Button>
      </div>
      {/* 한 화면에 다섯 묶음이 들어 있다 — 제목만으로는 어디에 무엇이 있는지 알 수 없어 바로 가기를 둔다 */}
      <nav className="mb-5 flex flex-wrap gap-1.5 text-xs">
        {[
          ["#ai", "LLM 공급자"],
          ["#exam", "응시 환경"],
          ["#guest", "게스트 접속"],
          ["#ip", "주소 차단"],
          ["#reference", "참고 자료"],
        ].map(([href, label]) => (
          <a
            key={href}
            href={href}
            className="rounded-full border border-slate-200 px-3 py-1 font-medium text-slate-500 transition hover:border-slate-400 hover:text-slate-800"
          >
            {label}
          </a>
        ))}
      </nav>
      <AiHealthBanner health={health} />
      <h2 id="ai" className="scroll-mt-20 text-base font-bold">LLM 공급자</h2>
      <Collapsible summary="이 화면이 무엇을 정하는지">
        시나리오 등장인물(NPC) 대화, 응시자 AI 에이전트, 자동평가에 사용할 LLM을 관리합니다.
        클라우드(OpenAI · Anthropic · Gemini)와 로컬(vLLM · Ollama · LM Studio · OpenAI 호환), Claude Code
        CLI를 모두 지원하며, 시험별로 NPC/에이전트 공급자를 따로 지정할 수도 있습니다. Claude Code CLI는
        내장 도구·스킬이 전부 차단된 순수 LLM으로 동작합니다(도구가 필요한 에이전트는 대화 전용으로 동작).
      </Collapsible>

      {/* 유효 설정 배너 */}
      {meta && (
        <div
          className={`mb-6 flex items-center gap-3 rounded-xl border px-4 py-3 text-sm ${
            meta.effective_chat?.configured
              ? "border-emerald-200 bg-emerald-50 text-emerald-800"
              : "border-amber-200 bg-amber-50 text-amber-800"
          }`}
        >
          <span
            className={`h-2.5 w-2.5 shrink-0 rounded-full ${
              meta.effective_chat?.configured ? "bg-emerald-500" : "bg-amber-400"
            }`}
          />
          {meta.effective_chat?.configured ? (
            <span className="min-w-0">
              <b>채팅</b>: {meta.effective_chat.name} ({catalogOf(meta.effective_chat.provider)?.label} ·{" "}
              {meta.effective_chat.model})
              <span className="mx-2 text-emerald-400">|</span>
              <b>자동평가</b>:{" "}
              {meta.effective_eval?.configured
                ? `${meta.effective_eval.name} (${meta.effective_eval.model})`
                : "미설정"}
              {meta.effective_chat.source === "env" && (
                <span className="ml-2 rounded bg-white/70 px-1.5 py-0.5 text-xs">환경변수 폴백</span>
              )}
            </span>
          ) : (
            <span>
              <b>미설정</b> — 활성화된 공급자가 없어 AI 채팅과 자동평가가 비활성화되어 있습니다.
            </span>
          )}
        </div>
      )}

      {/* 공급자 목록 */}
      {!rows ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState message="등록된 공급자가 없습니다. '공급자 추가'로 시작하세요." />
        </Card>
      ) : (
        <div className="space-y-3">
          {rows.map((row) => {
            const cat = catalogOf(row.provider);
            const test = testResults[row.id];
            return (
              <Card key={row.id} className={`p-4 ${row.enabled ? "" : "opacity-60"}`}>
                <div className="flex flex-wrap items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-bold">{row.name}</span>
                      <span
                        className={`shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold ${
                          cat?.kind === "local"
                            ? "bg-sky-100 text-sky-700"
                            : cat?.kind === "cli"
                              ? "bg-amber-100 text-amber-700"
                              : "bg-slate-100 text-slate-600"
                        }`}
                      >
                        {cat?.label ?? row.provider}
                        {cat?.kind === "local" ? " · 로컬" : cat?.kind === "cli" ? " · 순수 LLM 잠금" : ""}
                      </span>
                      {row.is_chat_default && (
                        <span className="shrink-0 whitespace-nowrap rounded-full bg-violet-100 px-2 py-0.5 text-xs font-semibold text-violet-700">
                          기본 채팅
                        </span>
                      )}
                      {row.is_eval_default && (
                        <span className="shrink-0 whitespace-nowrap rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-700">
                          기본 평가
                        </span>
                      )}
                      {!row.enabled && (
                        <span className="shrink-0 rounded-full bg-slate-200 px-2 py-0.5 text-xs text-slate-500">
                          비활성
                        </span>
                      )}
                    </div>
                    <div className="mt-1 truncate text-xs text-slate-500">
                      모델 <b>{row.model}</b>
                      {row.base_url && <> · {row.base_url}</>}
                      {row.has_key && <> · 키 {row.key_hint}</>}
                      {cat?.supports_temperature !== false && <> · temp {row.temperature}</>}
                      <> · max {row.max_tokens}tok</>
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                    {!row.is_chat_default && (
                      <button
                        onClick={() => setDefault(row, "chat")}
                        {...writeProps(readOnly, busyId !== "" || !row.enabled)}
                        className="whitespace-nowrap rounded-lg border border-slate-200 px-2.5 py-1 text-xs text-slate-600 hover:border-violet-300 hover:text-violet-600 disabled:opacity-40"
                      >
                        채팅 기본
                      </button>
                    )}
                    {!row.is_eval_default && (
                      <button
                        onClick={() => setDefault(row, "eval")}
                        {...writeProps(readOnly, busyId !== "" || !row.enabled)}
                        className="whitespace-nowrap rounded-lg border border-slate-200 px-2.5 py-1 text-xs text-slate-600 hover:border-emerald-300 hover:text-emerald-600 disabled:opacity-40"
                      >
                        평가 기본
                      </button>
                    )}
                    <button
                      onClick={() => testProvider(row)}
                      {...writeProps(readOnly, busyId !== "")}
                      className="whitespace-nowrap rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40"
                    >
                      {busyId === `test:${row.id}` ? "테스트 중..." : "연결 테스트"}
                    </button>
                    <button
                      onClick={() => toggleEnabled(row)}
                      {...writeProps(readOnly)}
                      className="whitespace-nowrap rounded-lg border border-slate-200 px-2.5 py-1 text-xs text-slate-500 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {row.enabled ? "비활성화" : "활성화"}
                    </button>
                    <button
                      onClick={() => setEditing({ row })}
                      className="whitespace-nowrap rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 transition hover:bg-slate-50"
                    >
                      편집
                    </button>
                    <span className="mx-0.5 h-5 w-px bg-slate-200" aria-hidden="true" />
                    <button
                      onClick={() => remove(row)}
                      {...writeProps(readOnly)}
                      title="이 공급자 삭제"
                      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-slate-300 transition hover:bg-red-50 hover:text-red-500 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-slate-300"
                    >
                      <IconDelete size={14} />
                    </button>
                  </div>
                </div>
                {test && (
                  <div
                    className={`mt-3 rounded-lg px-3 py-2 text-xs ${
                      test.ok ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-700"
                    }`}
                  >
                    {test.ok ? (
                      <span>
                        연결 성공 — {test.model} · {test.latency_ms}ms
                        {test.reply && <span className="ml-2 opacity-70">응답: {test.reply}</span>}
                      </span>
                    ) : (
                      <span>연결 실패 — {test.error}</span>
                    )}
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}

      <p className="mt-4 text-xs text-slate-400">
        API 키는 서버에만 저장되며 화면에는 마지막 4자리만 표시됩니다. 시험 편집 화면에서 NPC/에이전트
        공급자를 따로 지정할 수 있습니다 (미지정 시 기본 채팅 공급자 사용).
      </p>

      <div id="exam" className="scroll-mt-20" />
      <ExamExperienceCard />
      <div id="guest" className="scroll-mt-20" />
      <GuestAccessCard />
      <div id="ip" className="scroll-mt-20" />
      <IpBlockSection />
      <div id="reference" className="scroll-mt-20" />
      <ReferenceCard />

      {editing && meta && (
        <ProviderModal
          meta={meta}
          row={editing.row}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await load();
          }}
        />
      )}
    </Shell>
  );
}

/** 공급자 추가/편집 모달 — 유형 선택 시 기본값 자동 채움 + 라이브 모델 목록 + 저장 전 테스트 */
function ProviderModal({
  meta,
  row,
  onClose,
  onSaved,
}: {
  meta: AiSettingsMeta;
  row: AiProviderRow | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const readOnly = useReadOnly();
  const { toast } = useToast();
  const [form, setForm] = useState<ProviderForm>(
    row
      ? {
          name: row.name,
          provider: row.provider,
          base_url: row.base_url ?? "",
          api_key: "",
          clearKey: false,
          model: row.model,
          temperature: row.temperature,
          max_tokens: row.max_tokens,
          enabled: row.enabled,
        }
      : emptyForm(meta.catalog[0] ?? null),
  );
  const [models, setModels] = useState<AiModelInfo[] | null>(null);
  const [modelsError, setModelsError] = useState("");
  const [testResult, setTestResult] = useState<AiTestResult | null>(null);
  const [busy, setBusy] = useState<"" | "save" | "test" | "models">("");

  const cat = meta.catalog.find((c) => c.provider === form.provider);

  const set = <K extends keyof ProviderForm>(key: K, value: ProviderForm[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const changeType = (provider: string) => {
    const next = meta.catalog.find((c) => c.provider === provider);
    setForm((f) => ({
      ...f,
      provider,
      base_url: f.base_url || next?.default_base_url || "",
      // 이름이 비었거나 다른 유형의 기본 라벨 그대로면 새 유형 라벨로 교체
      name: !f.name || meta.catalog.some((c) => c.label === f.name) ? next?.label ?? "" : f.name,
    }));
    setModels(null);
    setModelsError("");
  };

  const draftBody = () => ({
    provider_id: row?.id ?? null,
    provider: form.provider,
    base_url: form.base_url.trim() || null,
    api_key: form.clearKey ? "" : form.api_key.trim() || null,
    model: form.model.trim() || null,
  });

  const loadModels = async () => {
    setBusy("models");
    setModelsError("");
    try {
      const r = await api.post<{ source: string; error: string | null; models: AiModelInfo[] }>(
        "/admin/settings/ai/models",
        draftBody(),
      );
      if (r.source === "live" || r.source === "static") setModels(r.models);
      else {
        setModels([]);
        setModelsError(r.error || "모델 목록을 가져올 수 없습니다");
      }
    } catch (e) {
      setModels([]);
      setModelsError(e instanceof ApiError ? e.message : "모델 목록 실패");
    } finally {
      setBusy("");
    }
  };

  const test = async () => {
    setBusy("test");
    setTestResult(null);
    try {
      setTestResult(await api.post<AiTestResult>("/admin/settings/ai/test", draftBody()));
    } catch (e) {
      setTestResult({ ok: false, error: e instanceof ApiError ? e.message : "테스트 실패" });
    } finally {
      setBusy("");
    }
  };

  const save = async () => {
    if (!form.name.trim()) return toast("이름을 입력하세요", "info");
    if (!form.model.trim()) return toast("모델을 입력하세요", "info");
    setBusy("save");
    const body = {
      name: form.name.trim(),
      provider: form.provider,
      base_url: form.base_url.trim() || null,
      api_key: form.clearKey ? "" : form.api_key.trim() ? form.api_key.trim() : row ? null : "",
      model: form.model.trim(),
      temperature: form.temperature,
      max_tokens: form.max_tokens,
      enabled: form.enabled,
    };
    try {
      if (row) await api.put(`/admin/settings/ai/providers/${row.id}`, body);
      else await api.post("/admin/settings/ai/providers", body);
      onSaved();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "저장 실패", "error");
      setBusy("");
    }
  };

  return (
    <Modal title={row ? "공급자 편집" : "공급자 추가"} onClose={onClose}>
      <div className="space-y-4">
        <Field label="유형">
          <select className={inputCls} value={form.provider} onChange={(e) => changeType(e.target.value)}>
            {meta.catalog.map((c) => (
              <option key={c.provider} value={c.provider}>
                {c.label} {c.kind === "local" ? "(로컬)" : c.kind === "cli" ? "(CLI)" : "(클라우드)"}
              </option>
            ))}
          </select>
          {cat && <p className="mt-1 text-xs text-slate-400">{cat.description}</p>}
        </Field>

        <Field label="표시 이름">
          <input className={inputCls} value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="예: 사내 vLLM (Qwen)" />
        </Field>

        <Field
          label={`Base URL${cat?.needs_base_url ? " (필수)" : " (선택)"}`}
          hint={cat?.default_base_url ? `기본값: ${cat.default_base_url}` : undefined}
        >
          <input
            className={inputCls}
            value={form.base_url}
            onChange={(e) => set("base_url", e.target.value)}
            placeholder={cat?.default_base_url ?? "https://..."}
          />
        </Field>

        <Field
          label={`API 키${cat?.needs_key ? " (필수)" : " (선택)"}`}
          hint={
            row?.has_key
              ? `현재 저장된 키: ${row.key_hint} — 비워두면 유지됩니다`
              : "서버에만 저장되며 다시 표시되지 않습니다"
          }
        >
          <div className="flex items-center gap-3">
            <input
              className={inputCls}
              type="password"
              value={form.api_key}
              onChange={(e) => {
                set("api_key", e.target.value);
                if (e.target.value) set("clearKey", false);
              }}
              placeholder={row?.has_key ? "(변경할 때만 입력)" : cat?.needs_key ? "sk-..." : "(없어도 됨)"}
              disabled={form.clearKey}
            />
            {row?.has_key && (
              <label className="flex shrink-0 items-center gap-1.5 text-xs text-red-500">
                <input
                  type="checkbox"
                  checked={form.clearKey}
                  onChange={(e) => set("clearKey", e.target.checked)}
                />
                키 삭제
              </label>
            )}
          </div>
        </Field>

        {cat?.provider === "claude_code_cli" && (
          <ClaudeLoginBox
            onToken={(token) => {
              set("api_key", token);
              set("clearKey", false);
            }}
          />
        )}

        <Field label="모델">
          <div className="flex gap-2">
            <input
              className={inputCls}
              value={form.model}
              onChange={(e) => set("model", e.target.value)}
              placeholder={cat?.placeholder_model}
            />
            <button
              onClick={loadModels}
              {...writeProps(readOnly, busy !== "")}
              className="shrink-0 whitespace-nowrap rounded-lg border border-slate-300 px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-40"
            >
              {busy === "models" ? "조회 중..." : "모델 목록"}
            </button>
          </div>
          {models !== null && (
            <div className="mt-2">
              {models.length > 0 ? (
                <div className="dark-scroll max-h-36 space-y-0.5 overflow-y-auto rounded-lg border border-slate-200 p-1.5">
                  {models.map((m) => (
                    <button
                      key={m.id}
                      onClick={() => set("model", m.id)}
                      className={`block w-full truncate rounded px-2 py-1 text-left text-xs ${
                        form.model === m.id ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"
                      }`}
                    >
                      {m.id}
                      {m.display_name && m.display_name !== m.id && (
                        <span className="ml-1 opacity-60">({m.display_name})</span>
                      )}
                    </button>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-amber-600">{modelsError || "모델이 없습니다"}</p>
              )}
            </div>
          )}
        </Field>

        {cat?.kind === "cli" && (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
            이 공급자는 순수 LLM 잠금 모드로 실행됩니다 — CLI 내장 도구·스킬·MCP가 전부 차단되고,
            temperature·응답 최대 토큰 값은 CLI가 지원하지 않아 무시됩니다.
          </p>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Temperature" hint={cat?.supports_temperature === false ? "이 공급자는 temperature를 지원하지 않습니다" : "0 = 결정적, 높을수록 다양"}>
            <input
              className={inputCls}
              type="number"
              disabled={cat?.supports_temperature === false}
              step={0.1}
              min={0}
              max={2}
              value={form.temperature}
              onChange={(e) => set("temperature", Number(e.target.value))}
            />
          </Field>
          <Field label="응답 최대 토큰">
            <input
              className={inputCls}
              type="number"
              min={256}
              max={128000}
              value={form.max_tokens}
              onChange={(e) => set("max_tokens", Number(e.target.value))}
            />
          </Field>
        </div>

        <label className="flex items-center gap-2 text-sm text-slate-600">
          <input type="checkbox" checked={form.enabled} onChange={(e) => set("enabled", e.target.checked)} />
          활성화
        </label>

        {testResult && (
          <div
            className={`rounded-lg px-3 py-2 text-xs ${
              testResult.ok ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-700"
            }`}
          >
            {testResult.ok ? (
              <span>
                연결 성공 — {testResult.model} · {testResult.latency_ms}ms
                {testResult.reply && <span className="ml-1 opacity-70">응답: {testResult.reply}</span>}
              </span>
            ) : (
              <span>연결 실패 — {testResult.error}</span>
            )}
          </div>
        )}

        <div className="flex justify-end gap-2 border-t border-slate-100 pt-3">
          <Button variant="ghost" onClick={onClose}>
            취소
          </Button>
          <Button variant="secondary" onClick={test} disabled={busy !== ""} write>
            {busy === "test" ? "테스트 중..." : "연결 테스트"}
          </Button>
          <Button onClick={save} disabled={busy !== ""} write>
            {busy === "save" ? "저장 중..." : "저장"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}


// ── Claude 계정 로그인 (setup-token 중계) ─────────────────────

interface ClaudeLoginState {
  session_id: string;
  state: "starting" | "awaiting_code" | "verifying" | "success" | "error";
  url: string | null;
  token: string | null;
  error: string | null;
  /** 실패했을 때 CLI 의 실제 출력 (토큰은 가려져 있다) */
  diagnostic?: string | null;
}

function ClaudeLoginBox({ onToken }: { onToken: (token: string) => void }) {
  const [phase, setPhase] = useState<"idle" | "starting" | "awaiting" | "verifying" | "success" | "error">("idle");
  const [session, setSession] = useState<ClaudeLoginState | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [diagnostic, setDiagnostic] = useState("");
  const sessionRef = useRef<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPoll = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  useEffect(() => {
    return () => {
      stopPoll();
      // 모달 닫힘 → 진행 중 세션 정리 (best-effort)
      if (sessionRef.current) api.del(`/admin/settings/ai/claude-login/${sessionRef.current}`).catch(() => undefined);
    };
  }, []);

  const applyState = (st: ClaudeLoginState): boolean => {
    setSession(st);
    if (st.state === "success" && st.token) {
      stopPoll();
      onToken(st.token);
      setPhase("success");
      sessionRef.current = null;
      return true;
    }
    if (st.state === "error") {
      stopPoll();
      setError(st.error || "로그인에 실패했습니다");
      setDiagnostic(st.diagnostic || "");
      setPhase("error");
      return true;
    }
    if (st.state === "awaiting_code" && st.url) setPhase("awaiting");
    if (st.state === "verifying") setPhase("verifying");
    return false;
  };

  const pollUntilSettled = (sid: string, timeoutMs: number) => {
    stopPoll();
    const deadline = Date.now() + timeoutMs;
    pollRef.current = setInterval(async () => {
      if (Date.now() > deadline) {
        stopPoll();
        setError("응답이 오지 않습니다. [다시 시도]로 로그인을 새로 시작하세요.");
        setPhase("error");
        return;
      }
      try {
        const st = await api.get<ClaudeLoginState>(`/admin/settings/ai/claude-login/${sid}`);
        applyState(st);
      } catch (e) {
        stopPoll();
        setError(e instanceof ApiError ? e.message : "상태 조회 실패");
        setPhase("error");
      }
    }, 1500);
  };

  const start = async () => {
    setPhase("starting");
    setError("");
    setDiagnostic("");
    setCode("");
    try {
      const st = await api.post<ClaudeLoginState>("/admin/settings/ai/claude-login");
      sessionRef.current = st.session_id;
      if (!applyState(st) && !st.url) pollUntilSettled(st.session_id, 60_000);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "로그인 세션을 시작할 수 없습니다");
      setPhase("error");
    }
  };

  const submitCode = async () => {
    if (!session || !code.trim()) return;
    setPhase("verifying");
    setError("");
    try {
      const st = await api.post<ClaudeLoginState>(
        `/admin/settings/ai/claude-login/${session.session_id}/code`,
        { code: code.trim() },
      );
      if (!applyState(st)) pollUntilSettled(session.session_id, 150_000);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "코드 제출 실패");
      setPhase("error");
    }
  };

  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-slate-700">Claude 계정으로 로그인</p>
          <p className="text-xs text-slate-400">
            브라우저에서 구독 계정으로 로그인하면 1년 유효 토큰이 자동으로 입력됩니다 (API 키 불필요)
          </p>
        </div>
        {(phase === "idle" || phase === "error") && (
          <Button variant="secondary" onClick={start} write>
            {phase === "error" ? "다시 시도" : "로그인 시작"}
          </Button>
        )}
        {phase === "starting" && <span className="text-xs text-slate-400">준비 중...</span>}
      </div>

      {(phase === "awaiting" || phase === "verifying") && session?.url && (
        <div className="mt-3 space-y-2 border-t border-slate-200 pt-3">
          <div className="flex items-center gap-2 text-sm">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-slate-900 text-[11px] font-bold text-white">1</span>
            <a
              href={session.url}
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-sky-600 underline underline-offset-2 hover:text-sky-500"
            >
              Claude 로그인 페이지 열기 (새 탭)
            </a>
          </div>
          <div className="flex items-center gap-2">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-slate-900 text-[11px] font-bold text-white">2</span>
            <input
              className={`${inputCls} font-mono text-xs`}
              placeholder="로그인 후 표시되는 인증 코드 붙여넣기"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitCode();
              }}
              disabled={phase === "verifying"}
            />
            <Button className="shrink-0 whitespace-nowrap" onClick={submitCode} disabled={!code.trim() || phase === "verifying"} write>
              {phase === "verifying" ? "확인 중…" : "코드 제출"}
            </Button>
          </div>
        </div>
      )}

      {phase === "success" && (
        <p className="mt-2 rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
          로그인 성공 — 발급된 토큰(1년 유효)이 API 키 칸에 입력되었습니다. <b>저장</b>을 눌러 완료하세요.
        </p>
      )}
      {phase === "error" && error && (
        <div className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600">
          <p>{error}</p>
          {diagnostic && (
            <details className="mt-1.5">
              <summary className="cursor-pointer text-red-500/80">CLI 출력 보기</summary>
              <pre className="dark-scroll mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-white/70 p-2 font-mono text-[10.5px] leading-relaxed text-slate-600">
                {diagnostic}
              </pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
}


// ── 응시 환경 (게이미피케이션) ────────────────────────────────

/** 참고 자료 — 시험장 안에서 열리는 GitHub 앱의 가용 범위와 자격증명 */
function ReferenceCard() {
  const readOnly = useReadOnly();
  const [ref, setRef] = useState<ReferenceSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState("");
  const { toast } = useToast();

  useEffect(() => {
    api
      .get<ReferenceSettings>("/admin/settings/reference")
      .then(setRef)
      .catch(() => undefined);
  }, []);

  const save = async (patch: Partial<ReferenceSettings>, secrets: Record<string, string> = {}) => {
    if (!ref) return;
    setBusy(true);
    try {
      const next = await api.put<ReferenceSettings>("/admin/settings/reference", {
        github_enabled: ref.github_enabled,
        ...patch,
        ...secrets,
      });
      setRef(next);
      setToken("");
      toast("참고 자료 설정을 저장했습니다", "success");
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "저장 실패", "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="mt-8 p-6">
      <h2 className="font-bold">참고 자료</h2>
      <p className="mt-1 text-sm text-slate-500">
        응시자가 시험 데스크톱에서 열 수 있는 GitHub 앱입니다. 검색과 열람 기록은 응시 이벤트로 남아
        평가에 활용됩니다.
      </p>

      <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-xl border border-slate-200 p-4 transition hover:border-slate-300">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={Boolean(ref?.github_enabled)}
          {...writeProps(readOnly, !ref || busy)}
          onChange={(e) => save({ github_enabled: e.target.checked })}
        />
        <span className="min-w-0">
          <span className="text-sm font-semibold text-slate-800">GitHub 앱</span>
          <span className="mt-1 block text-xs text-slate-500">
            저장소 검색·코드 열람과 워크스페이스로의 git clone 을 허용합니다. github.com 외의 주소는
            열리지 않습니다.
          </span>
        </span>
      </label>

      <div className="mt-5">
        <Field
          label="GitHub 토큰 (선택)"
          hint={
            ref?.has_github_token
              ? `저장됨 ${ref.github_token_hint ?? ""} — 새 값을 넣으면 교체됩니다`
              : "없으면 비인증으로 조회합니다 (시간당 60회 제한). 응시자에게는 어떤 토큰이든 공개 저장소만 보이지만, 저장소 권한이 없는 fine-grained 토큰을 권장합니다."
          }
        >
          <div className="flex gap-2">
            <input
              className={inputCls}
              type="password"
              value={token}
              placeholder="ghp_…"
              onChange={(e) => setToken(e.target.value)}
            />
            <Button
              variant="secondary"
              disabled={busy || !token}
              write
              onClick={() => save({}, { github_token: token })}
            >
              저장
            </Button>
            {ref?.has_github_token && (
              <Button variant="ghost" disabled={busy} write onClick={() => save({}, { github_token: "" })}>
                삭제
              </Button>
            )}
          </div>
        </Field>
      </div>
    </Card>
  );
}

// ── 게스트 접속 ───────────────────────────────────────────────

/** 게스트 접속 — 열고 닫는 스위치, 남용 한도, 주소 차단.
 *
 *  스위치와 한도가 한 카드에 있는 이유: "켜기"와 "얼마나 허용할지"는 같은
 *  결정의 두 면이다. 켜는 화면과 한도를 정하는 화면이 떨어져 있으면 한도를
 *  보지 않은 채 켜게 된다.
 *
 *  저장 방식은 이 페이지의 관례를 따른다 — 체크박스는 즉시 저장(끄고 켜는 것은
 *  되돌리기 쉽다), 숫자는 다 입력한 뒤 [한도 저장](입력 중간값이 저장되면 안 된다).
 */
function GuestAccessCard() {
  const readOnly = useReadOnly();
  const [saved, setSaved] = useState<GuestPolicy | null>(null); // 서버에 저장된 값
  const [draft, setDraft] = useState<GuestPolicy | null>(null); // 편집 중인 값
  const [stats, setStats] = useState<GuestStats | null>(null);
  const [busy, setBusy] = useState(false);
  const { toast } = useToast();

  const loadStats = useCallback(() => {
    api.get<GuestStats>("/admin/access/guest/stats").then(setStats).catch(() => undefined);
  }, []);

  useEffect(() => {
    api
      .get<GuestPolicy>("/admin/access/guest")
      .then((p) => {
        setSaved(p);
        setDraft(p);
      })
      .catch(() => undefined);
    loadStats();
  }, [loadStats]);

  const put = async (next: GuestPolicy, message: string) => {
    setBusy(true);
    const prev = saved;
    setSaved(next);
    setDraft(next);
    try {
      const applied = await api.put<GuestPolicy>("/admin/access/guest", next);
      setSaved(applied);
      setDraft(applied); // 서버가 잘라낸 값(범위 밖 입력)이 화면에 그대로 보이게
      toast(message, "success");
      loadStats();
    } catch (e) {
      setSaved(prev);
      setDraft(prev);
      toast(e instanceof ApiError ? e.message : "저장 실패", "error");
    } finally {
      setBusy(false);
    }
  };

  const limitsDirty =
    !!saved &&
    !!draft &&
    (saved.max_new_per_hour_per_ip !== draft.max_new_per_hour_per_ip ||
      saved.chat_per_min !== draft.chat_per_min ||
      saved.chat_total_per_attempt !== draft.chat_total_per_attempt);

  // 범위는 입력하는 동안이 아니라 손을 뗄 때 맞춘다. 타이핑 중에 고치면
  // "120" 을 넣으려고 "1" 을 친 순간 최솟값으로 튀어 글자를 못 이어 붙인다.
  // (min/max 속성은 브라우저가 강제하지 않는다 — 서버는 범위 밖을 422 로 거절하므로
  //  화면에서 먼저 맞춰 두지 않으면 사용자는 원인 모를 저장 실패만 본다.)
  const clamp = (key: keyof GuestPolicy, min: number, max: number) => {
    if (!draft) return;
    const raw = Number(draft[key]);
    const fixed = Number.isFinite(raw) ? Math.min(max, Math.max(min, Math.round(raw))) : min;
    if (fixed !== draft[key]) setDraft({ ...draft, [key]: fixed });
  };

  const num = (key: keyof GuestPolicy, label: string, hint: string, min: number, max: number) => (
    <Field label={label} hint={hint}>
      <input
        className={inputCls}
        type="number"
        min={min}
        max={max}
        disabled={!draft || busy}
        value={draft ? String(draft[key]) : ""}
        onChange={(e) => draft && setDraft({ ...draft, [key]: Number(e.target.value) })}
        onBlur={() => clamp(key, min, max)}
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          clamp(key, min, max);
          if (draft && limitsDirty) put(draft, "게스트 한도를 저장했습니다");
        }}
      />
    </Field>
  );

  return (
    <Card className="mt-8 p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="font-bold">게스트 접속</h2>
          <p className="mt-1 text-sm text-slate-500">
            계정 없이 로그인 화면에서 바로 응시하게 합니다. 게스트는 관리자 메뉴에 들어올 수 없고, 열려 있는
            모든 시험에 응시할 수 있습니다.
          </p>
        </div>
        {stats && (
          <p className="shrink-0 pt-1 text-xs text-slate-400">
            전체 {stats.total} · 활성 {stats.active} · 최근 24시간 {stats.last_24h}
          </p>
        )}
      </div>

      <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-xl border border-slate-200 p-4 transition hover:border-slate-300">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={Boolean(saved?.enabled)}
          {...writeProps(readOnly, !saved || busy)}
          onChange={(e) =>
            saved && put({ ...saved, enabled: e.target.checked }, e.target.checked ? "게스트 접속을 켰습니다" : "게스트 접속을 껐습니다")
          }
        />
        <span className="min-w-0">
          <span className="flex items-center gap-2">
            <span className="text-sm font-semibold text-slate-800">게스트 로그인 허용</span>
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800">
              계정 없이 응시
            </span>
          </span>
          <span className="mt-1 block text-xs text-slate-500">
            켜면 로그인 화면에 [게스트로 둘러보기] 버튼이 나타납니다. 끄면 버튼이 사라지고 새 게스트도 받지
            않지만, 이미 들어온 게스트의 세션은 유지됩니다 — 즉시 끊으려면 [사용자] 화면에서 그 계정을
            정지하세요. (기본: 꺼짐)
          </span>
        </span>
      </label>

      <label className="mt-3 flex cursor-pointer items-start gap-3 rounded-xl border border-slate-200 p-4 transition hover:border-slate-300">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={Boolean(saved?.admin_demo_enabled)}
          {...writeProps(readOnly, !saved || busy)}
          onChange={(e) =>
            saved &&
            put(
              { ...saved, admin_demo_enabled: e.target.checked },
              e.target.checked ? "관리 화면 둘러보기를 켰습니다" : "관리 화면 둘러보기를 껐습니다",
            )
          }
        />
        <span className="min-w-0">
          <span className="flex items-center gap-2">
            <span className="text-sm font-semibold text-slate-800">관리 화면 둘러보기 허용</span>
            <span className="rounded-full bg-sky-100 px-2 py-0.5 text-[11px] font-semibold text-sky-800">
              읽기 전용
            </span>
          </span>
          <span className="mt-1 block text-xs text-slate-500">
            켜면 로그인 화면에 [관리자 기능 살펴보기] 버튼이 나타납니다. 들어온 사람은 관리 화면을 관리자와
            같은 모습으로 보지만 아무것도 바꿀 수 없고, 응시자 화면과 사무실에는 들어가지 못하며, 다른
            사람의 이메일은 가려집니다. (기본: 꺼짐)
          </span>
        </span>
      </label>


      <div className="mt-4 grid gap-4 sm:grid-cols-3">
        {num("max_new_per_hour_per_ip", "주소당 시간당 생성", "0 이면 새 게스트를 받지 않습니다", 0, 1000)}
        {num("chat_per_min", "분당 대화 수", "순간적인 폭주를 막습니다", 1, 120)}
        {num("chat_total_per_attempt", "응시당 대화 총량", "0 이면 총량 제한 없음", 0, 100000)}
      </div>
      <div className="mt-2 flex items-center justify-between gap-4">
        <p className="text-xs text-slate-400">
          대화 한도는 메신저(NPC)와 AI 에이전트를 합쳐서 셉니다 — 한쪽만 막으면 다른 쪽으로 흘러갑니다.
          응시자 화면에도 이 합산 값이 남은 수로 보입니다. 시간당 생성은 한 인터넷 회선에서 동시에 들어올 수
          있는 인원이기도 합니다 — 한 자리에 여럿이 모여 쓴다면 인원만큼 올리세요.
        </p>
        {/* 라벨은 고정한다 — 비활성 상태가 이미 '저장할 것이 없다'를 말한다.
            버튼 글자가 상태에 따라 바뀌면 누를 것을 찾는 눈이 한 번 더 멈춘다. */}
        <Button onClick={() => draft && put(draft, "게스트 한도를 저장했습니다")} disabled={!limitsDirty || busy} write>
          {busy ? "저장 중..." : "한도 저장"}
        </Button>
      </div>
    </Card>
  );
}

/** 주소 차단 — 계정 정지의 짝. 정지시킨 게스트가 새 계정으로 돌아오는 것을 막는다. */
function IpBlockSection() {
  const [rows, setRows] = useState<BlockedIp[] | null>(null);
  const [cidr, setCidr] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const { toast, confirm } = useToast();

  const load = useCallback(() => {
    api.get<BlockedIp[]>("/admin/access/ip-blocks").then(setRows).catch(() => undefined);
  }, []);

  useEffect(load, [load]);

  const add = async () => {
    if (!cidr.trim()) return;
    setBusy(true);
    try {
      await api.post("/admin/access/ip-blocks", { cidr: cidr.trim(), reason: reason.trim() });
      setCidr("");
      setReason("");
      load();
      toast("주소를 차단했습니다", "success");
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "차단 실패", "error");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (b: BlockedIp) => {
    if (!(await confirm({ title: "차단을 해제할까요?", message: b.cidr, confirmLabel: "해제" }))) return;
    await api.del(`/admin/access/ip-blocks/${b.id}`);
    load();
  };

  return (
    <Card className="mt-8 p-6">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-bold">주소 차단</h2>
        {rows && rows.length > 0 && (
          <span className="text-xs text-slate-400">차단 중 {rows.length}건</span>
        )}
      </div>
      <Collapsible summary="차단하면 어떻게 되는지">
        차단된 주소에서는 로그인도 게스트 접속도 되지 않고, 그 주소에서 열려 있던 세션은 차단하는 즉시
        끊깁니다. 관리자 계정은 차단의 영향을 받지 않습니다 — 자기 대역을 잘못 넣어도 들어와서 풀 수 있게.
      </Collapsible>

      {/* 넣는 칸이 주인공이다 — 주소 칸을 넓게, 사유는 그다음, 버튼은 칸 높이에 맞춘다 */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-72 shrink-0">
          <Field label="주소 또는 대역" hint="한 대역을 막으면 그 안의 모든 주소가 막힙니다">
            <input
              className={`${inputCls} font-mono`}
              value={cidr}
              onChange={(e) => setCidr(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && add()}
              placeholder="203.0.113.7 또는 203.0.113.0/24"
            />
          </Field>
        </div>
        <div className="min-w-56 flex-1">
          <Field label="사유 (선택)" hint="나중에 왜 막았는지 알아볼 수 있게">
            <input
              className={inputCls}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && add()}
              placeholder="예: 게스트 계정 반복 생성"
            />
          </Field>
        </div>
        <div className="pb-[22px]">
          <Button onClick={add} disabled={busy || !cidr.trim()} write>
            {busy ? "차단 중..." : "차단"}
          </Button>
        </div>
      </div>

      {rows && rows.length > 0 && (
        <div className="mt-4">
          <DataTable
            rows={rows}
            rowKey={(b) => b.id}
            empty="차단된 주소가 없습니다."
            columns={[
              {
                key: "cidr",
                header: "주소 / 대역",
                render: (b) => <span className="font-mono text-sm font-medium">{b.cidr}</span>,
              },
              { key: "reason", header: "사유", className: "text-slate-500", render: (b) => b.reason || "—" },
              {
                key: "created",
                header: "차단일",
                className: "text-slate-500",
                render: (b) => fmtDateTime(b.created_at),
              },
            ]}
            actions={(b) => (
              <IconButton title="차단 해제" tone="danger" write onClick={() => remove(b)}>
                <IconDelete />
              </IconButton>
            )}
          />
        </div>
      )}
    </Card>
  );
}

function ExamExperienceCard() {
  const readOnly = useReadOnly();
  const [ui, setUi] = useState<UiSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    api.get<UiSettings>("/admin/settings/ui").then(setUi).catch(() => undefined);
  }, []);

  const update = async (next: UiSettings) => {
    setBusy(true);
    const prev = ui;
    setUi(next);
    try {
      setUi(await api.put<UiSettings>("/admin/settings/ui", next));
      toast("응시 환경 설정을 저장했습니다", "success");
    } catch (e) {
      setUi(prev);
      toast(e instanceof ApiError ? e.message : "저장 실패", "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="mt-8 p-6">
      <h2 className="font-bold">응시 환경</h2>
      <p className="mt-1 text-sm text-slate-500">응시자가 보는 시험 화면의 연출을 조정합니다.</p>

      <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-xl border border-slate-200 p-4 transition hover:border-slate-300">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={Boolean(ui?.gamified_intro)}
          {...writeProps(readOnly, !ui || busy)}
          onChange={(e) => ui && update({ ...ui, gamified_intro: e.target.checked })}
        />
        <span className="min-w-0">
          <span className="flex items-center gap-2">
            <span className="text-sm font-semibold text-slate-800">시네마틱 인트로</span>
            <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[11px] font-semibold text-violet-700">
              게이미피케이션
            </span>
          </span>
          <span className="mt-1 block text-xs text-slate-500">
            문제를 시작할 때 검은 화면에서 도입부를 한 문단씩 타이핑해 보여주고, 낭독이 끝나면 시작 버튼이
            나타납니다. 끄면 지금처럼 카드 형태로 한 번에 보여줍니다. (기본: 꺼짐)
          </span>
        </span>
      </label>
    </Card>
  );
}

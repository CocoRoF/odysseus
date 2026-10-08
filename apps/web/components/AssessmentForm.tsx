"use client";

import { useEffect, useMemo, useState } from "react";
import { MAX_COLLEAGUES, MAX_SCENARIOS_PER_ASSESSMENT } from "@/lib/assessment-limits";
import { useRouter } from "next/navigation";
import { api, ApiError } from "@/lib/api";
import type { AiProviderRow, Assessment, OfficeBuiltin, OfficePreset, ScenarioSummary, User } from "@/lib/types";
import { SCENES, SCENE_IDS } from "@/components/office/scenes";
import { DIFFICULTY_LABEL, fmtDateTime } from "@/lib/format";
import { useToast } from "@/components/toast";
import { Badge, Button, Card, Field, inputCls, SearchInput } from "@/components/ui";
import { CATEGORIES, UNCATEGORIZED_LABEL } from "@/lib/categories";
import { useReadOnly, writeProps } from "@/components/readonly";

interface ScenarioPick {
  scenario_id: string;
  title: string;
  difficulty: string;
  points: number;
}

/** 서버 시각(UTC ISO)을 datetime-local 칸 값(이 PC 시간대의 YYYY-MM-DDTHH:mm)으로 바꾼다.
 *  UTC 문자열을 잘라 넣으면 저장할 때마다 시간대만큼 밀린다. */
function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 시험 생성/편집 — 시나리오 구성 + 응시자 배정 + LLM 공급자 지정 */
export function AssessmentForm({ initial, assessmentId }: { initial?: Assessment; assessmentId?: string }) {
  const router = useRouter();
  const { toast, confirm } = useToast();
  const readOnly = useReadOnly();

  const [title, setTitle] = useState(initial?.title ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [category, setCategory] = useState(initial?.category ?? "");
  const [label, setLabel] = useState(initial?.label ?? "");
  const [officePreset, setOfficePreset] = useState(initial?.office_preset ?? "");
  const [officePresets, setOfficePresets] = useState<OfficePreset[]>([]);
  /** 고친 템플릿 — 이름이 바뀌었으면 그 이름으로 보인다 */
  const [officeBuiltins, setOfficeBuiltins] = useState<OfficeBuiltin[]>([]);
  const [durationMin, setDurationMin] = useState(initial?.duration_min ?? 120);
  const [agentMaxTurns, setAgentMaxTurns] = useState(initial?.agent_max_turns ?? 30);
  const [messengerMax, setMessengerMax] = useState(initial?.messenger_max_per_attempt ?? 0);
  const [npcProviderId, setNpcProviderId] = useState(initial?.npc_provider_id ?? "");
  const [agentProviderId, setAgentProviderId] = useState(initial?.agent_provider_id ?? "");
  const [startsAt, setStartsAt] = useState(toLocalInput(initial?.starts_at));
  const [endsAt, setEndsAt] = useState(toLocalInput(initial?.ends_at));
  const [picked, setPicked] = useState<ScenarioPick[]>(
    initial?.scenarios.map((s) => ({
      scenario_id: s.scenario_id,
      title: s.title,
      difficulty: s.difficulty,
      points: s.points,
    })) ?? [],
  );
  const [assignees, setAssignees] = useState<Set<string>>(
    new Set(initial?.assignments.map((a) => a.user_id) ?? []),
  );

  const [scenarios, setScenarios] = useState<ScenarioSummary[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [providers, setProviders] = useState<AiProviderRow[]>([]);
  const [scenarioQ, setScenarioQ] = useState("");
  const [userQ, setUserQ] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get<ScenarioSummary[]>("/scenarios").then((rows) => setScenarios(rows.filter((r) => !r.is_archived)));
    api.get<User[]>("/admin/users").then(setUsers);
    api.get<AiProviderRow[]>("/admin/settings/ai/providers").then((rows) => setProviders(rows.filter((r) => r.enabled)));
    api.get<OfficePreset[]>("/admin/office/presets").then(setOfficePresets).catch(() => setOfficePresets([]));
    api.get<OfficeBuiltin[]>("/admin/office/builtins").then(setOfficeBuiltins).catch(() => {});
  }, []);

  const filteredScenarios = useMemo(() => {
    const query = scenarioQ.trim().toLowerCase();
    const pickedIds = new Set(picked.map((p) => p.scenario_id));
    return scenarios.filter(
      (s) => !pickedIds.has(s.id) && (!query || s.title.toLowerCase().includes(query)),
    );
  }, [scenarios, scenarioQ, picked]);

  const filteredUsers = useMemo(() => {
    const query = userQ.trim().toLowerCase();
    return users.filter(
      (u) =>
        u.role === "candidate" &&
        (!query || u.name.toLowerCase().includes(query) || u.email.toLowerCase().includes(query)),
    );
  }, [users, userQ]);

  const save = async () => {
    if (!title.trim()) return toast("시험 제목을 입력하세요", "info");
    if (picked.length === 0) return toast("시나리오를 1개 이상 선택하세요", "info");
    if (picked.length > MAX_SCENARIOS_PER_ASSESSMENT) {
      return toast(`시나리오는 ${MAX_SCENARIOS_PER_ASSESSMENT}개까지 넣을 수 있습니다 — 하나를 제거하세요`, "info");
    }
    setBusy(true);
    const body = {
      title: title.trim(),
      description,
      category,
      office_preset: officePreset,
      duration_min: durationMin,
      agent_max_turns: agentMaxTurns,
      messenger_max_per_attempt: messengerMax,
      npc_provider_id: npcProviderId || null,
      agent_provider_id: agentProviderId || null,
      starts_at: startsAt ? new Date(startsAt).toISOString() : null,
      ends_at: endsAt ? new Date(endsAt).toISOString() : null,
      label,
      scenarios: picked.map((p) => ({ scenario_id: p.scenario_id, points: p.points })),
      assignee_ids: Array.from(assignees),
    };
    try {
      if (assessmentId) await api.put(`/assessments/${assessmentId}`, body);
      else await api.post("/assessments", body);
      router.push("/admin/assessments");
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "저장 실패", "error");
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!assessmentId) return;
    if (!(await confirm({ title: "시험을 삭제할까요?", message: "응시 기록도 함께 삭제됩니다.", danger: true, confirmLabel: "삭제" }))) return;
    await api.del(`/assessments/${assessmentId}`);
    router.push("/admin/assessments");
  };

  const providerSelect = (value: string, onChange: (v: string) => void) => (
    <select className={inputCls} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">기본 채팅 공급자 사용</option>
      {providers.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name} — {p.model}
        </option>
      ))}
    </select>
  );

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-bold">{assessmentId ? "시험 편집" : "새 시험"}</h1>
        <div className="flex items-center gap-2">
          {/* 되돌릴 수 없는 버튼은 저장 옆에 붙이지 않는다 */}
          {assessmentId && (
            <>
              <Button variant="danger" onClick={remove} write>
                삭제
              </Button>
              <span className="mx-2 h-6 w-px bg-slate-200" aria-hidden="true" />
            </>
          )}
          <Button variant="secondary" onClick={() => router.push("/admin/assessments")}>
            취소
          </Button>
          <Button onClick={save} disabled={busy} write>
            {busy ? "저장 중..." : "저장"}
          </Button>
        </div>
      </div>

      <div className="space-y-6">
        <Card className="space-y-4 p-6">
          <h2 className="font-bold">기본 정보</h2>
          <Field label="시험 제목">
            <input className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="예: 2026 하반기 백엔드 실무 시뮬레이션" />
          </Field>
          <Field label="설명 (응시자에게 표시)">
            <textarea className={`${inputCls} min-h-20`} value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
          <Field label="분야" hint="응시자 화면의 버튼 필터가 이 값으로 시험을 묶습니다">
            <select className={inputCls} value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">{UNCATEGORIZED_LABEL}</option>
              {CATEGORIES.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="꼬리표" hint="같은 분야 안에서 이 시험을 가르는 한두 단어 — 화면에 '분야 [꼬리표]' 로 붙습니다 (예: 초급, 갈등 중재, 쿠버네티스)">
            <input className={inputCls} value={label} maxLength={40} placeholder="예: 초급" onChange={(e) => setLabel(e.target.value)} />
          </Field>
          <Field label="사무실 장면" hint="응시자 사무실에서 이 시험의 방 모양. 자동이면 분야별 기본 장면(관리자 › 사무실)을 따릅니다">
            <select className={inputCls} value={officePreset} onChange={(e) => setOfficePreset(e.target.value)}>
              <option value="">자동 (분야별 기본 장면)</option>
              {SCENE_IDS.map((id) => (
                <option key={id} value={`builtin:${id}`}>템플릿 · {officeBuiltins.find((b) => b.id === id)?.name || SCENES[id].label}</option>
              ))}
              {officePresets.map((p) => (
                <option key={p.id} value={p.id}>내 프리셋 · {p.name}</option>
              ))}
            </select>
          </Field>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="제한시간 (분)">
              <input className={inputCls} type="number" min={5} max={600} value={durationMin} onChange={(e) => setDurationMin(Number(e.target.value))} />
            </Field>
            <Field label="에이전트 질문 한도" hint="0이면 에이전트를 쓰지 않습니다">
              <input className={inputCls} type="number" min={0} max={500} value={agentMaxTurns} onChange={(e) => setAgentMaxTurns(Number(e.target.value))} />
            </Field>
            <Field label="메신저 질문 한도" hint="동료에게 보낼 수 있는 총량. 0이면 기본값">
              <input className={inputCls} type="number" min={0} max={2000} value={messengerMax} onChange={(e) => setMessengerMax(Number(e.target.value))} />
            </Field>
          </div>
          {/* 기간은 둘이 한 쌍이라 따로 묶는다. 브라우저의 날짜 칸은 영어 형식(mm/dd/yyyy)으로 보이므로
              고른 값을 우리 말로 한 번 더 적어 준다 — 잘못 넣으면 응시가 아예 열리지 않는 칸이다. */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="응시 시작 가능" hint={startsAt ? fmtDateTime(startsAt) : "비워 두면 지금부터"}>
              <input className={inputCls} type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
            </Field>
            <Field label="응시 마감" hint={endsAt ? fmtDateTime(endsAt) : "비워 두면 마감 없음"}>
              <input className={inputCls} type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />
            </Field>
          </div>
        </Card>

        <Card className="space-y-4 p-6">
          <h2 className="font-bold">LLM 공급자</h2>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Field label="등장인물(NPC) 공급자" hint="메신저 관계자들의 대화 품질을 좌우합니다">
              {providerSelect(npcProviderId, setNpcProviderId)}
            </Field>
            <Field label="AI 에이전트 공급자" hint="응시자가 사용하는 에이전트">
              {providerSelect(agentProviderId, setAgentProviderId)}
              {(() => {
                const picked = providers.find((p) => p.id === agentProviderId);
                const chatOnly = picked ? picked.supports_host_tools === false : false;
                if (!picked) return null;
                if (picked.provider === "claude_code_cli") {
                  return (
                    <p className="mt-1.5 rounded-lg bg-sky-50 px-2.5 py-1.5 text-xs text-sky-700">
                      Claude Code는 CLI 내장 도구가 전부 차단된 상태로, 워크스페이스 도구만 <b>MCP 브리지</b>로
                      제공됩니다 — 다른 공급자와 동일한 파일 조작 능력을 갖습니다.
                    </p>
                  );
                }
                return chatOnly ? (
                  <p className="mt-1.5 rounded-lg bg-amber-50 px-2.5 py-1.5 text-xs text-amber-700">
                    이 공급자는 도구 호출을 지원하지 않아 에이전트가 <b>대화 전용</b>으로 동작합니다 — 파일을
                    직접 찾거나 만들 수 없습니다.
                  </p>
                ) : null;
              })()}
            </Field>
          </div>
        </Card>

        <Card className="space-y-4 p-6">
          <div className="flex items-center justify-between">
            <div className="flex items-baseline gap-2">
              <h2 className="font-bold">시나리오 구성</h2>
              <span className="text-xs text-slate-400">
                최대 {MAX_SCENARIOS_PER_ASSESSMENT}개 · 사무실 방에는 {MAX_COLLEAGUES}명까지 섭니다
              </span>
            </div>
            <SearchInput value={scenarioQ} onChange={setScenarioQ} placeholder="시나리오 검색..." />
          </div>
          {picked.length > MAX_SCENARIOS_PER_ASSESSMENT && (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
              이 시험에는 시나리오가 {picked.length}개 있습니다. 저장하려면 {MAX_SCENARIOS_PER_ASSESSMENT}개까지 줄이세요 —
              인물이 모두 한 방에 서면 서로를 가립니다.
            </p>
          )}
          {picked.length > 0 && (
            <div className="space-y-2">
              {picked.map((p, i) => (
                <div key={p.scenario_id} className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-2.5">
                  <span className="w-6 text-center text-sm font-bold text-slate-400">{i + 1}</span>
                  <span className="min-w-0 flex-1 truncate font-medium">{p.title}</span>
                  <Badge value={p.difficulty} label={DIFFICULTY_LABEL[p.difficulty]} />
                  <label className="flex items-center gap-1.5 text-xs text-slate-500">
                    배점
                    <input
                      className="w-20 rounded-lg border border-slate-300 px-2 py-1 text-sm"
                      type="number"
                      min={0}
                      max={1000}
                      value={p.points}
                      onChange={(e) =>
                        setPicked((arr) => arr.map((x) => (x.scenario_id === p.scenario_id ? { ...x, points: Number(e.target.value) } : x)))
                      }
                    />
                  </label>
                  <button
                    onClick={() => setPicked((arr) => arr.filter((x) => x.scenario_id !== p.scenario_id))}
                    {...writeProps(readOnly)}
                    className="shrink-0 whitespace-nowrap rounded-lg border border-slate-200 px-2 py-1 text-xs text-slate-500 transition hover:border-red-300 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    제거
                  </button>
                </div>
              ))}
            </div>
          )}
          <p className="text-xs text-slate-400">시험은 상황 하나입니다. 아래에서 누르면 그 시나리오가 이 시험이 됩니다.</p>
          <div className="dark-scroll max-h-52 space-y-1 overflow-y-auto rounded-xl border border-slate-200 p-2">
            {filteredScenarios.length === 0 && <p className="p-2 text-xs text-slate-400">고를 시나리오가 없습니다</p>}
            {filteredScenarios.map((s) => (
              <button
                key={s.id}
                // 시험은 시나리오 하나 — 고르면 앞의 것을 바꾼다
                onClick={() => setPicked([{ scenario_id: s.id, title: s.title, difficulty: s.difficulty, points: 100 }])}
                {...writeProps(readOnly)}
                className="group flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <span className="shrink-0 text-slate-300 transition group-hover:text-slate-600">+</span>
                <span className="min-w-0 flex-1 truncate">{s.title}</span>
                <Badge value={s.difficulty} label={DIFFICULTY_LABEL[s.difficulty]} />
                <span className="text-xs text-slate-400">인물 {s.character_count} · 체크 {s.check_count}</span>
              </button>
            ))}
          </div>
        </Card>

        <Card className="space-y-4 p-6">
          <div className="flex items-center justify-between">
            <h2 className="font-bold">
              응시자 배정 <span className="text-sm font-normal text-slate-400">({assignees.size}명)</span>
            </h2>
            <SearchInput value={userQ} onChange={setUserQ} placeholder="이름/이메일 검색..." />
          </div>
          <div className="dark-scroll max-h-60 space-y-0.5 overflow-y-auto rounded-xl border border-slate-200 p-2">
            {filteredUsers.map((u) => (
              <label key={u.id} className="flex cursor-pointer items-center gap-2.5 rounded-lg px-3 py-1.5 text-sm hover:bg-slate-50">
                <input
                  type="checkbox"
                  {...writeProps(readOnly)}
                  checked={assignees.has(u.id)}
                  onChange={(e) =>
                    setAssignees((s) => {
                      const n = new Set(s);
                      if (e.target.checked) n.add(u.id);
                      else n.delete(u.id);
                      return n;
                    })
                  }
                />
                <span className="font-medium">{u.name}</span>
                <span className="text-xs text-slate-400">{u.email}</span>
              </label>
            ))}
            {filteredUsers.length === 0 && <p className="p-2 text-xs text-slate-400">응시자 계정이 없습니다</p>}
          </div>
          {assignees.size === 0 && (
            <p className="text-xs text-slate-400">
              아무도 배정하지 않으면 이 시험은 배정 목록에 뜨지 않습니다. 게스트에게는 열려 있는 모든 시험이 보입니다.
            </p>
          )}
        </Card>
      </div>
    </div>
  );
}

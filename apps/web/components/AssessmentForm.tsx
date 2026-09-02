"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { api, ApiError } from "@/lib/api";
import type { AiProviderRow, Assessment, ScenarioSummary, User } from "@/lib/types";
import { DIFFICULTY_LABEL } from "@/lib/format";
import { useToast } from "@/components/toast";
import { Badge, Button, Card, Field, inputCls, SearchInput } from "@/components/ui";

interface ScenarioPick {
  scenario_id: string;
  title: string;
  difficulty: string;
  points: number;
}

/** 시험 생성/편집 — 시나리오 구성 + 응시자 배정 + LLM 공급자 지정 */
export function AssessmentForm({ initial, assessmentId }: { initial?: Assessment; assessmentId?: string }) {
  const router = useRouter();
  const { toast, confirm } = useToast();

  const [title, setTitle] = useState(initial?.title ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [durationMin, setDurationMin] = useState(initial?.duration_min ?? 120);
  const [agentMaxTurns, setAgentMaxTurns] = useState(initial?.agent_max_turns ?? 30);
  const [npcProviderId, setNpcProviderId] = useState(initial?.npc_provider_id ?? "");
  const [agentProviderId, setAgentProviderId] = useState(initial?.agent_provider_id ?? "");
  const [startsAt, setStartsAt] = useState(initial?.starts_at?.slice(0, 16) ?? "");
  const [endsAt, setEndsAt] = useState(initial?.ends_at?.slice(0, 16) ?? "");
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
    setBusy(true);
    const body = {
      title: title.trim(),
      description,
      duration_min: durationMin,
      agent_max_turns: agentMaxTurns,
      npc_provider_id: npcProviderId || null,
      agent_provider_id: agentProviderId || null,
      starts_at: startsAt ? new Date(startsAt).toISOString() : null,
      ends_at: endsAt ? new Date(endsAt).toISOString() : null,
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
          {assessmentId && (
            <Button variant="danger" onClick={remove}>
              삭제
            </Button>
          )}
          <Button variant="secondary" onClick={() => router.push("/admin/assessments")}>
            취소
          </Button>
          <Button onClick={save} disabled={busy}>
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
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <Field label="제한시간 (분)">
              <input className={inputCls} type="number" min={5} max={600} value={durationMin} onChange={(e) => setDurationMin(Number(e.target.value))} />
            </Field>
            <Field label="에이전트 질문 한도" hint="0 = 에이전트 비활성">
              <input className={inputCls} type="number" min={0} max={500} value={agentMaxTurns} onChange={(e) => setAgentMaxTurns(Number(e.target.value))} />
            </Field>
            <Field label="응시 시작 가능">
              <input className={inputCls} type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
            </Field>
            <Field label="응시 마감">
              <input className={inputCls} type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />
            </Field>
          </div>
        </Card>

        <Card className="space-y-4 border-violet-200 bg-violet-50/40 p-6">
          <h2 className="font-bold text-violet-800">LLM 공급자</h2>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Field label="등장인물(NPC) 공급자" hint="메신저 관계자들의 대화 품질을 좌우합니다">
              {providerSelect(npcProviderId, setNpcProviderId)}
            </Field>
            <Field label="AI 에이전트 공급자" hint="응시자가 사용하는 에이전트">
              {providerSelect(agentProviderId, setAgentProviderId)}
              {(() => {
                const picked = providers.find((p) => p.id === agentProviderId);
                const chatOnly = picked ? picked.supports_host_tools === false : false;
                return chatOnly ? (
                  <p className="mt-1.5 rounded-lg bg-amber-50 px-2.5 py-1.5 text-xs text-amber-700">
                    이 공급자는 도구 호출을 지원하지 않아 에이전트가 <b>대화 전용</b>으로 동작합니다 — 파일을
                    직접 찾거나 만들 수 없습니다. 파일 조작이 필요하면 도구를 지원하는 공급자를 지정하세요.
                  </p>
                ) : null;
              })()}
            </Field>
          </div>
        </Card>

        <Card className="space-y-4 p-6">
          <div className="flex items-center justify-between">
            <h2 className="font-bold">시나리오 구성</h2>
            <SearchInput value={scenarioQ} onChange={setScenarioQ} placeholder="시나리오 검색..." />
          </div>
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
                    className="text-xs text-red-400 hover:text-red-600"
                  >
                    제거
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="dark-scroll max-h-52 space-y-1 overflow-y-auto rounded-xl border border-slate-200 p-2">
            {filteredScenarios.length === 0 && <p className="p-2 text-xs text-slate-400">추가할 시나리오가 없습니다</p>}
            {filteredScenarios.map((s) => (
              <button
                key={s.id}
                onClick={() => setPicked((arr) => [...arr, { scenario_id: s.id, title: s.title, difficulty: s.difficulty, points: 100 }])}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-slate-50"
              >
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
        </Card>
      </div>
    </div>
  );
}

"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { api, ApiError } from "@/lib/api";
import type { AuthorOp, Character, Check, CheckType, InitialFile, OpeningMessage, Rubric, Scenario, ScenarioDraft } from "@/lib/types";
import { ScenarioAuthorChat } from "@/components/ScenarioAuthorChat";
import { CodeEditor } from "@/components/CodeEditor";
import { Markdown } from "@/components/Markdown";
import { useToast } from "@/components/toast";
import { Button, Card, Field, inputCls } from "@/components/ui";
import { IconAdd, IconDelete } from "@/components/icons";

const TABS = [
  { key: "basic", label: "기본 정보" },
  { key: "characters", label: "등장인물" },
  { key: "opening", label: "오프닝 메시지" },
  { key: "files", label: "초기 파일" },
  { key: "grading", label: "정답 · 평가" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

const COLORS = ["#8b5cf6", "#0ea5e9", "#f59e0b", "#10b981", "#ef4444", "#ec4899", "#6366f1", "#14b8a6"];

const emptyCharacter = (n: number): Character => ({
  key: `person_${n}`,
  name: "",
  role: "",
  color: COLORS[n % COLORS.length],
  persona: "",
  knowledge: "",
});

const CHECK_TYPE_LABEL: Record<CheckType, string> = {
  file_exists: "파일 존재",
  file_contains: "파일 내용 (정규식)",
  command: "명령 실행",
};

function langOf(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return (
    { py: "python", md: "markdown", json: "json", csv: "plaintext", js: "javascript", ts: "typescript", sh: "shell" }[
      ext
    ] ?? "plaintext"
  );
}

/** 시나리오 스튜디오 — '문제 상황' 전체(인물·정보 분포·초기 상태·정답 기준)를 설계하는 편집기. */
export function ScenarioStudio({ initial, scenarioId }: { initial?: Scenario; scenarioId?: string }) {
  const router = useRouter();
  const { toast, confirm } = useToast();
  const [tab, setTab] = useState<TabKey>("basic");
  const [busy, setBusy] = useState(false);

  const [title, setTitle] = useState(initial?.title ?? "");
  const [summary, setSummary] = useState(initial?.summary ?? "");
  const [difficulty, setDifficulty] = useState(initial?.difficulty ?? "medium");
  const [briefing, setBriefing] = useState(initial?.briefing_md ?? "");
  const [briefingPreview, setBriefingPreview] = useState(false);
  const [agentEnabled, setAgentEnabled] = useState(initial?.agent_enabled ?? true);
  const [characters, setCharacters] = useState<Character[]>(initial?.characters ?? []);
  const [opening, setOpening] = useState<OpeningMessage[]>(initial?.opening_messages ?? []);
  const [files, setFiles] = useState<InitialFile[]>(initial?.initial_files ?? []);
  const [activeFile, setActiveFile] = useState<string | null>(initial?.initial_files?.[0]?.path ?? null);
  const [objectives, setObjectives] = useState(initial?.objectives_md ?? "");
  const [checks, setChecks] = useState<Check[]>(initial?.checks ?? []);
  const [rubric, setRubric] = useState<Rubric | null>(initial?.rubric ?? null);
  // AI 가 지금 고치는 필드 — 키별 마지막 편집 시각. 잠깐 빛나고 꺼진다.
  const [editing, setEditing] = useState<Record<string, number>>({});
  const [aiBusy, setAiBusy] = useState(false);
  const hl = (key: string) => (editing[key] ? "ai-editing" : "");
  const mark = (...keys: string[]) => {
    const now = Date.now();
    setEditing((m) => ({ ...m, ...Object.fromEntries(keys.map((k) => [k, now])) }));
  };
  useEffect(() => {
    if (Object.keys(editing).length === 0) return;
    const t = setInterval(() => {
      const cutoff = Date.now() - 2200;
      setEditing((m) => {
        const next = Object.fromEntries(Object.entries(m).filter(([, ts]) => ts > cutoff));
        return Object.keys(next).length === Object.keys(m).length ? m : next;
      });
    }, 400);
    return () => clearInterval(t);
  }, [editing]);

  useEffect(() => {
    if (!rubric) api.get<Rubric>("/scenarios/rubric-default").then(setRubric);
  }, [rubric]);

  const activeFileObj = useMemo(() => files.find((f) => f.path === activeFile) ?? null, [files, activeFile]);

  // AI 작성 패널이 폼 전체를 읽고 쓰는 통로
  const getDraft = (): ScenarioDraft => ({
    title, summary, difficulty, briefing_md: briefing, characters, opening_messages: opening,
    initial_files: files, objectives_md: objectives, checks, rubric, agent_enabled: agentEnabled,
  });
  const applyDraft = (d: ScenarioDraft) => {
    setTitle(d.title); setSummary(d.summary); setDifficulty(d.difficulty); setBriefing(d.briefing_md);
    setCharacters(d.characters); setOpening(d.opening_messages); setFiles(d.initial_files);
    setActiveFile(d.initial_files[0]?.path ?? null); setObjectives(d.objectives_md); setChecks(d.checks);
    setRubric(d.rubric); setAgentEnabled(d.agent_enabled);
  };
  const hasContent = Boolean(title.trim() || characters.length || files.length || objectives.trim());

  /** AI 편집 명령 하나를 즉시 반영한다 — 어느 탭의 무엇이 바뀌는지 보이게 */
  const applyOp = (op: AuthorOp) => {
    switch (op.op) {
      case "set": {
        const v = op.value;
        if (op.field === "title") setTitle(String(v));
        else if (op.field === "summary") setSummary(String(v));
        else if (op.field === "difficulty") setDifficulty(String(v));
        else if (op.field === "briefing_md") setBriefing(String(v));
        else if (op.field === "objectives_md") setObjectives(String(v));
        else if (op.field === "agent_enabled") setAgentEnabled(Boolean(v));
        mark(op.field);
        setTab(op.field === "objectives_md" ? "grading" : "basic");
        return;
      }
      case "upsert_character":
        setCharacters((arr) =>
          arr.some((c) => c.key === op.value.key) ? arr.map((c) => (c.key === op.value.key ? op.value : c)) : [...arr, op.value],
        );
        mark(`character:${op.value.key}`);
        setTab("characters");
        return;
      case "remove_character":
        setCharacters((arr) => arr.filter((c) => c.key !== op.key));
        setOpening((arr) => arr.filter((m) => m.character_key !== op.key));
        setTab("characters");
        return;
      case "set_opening":
        setOpening(op.value);
        mark("opening");
        setTab("opening");
        return;
      case "upsert_file":
        setFiles((arr) =>
          arr.some((f) => f.path === op.value.path) ? arr.map((f) => (f.path === op.value.path ? op.value : f)) : [...arr, op.value],
        );
        setActiveFile(op.value.path);
        mark(`file:${op.value.path}`, "files");
        setTab("files");
        return;
      case "remove_file":
        setFiles((arr) => arr.filter((f) => f.path !== op.path));
        setActiveFile((cur) => (cur === op.path ? null : cur));
        setTab("files");
        return;
      case "set_checks":
        setChecks(op.value);
        mark("checks");
        setTab("grading");
        return;
      case "set_rubric":
        setRubric(op.value);
        mark("rubric");
        setTab("grading");
        return;
    }
  };

  const save = async () => {
    if (!title.trim()) return toast("제목을 입력하세요", "info");
    if (characters.length === 0) return toast("등장인물을 1명 이상 추가하세요", "info");
    if (characters.some((c) => !c.key.trim() || !c.name.trim()))
      return toast("등장인물의 key와 이름은 필수입니다", "info");
    if (opening.length === 0) return toast("오프닝 메시지를 1개 이상 추가하세요 — 응시자의 유일한 출발점입니다", "info");
    if (!objectives.trim()) return toast("[정답 · 평가] 탭에 숨은 요구사항을 작성하세요 — NPC와 자동평가의 기준입니다", "info");
    setBusy(true);
    const body = {
      title: title.trim(),
      summary,
      difficulty,
      briefing_md: briefing,
      characters,
      opening_messages: opening,
      initial_files: files,
      objectives_md: objectives,
      checks,
      rubric,
      agent_enabled: agentEnabled,
    };
    try {
      if (scenarioId) await api.put(`/scenarios/${scenarioId}`, body);
      else await api.post("/scenarios", body);
      router.push("/admin/scenarios");
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "저장 실패", "error");
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!scenarioId) return;
    if (!(await confirm({ title: "시나리오를 삭제할까요?", message: "시험에 연결된 경우 보관 처리됩니다.", danger: true, confirmLabel: "삭제" }))) return;
    await api.del(`/scenarios/${scenarioId}`);
    router.push("/admin/scenarios");
  };

  return (
    <div className="flex items-start gap-5">
    <div className="min-w-0 flex-1">
      <div className="mb-4 flex items-center justify-between">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 truncate text-xl font-bold">
            {scenarioId ? "시나리오 편집" : "새 시나리오"}
            {aiBusy && (
              <span className="flex items-center gap-1.5 rounded-full bg-violet-100 px-2.5 py-0.5 text-[11px] font-semibold text-violet-700">
                <span className="h-1.5 w-1.5 animate-ping rounded-full bg-violet-500" /> AI 편집 중
              </span>
            )}
          </h1>
          <p className="mt-0.5 text-xs text-slate-400">
            문제는 지문이 아니라 <b>상황</b>입니다 — 인물별로 정보를 분산 배치해, 좋은 질문이 좋은 정보를 얻게 설계하세요.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {scenarioId && (
            <Button variant="danger" onClick={remove}>
              삭제
            </Button>
          )}
          <Button variant="secondary" onClick={() => router.push("/admin/scenarios")}>
            취소
          </Button>
          <span title={aiBusy ? "AI 편집이 끝나면 저장할 수 있습니다" : undefined}>
            <Button onClick={save} disabled={busy || aiBusy}>
              {busy ? "저장 중..." : "저장"}
            </Button>
          </span>
        </div>
      </div>

      {/* 탭 */}
      <div className="mb-5 flex gap-1 border-b border-slate-200">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`-mb-px border-b-2 px-4 py-2.5 text-sm font-medium transition ${
              tab === t.key ? "border-slate-900 text-slate-900" : "border-transparent text-slate-400 hover:text-slate-600"
            }`}
          >
            {t.label}
            {t.key === "characters" && characters.length > 0 && (
              <span className="ml-1.5 rounded-full bg-slate-100 px-1.5 text-xs text-slate-500">{characters.length}</span>
            )}
            {t.key === "files" && files.length > 0 && (
              <span className="ml-1.5 rounded-full bg-slate-100 px-1.5 text-xs text-slate-500">{files.length}</span>
            )}
            {t.key === "grading" && checks.length > 0 && (
              <span className="ml-1.5 rounded-full bg-slate-100 px-1.5 text-xs text-slate-500">{checks.length}</span>
            )}
          </button>
        ))}
      </div>

      {/* ── 기본 정보 ── */}
      {tab === "basic" && (
        <Card className="space-y-4 p-6">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <div className="md:col-span-2">
              <Field label="시나리오 제목 (관리용 — 응시자에게 노출되지 않음)">
                <input className={`${inputCls} ${hl("title")}`} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="예: 주간 매출 리포트 이상" />
              </Field>
            </div>
            <Field label="난이도">
              <select className={`${inputCls} ${hl("difficulty")}`} value={difficulty} onChange={(e) => setDifficulty(e.target.value)}>
                <option value="easy">쉬움</option>
                <option value="medium">보통</option>
                <option value="hard">어려움</option>
              </select>
            </Field>
          </div>
          <Field label="한 줄 요약 (관리용)">
            <input className={`${inputCls} ${hl("summary")}`} value={summary} onChange={(e) => setSummary(e.target.value)} />
          </Field>
          {/* 시작 화면(브리핑) — 짧게도, 아주 길게도 쓸 수 있다 */}
          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-sm font-medium text-slate-700">시작 화면 안내 (Markdown)</span>
              <div className="flex items-center gap-1.5">
                <span className="text-[11px] text-slate-400">{briefing.length.toLocaleString()}자</span>
                <button
                  onClick={() => setBriefingPreview((v) => !v)}
                  className={`rounded-lg border px-2 py-1 text-xs transition ${
                    briefingPreview
                      ? "border-slate-800 bg-slate-900 text-white"
                      : "border-slate-300 text-slate-600 hover:bg-slate-50"
                  }`}
                >
                  미리보기
                </button>
              </div>
            </div>
            {briefingPreview ? (
              <div className="min-h-[13rem] rounded-lg border border-slate-300 bg-slate-50 p-4">
                {briefing.trim() ? (
                  <Markdown>{briefing}</Markdown>
                ) : (
                  <p className="text-sm text-slate-400">
                    내용이 없으면 기본 문구(&ldquo;메신저에 새 메시지가 와 있습니다…&rdquo;)가 표시됩니다.
                  </p>
                )}
              </div>
            ) : (
              <textarea
                className={`${inputCls} min-h-[13rem] font-mono text-xs ${hl("briefing_md")}`}
                value={briefing}
                onChange={(e) => setBriefing(e.target.value)}
                placeholder={"예)\n\n**화요일 오후 4시 20분.**\n\n당신은 ML 플랫폼팀의 엔지니어입니다. 팀은 추론 서비스를 쿠버네티스로 옮기는 중이고, 오늘은 스테이징에 처음 배포하는 날이었습니다.\n\n배포는 성공했다고 나왔습니다. 그런데 아무것도 응답하지 않습니다.\n\n온콜 SRE가 메신저로 당신을 찾았습니다."}
              />
            )}
            <p className="mt-1 text-xs text-slate-400">
              문제를 열었을 때 처음 보게 되는 화면입니다. 지시사항을 나열하기보다 <b>소설의 도입부처럼 상황을
              묘사</b>하세요 — 언제, 어디서, 당신은 누구이며, 방금 무슨 일이 벌어졌는지. 무엇을 해야 하는지는
              응시자가 대화하며 스스로 알아내야 하므로 <b>요구사항이나 정답은 쓰지 마세요</b>.
              길이 제한은 넉넉합니다(4만 자).
            </p>
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-600">
            <input type="checkbox" checked={agentEnabled} onChange={(e) => setAgentEnabled(e.target.checked)} />
            AI 에이전트 앱 허용 (응시자가 파일 조작 가능한 어시스턴트 사용)
          </label>
        </Card>
      )}

      {/* ── 등장인물 ── */}
      {tab === "characters" && (
        <div className="space-y-4">
          {characters.map((c, i) => (
            <Card key={c.key || i} className={`space-y-3 p-5 ${hl(`character:${c.key}`)}`}>
              <div className="flex items-center gap-3">
                <input
                  type="color"
                  value={c.color}
                  onChange={(e) => setCharacters((arr) => arr.map((x, j) => (j === i ? { ...x, color: e.target.value } : x)))}
                  className="h-9 w-9 shrink-0 cursor-pointer rounded-full border-0 bg-transparent"
                  title="아바타 색"
                />
                <input
                  className={`${inputCls} max-w-40`}
                  placeholder="이름 (예: 김수진)"
                  value={c.name}
                  onChange={(e) => setCharacters((arr) => arr.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                />
                <input
                  className={`${inputCls} max-w-52`}
                  placeholder="직함 (예: 프로덕트 매니저)"
                  value={c.role}
                  onChange={(e) => setCharacters((arr) => arr.map((x, j) => (j === i ? { ...x, role: e.target.value } : x)))}
                />
                <input
                  className={`${inputCls} max-w-40 font-mono text-xs`}
                  placeholder="key (영문)"
                  value={c.key}
                  onChange={(e) =>
                    setCharacters((arr) =>
                      arr.map((x, j) => (j === i ? { ...x, key: e.target.value.replace(/[^a-z0-9_\-]/g, "") } : x)),
                    )
                  }
                />
                <button
                  onClick={() => setCharacters((arr) => arr.filter((_, j) => j !== i))}
                  className="ml-auto flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-300 hover:bg-red-50 hover:text-red-500"
                >
                  <IconDelete size={14} />
                </button>
              </div>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <Field
                  label="성격 · 말투 · 입장 (persona)"
                  hint="NPC의 톤을 결정합니다. 응시자가 무례하게 굴 때 이 인물이 어떻게 반응하는지도 한 줄 적어 두면 좋습니다 (예: 반말에는 사무적으로만 대한다)."
                >
                  <textarea
                    className={`${inputCls} min-h-28 text-xs`}
                    value={c.persona}
                    onChange={(e) => setCharacters((arr) => arr.map((x, j) => (j === i ? { ...x, persona: e.target.value } : x)))}
                    placeholder="예: 바쁘고 요점만 말한다. 기술 세부는 모르고, 데이터 질문은 박민호에게 넘긴다."
                  />
                </Field>
                <Field label="아는 것 (knowledge)" hint="⚠ 물어보면 답할 수 있는 정보의 전부 — 요구사항을 인물별로 나눠 담으세요">
                  <textarea
                    className={`${inputCls} min-h-28 text-xs`}
                    value={c.knowledge}
                    onChange={(e) => setCharacters((arr) => arr.map((x, j) => (j === i ? { ...x, knowledge: e.target.value } : x)))}
                    placeholder="예: 집계는 paid 주문만 포함. 대상 기간은 8/24~8/30. 출력 형식은..."
                  />
                </Field>
              </div>
            </Card>
          ))}
          <Button variant="secondary" onClick={() => setCharacters((arr) => [...arr, emptyCharacter(arr.length + 1)])}>
            <span className="flex items-center gap-1.5">
              <IconAdd size={14} /> 등장인물 추가
            </span>
          </Button>
        </div>
      )}

      {/* ── 오프닝 메시지 ── */}
      {tab === "opening" && (
        <div className={`space-y-4 rounded-2xl ${hl("opening")}`}>
          <p className="text-sm text-slate-500">
            응시 시작 시 메신저에 도착해 있는 메시지입니다 — 응시자의 <b>유일한 출발점</b>이므로, 상황의 실마리(증상·마감·누구에게 물을지)를 담되 요구사항 전체를 쓰지 마세요.
          </p>
          {opening.map((m, i) => (
            <Card key={i} className="flex items-start gap-3 p-4">
              <select
                className={`${inputCls} max-w-44`}
                value={m.character_key}
                onChange={(e) => setOpening((arr) => arr.map((x, j) => (j === i ? { ...x, character_key: e.target.value } : x)))}
              >
                <option value="">인물 선택</option>
                {characters.map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.name || c.key}
                  </option>
                ))}
              </select>
              <textarea
                className={`${inputCls} min-h-24 flex-1 text-sm`}
                value={m.content}
                onChange={(e) => setOpening((arr) => arr.map((x, j) => (j === i ? { ...x, content: e.target.value } : x)))}
                placeholder="첫 메시지 내용..."
              />
              <button
                onClick={() => setOpening((arr) => arr.filter((_, j) => j !== i))}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-300 hover:bg-red-50 hover:text-red-500"
              >
                <IconDelete size={14} />
              </button>
            </Card>
          ))}
          <Button
            variant="secondary"
            onClick={() => setOpening((arr) => [...arr, { character_key: characters[0]?.key ?? "", content: "" }])}
          >
            <span className="flex items-center gap-1.5">
              <IconAdd size={14} /> 오프닝 메시지 추가
            </span>
          </Button>
        </div>
      )}

      {/* ── 초기 파일 ── */}
      {tab === "files" && (
        <Card className="flex h-[520px] overflow-hidden p-0">
          <div className="flex w-64 shrink-0 flex-col border-r border-slate-200 bg-slate-50/60">
            <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2">
              <span className="text-xs font-bold text-slate-500">워크스페이스 초기 상태</span>
              <button
                title="파일 추가"
                onClick={() => {
                  const path = window.prompt("파일 경로 (예: data/orders.csv)");
                  if (!path?.trim()) return;
                  const p = path.trim().replace(/^\/+/, "");
                  if (files.some((f) => f.path === p)) return toast("이미 있는 경로입니다", "info");
                  setFiles((arr) => [...arr, { path: p, content: "" }]);
                  setActiveFile(p);
                }}
                className="flex h-6 w-6 items-center justify-center rounded text-slate-400 hover:bg-slate-200"
              >
                <IconAdd size={13} />
              </button>
            </div>
            <div className="thin-scroll min-h-0 flex-1 overflow-y-auto p-1.5">
              {files.map((f) => (
                <div
                  key={f.path}
                  className={`group flex cursor-pointer items-center gap-1 rounded-lg px-2 py-1.5 font-mono text-xs ${
                    activeFile === f.path ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"
                  } ${hl(`file:${f.path}`)}`}
                  onClick={() => setActiveFile(f.path)}
                >
                  <span className="min-w-0 flex-1 truncate">{f.path}</span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setFiles((arr) => arr.filter((x) => x.path !== f.path));
                      if (activeFile === f.path) setActiveFile(null);
                    }}
                    className={`hidden h-5 w-5 shrink-0 items-center justify-center rounded group-hover:flex ${
                      activeFile === f.path ? "text-slate-400 hover:text-red-300" : "text-slate-300 hover:text-red-500"
                    }`}
                  >
                    <IconDelete size={11} />
                  </button>
                </div>
              ))}
              {files.length === 0 && <p className="p-2 text-xs text-slate-400">파일 없음 — 빈 워크스페이스로 시작합니다</p>}
            </div>
          </div>
          <div className="min-w-0 flex-1">
            {activeFileObj ? (
              <CodeEditor
                language={langOf(activeFileObj.path)}
                value={activeFileObj.content}
                theme="light"
                onChange={(code) => setFiles((arr) => arr.map((x) => (x.path === activeFileObj.path ? { ...x, content: code } : x)))}
              />
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-slate-400">
                파일을 선택하거나 추가하세요
              </div>
            )}
          </div>
        </Card>
      )}

      {/* ── 정답 · 평가 ── */}
      {tab === "grading" && rubric && (
        <div className="space-y-6">
          <Card className="space-y-3 border-red-200 bg-red-50/30 p-6">
            <h2 className="font-bold text-red-800">숨은 요구사항 (objectives)</h2>
            <p className="text-xs text-red-600/80">
              이 시나리오의 <b>정답 정의</b>입니다. 응시자에게 절대 노출되지 않으며, NPC의 배경 지식과 자동평가의 채점 기준으로만 쓰입니다. 정확한 명세·정답 수치·정보의 인물별 분포를 기록하세요.
            </p>
            <textarea
              className={`${inputCls} min-h-64 font-mono text-xs ${hl("objectives_md")}`}
              value={objectives}
              onChange={(e) => setObjectives(e.target.value)}
              placeholder={"## 실제 요구사항\n1. ...\n\n### 정답 수치\n..."}
            />
          </Card>

          <Card className={`space-y-3 p-6 ${hl("checks")}`}>
            <h2 className="font-bold">자동 체크 (결과물 검증)</h2>
            {checks.map((c, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 p-3">
                <input
                  className={`${inputCls} max-w-56`}
                  placeholder="라벨"
                  value={c.label}
                  onChange={(e) => setChecks((arr) => arr.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
                />
                <select
                  className={`${inputCls} max-w-44`}
                  value={c.type}
                  onChange={(e) => setChecks((arr) => arr.map((x, j) => (j === i ? { ...x, type: e.target.value as CheckType } : x)))}
                >
                  {(Object.keys(CHECK_TYPE_LABEL) as CheckType[]).map((t) => (
                    <option key={t} value={t}>
                      {CHECK_TYPE_LABEL[t]}
                    </option>
                  ))}
                </select>
                {c.type !== "command" && (
                  <input
                    className={`${inputCls} max-w-56 font-mono text-xs`}
                    placeholder="경로 (예: output/report.csv)"
                    value={c.path ?? ""}
                    onChange={(e) => setChecks((arr) => arr.map((x, j) => (j === i ? { ...x, path: e.target.value } : x)))}
                  />
                )}
                {c.type === "file_contains" && (
                  <input
                    className={`${inputCls} max-w-64 font-mono text-xs`}
                    placeholder="정규식 (예: ^date,total)"
                    value={c.pattern ?? ""}
                    onChange={(e) => setChecks((arr) => arr.map((x, j) => (j === i ? { ...x, pattern: e.target.value } : x)))}
                  />
                )}
                {c.type === "command" && (
                  <>
                    <input
                      className={`${inputCls} max-w-64 font-mono text-xs`}
                      placeholder="명령 (예: python3 report.py)"
                      value={c.command ?? ""}
                      onChange={(e) => setChecks((arr) => arr.map((x, j) => (j === i ? { ...x, command: e.target.value } : x)))}
                    />
                    <input
                      className={`${inputCls} max-w-52 font-mono text-xs`}
                      placeholder="기대 stdout 포함 (선택)"
                      value={c.expected_stdout ?? ""}
                      onChange={(e) => setChecks((arr) => arr.map((x, j) => (j === i ? { ...x, expected_stdout: e.target.value } : x)))}
                    />
                  </>
                )}
                <label className="flex items-center gap-1 text-xs text-slate-500">
                  배점
                  <input
                    className="w-16 rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
                    type="number"
                    min={0}
                    max={100}
                    value={c.points}
                    onChange={(e) => setChecks((arr) => arr.map((x, j) => (j === i ? { ...x, points: Number(e.target.value) } : x)))}
                  />
                </label>
                <button
                  onClick={() => setChecks((arr) => arr.filter((_, j) => j !== i))}
                  className="ml-auto flex h-8 w-8 items-center justify-center rounded-lg text-slate-300 hover:bg-red-50 hover:text-red-500"
                >
                  <IconDelete size={14} />
                </button>
              </div>
            ))}
            <Button variant="secondary" onClick={() => setChecks((arr) => [...arr, { label: "", type: "file_exists", path: "", points: 10 }])}>
              <span className="flex items-center gap-1.5">
                <IconAdd size={14} /> 체크 추가
              </span>
            </Button>
          </Card>

          <Card className={`space-y-4 p-6 ${hl("rubric")}`}>
            <div className="flex items-center gap-4">
              <h2 className="font-bold">루브릭 (LLM 평가 기준)</h2>
              <label className="flex items-center gap-1.5 text-xs text-slate-500">
                과정
                <input
                  className="w-16 rounded-lg border border-slate-300 px-2 py-1 text-sm"
                  type="number"
                  value={rubric.process_weight}
                  onChange={(e) => setRubric({ ...rubric, process_weight: Number(e.target.value) })}
                />
                %
              </label>
              <label className="flex items-center gap-1.5 text-xs text-slate-500">
                결과
                <input
                  className="w-16 rounded-lg border border-slate-300 px-2 py-1 text-sm"
                  type="number"
                  value={rubric.result_weight}
                  onChange={(e) => setRubric({ ...rubric, result_weight: Number(e.target.value) })}
                />
                %
              </label>
            </div>
            {(["process", "result"] as const).map((section) => (
              <div key={section}>
                <p className="mb-2 text-sm font-semibold text-slate-600">{section === "process" ? "과정 평가" : "결과 평가"}</p>
                <div className="space-y-2">
                  {rubric[section].map((it, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <input
                        className={`${inputCls} max-w-48`}
                        value={it.name}
                        placeholder="항목명"
                        onChange={(e) =>
                          setRubric({ ...rubric, [section]: rubric[section].map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })
                        }
                      />
                      <input
                        className="w-20 rounded-lg border border-slate-300 px-2 py-2 text-sm"
                        type="number"
                        value={it.points}
                        onChange={(e) =>
                          setRubric({ ...rubric, [section]: rubric[section].map((x, j) => (j === i ? { ...x, points: Number(e.target.value) } : x)) })
                        }
                      />
                      <input
                        className={`${inputCls} flex-1 text-xs`}
                        value={it.desc}
                        placeholder="평가 관점 설명"
                        onChange={(e) =>
                          setRubric({ ...rubric, [section]: rubric[section].map((x, j) => (j === i ? { ...x, desc: e.target.value } : x)) })
                        }
                      />
                      <button
                        onClick={() => setRubric({ ...rubric, [section]: rubric[section].filter((_, j) => j !== i) })}
                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-300 hover:bg-red-50 hover:text-red-500"
                      >
                        <IconDelete size={14} />
                      </button>
                    </div>
                  ))}
                  <button
                    onClick={() => setRubric({ ...rubric, [section]: [...rubric[section], { name: "", points: 10, desc: "" }] })}
                    className="text-xs text-slate-400 hover:text-slate-600"
                  >
                    + 항목 추가
                  </button>
                </div>
              </div>
            ))}
          </Card>
        </div>
      )}
    </div>

    {/* 우측: 설계 대화 — 화면에 붙어 따라온다 */}
    <aside className="sticky top-[72px] h-[calc(100vh-96px)] w-[400px] shrink-0">
      <ScenarioAuthorChat
        hasContent={hasContent}
        getDraft={getDraft}
        applyOp={applyOp}
        applyScenario={applyDraft}
        onStreaming={setAiBusy}
      />
    </aside>
    </div>
  );
}

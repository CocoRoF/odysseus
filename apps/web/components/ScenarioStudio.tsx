"use client";

import { OfficeContextEditor, EMPTY_OFFICE_CONTEXT } from "./OfficeContextEditor";
import type { OfficePublic } from "@/lib/types";
import { useEffect, useMemo, useState } from "react";
import { AvatarPicker } from "@/components/AvatarPicker";
import { useRouter } from "next/navigation";
import { api, ApiError } from "@/lib/api";
import type {
  AuthorOp,
  Character,
  Check,
  CheckType,
  DesktopAppId,
  InitialFile,
  OpeningMessage,
  Rubric,
  Scenario,
  ScenarioDraft,
} from "@/lib/types";
import { ScenarioAuthorChat } from "@/components/ScenarioAuthorChat";
import { CodeEditor } from "@/components/CodeEditor";
import { Markdown } from "@/components/Markdown";
import { useToast } from "@/components/toast";
import { useReadOnly, writeProps } from "@/components/readonly";
import { Button, Card, Field, inputBaseCls, inputCls } from "@/components/ui";
import { IconAdd, IconDelete } from "@/components/icons";


const TABS = [
  { key: "basic", label: "기본 정보" },
  { key: "characters", label: "등장인물" },
  { key: "opening", label: "오프닝 메시지" },
  { key: "files", label: "초기 파일" },
  { key: "grading", label: "정답 · 평가" },
  { key: "npc", label: "NPC 규칙" },
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
  avatar_preset: "",
  gender: "",
  encounter: "",
});

/** 시험 데스크톱에서 시나리오별로 켜고 끌 수 있는 앱 (서버 desktop.OPTIONAL_APPS 와 같은 순서) */
const DESKTOP_APP_OPTIONS: { id: DesktopAppId; label: string }[] = [
  { id: "terminal", label: "터미널" },
  { id: "files", label: "폴더" },
  { id: "mail", label: "메일" },
  { id: "docs", label: "문서" },
  { id: "sheet", label: "OdyCell (표)" },
  { id: "ide", label: "IDE" },
  { id: "github", label: "GitHub" },
];

const APP_PRESETS: { label: string; apps: DesktopAppId[] }[] = [
  { label: "엔지니어링", apps: ["terminal", "files", "ide", "docs", "sheet", "github"] },
  { label: "사무·문서", apps: ["files", "mail", "docs", "sheet"] },
  { label: "커뮤니케이션", apps: ["files", "mail", "docs"] },
  { label: "분석", apps: ["files", "sheet", "docs"] },
  { label: "조율·일정", apps: ["files", "sheet", "docs", "mail"] },
];

const CHECK_TYPE_LABEL: Record<CheckType, string> = {
  file_exists: "파일 존재",
  file_contains: "파일 내용 (정규식)",
  file_not_contains: "금칙어 없음 (정규식)",
  file_min_words: "최소 분량 (단어 수)",
  file_max_words: "최대 분량 (단어 수)",
  csv_cell: "표의 특정 값 (CSV)",
  csv_row_count: "표의 행 수 (CSV)",
  csv_column_sum: "표 열의 합계 (CSV)",
  csv_column_unique: "표 열의 값 중복 없음 (CSV)",
  command: "명령 실행",
};

/** 채워 넣은 뒤에는 placeholder 가 사라져 각 칸이 무엇이었는지 알 수 없다 — 줄마다 한 줄로 적어 둔다. */
const CHECK_HINT: Record<CheckType, string> = {
  file_exists: "경로",
  file_contains: "경로 · 있어야 할 내용(정규식)",
  file_not_contains: "경로 · 있으면 안 되는 내용(정규식)",
  file_min_words: "경로 · 최소 단어 수",
  file_max_words: "경로 · 최대 단어 수",
  csv_cell: "경로 · 열 이름 · 행 조건 · 기대값 · 허용 오차",
  csv_row_count: "경로 · 행 조건(선택) · 기대 행 수",
  csv_column_sum: "경로 · 열 이름 · 행 조건(선택) · 기대 합계 · 허용 오차",
  csv_column_unique: "경로 · 열 이름 · 행 조건(선택)",
  command: "명령 · 기대 출력(선택) — 마지막 수단입니다. 파일에 적힌 값을 확인하는 것이라면 파일 체크가 낫습니다",
};

/** 이 체크 종류가 쓰는 입력칸 — 스튜디오가 필요한 것만 보여 준다. */
const CSV_CHECKS: CheckType[] = ["csv_cell", "csv_row_count", "csv_column_sum", "csv_column_unique"];
const NEEDS_COLUMN: CheckType[] = ["csv_cell", "csv_column_sum", "csv_column_unique"];
const NEEDS_EXPECTED: CheckType[] = ["csv_cell", "csv_row_count", "csv_column_sum"];
const NEEDS_TOLERANCE: CheckType[] = ["csv_cell", "csv_column_sum"];

/** 등장인물 카드의 한 칸 — 라벨과 (필요하면) 한 줄 설명을 위에 둔다. */
function CharField({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] text-slate-400" title={hint}>
        {label}
      </span>
      {children}
    </label>
  );
}

function langOf(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return (
    { py: "python", md: "markdown", json: "json", csv: "plaintext", js: "javascript", ts: "typescript", sh: "shell" }[
      ext
    ] ?? "plaintext"
  );
}

/** 시나리오 스튜디오 — '문제 상황' 전체(인물·정보 분포·초기 상태·정답 기준)를 설계하는 편집기. */
export function ScenarioStudio({
  initial,
  scenarioId,
}: {
  initial?: Scenario;
  scenarioId?: string;
}) {
  const router = useRouter();
  const { toast, confirm } = useToast();
  /** 둘러보기 계정 — 내용은 다 만져 볼 수 있고 저장·삭제·AI 작성만 잠근다 (components/readonly.tsx) */
  const readOnly = useReadOnly();
  /** 설계 대화 패널을 펼쳐 둘 것인가 — 긴 탭에서는 접어 두는 편이 편집 칸이 넓다 */
  const [chatOpen, setChatOpen] = useState(true);
  const [tab, setTab] = useState<TabKey>("basic");
  const [busy, setBusy] = useState(false);
  const [officeAuthorBusy, setOfficeAuthorBusy] = useState(false);

  const [title, setTitle] = useState(initial?.title ?? "");
  const [officePublic, setOfficePublic] = useState<OfficePublic>(initial?.office_public?.facts ? initial.office_public : EMPTY_OFFICE_CONTEXT);
  const [summary, setSummary] = useState(initial?.summary ?? "");
  const [difficulty, setDifficulty] = useState(initial?.difficulty ?? "medium");
  useEffect(() => {
  }, []);
  const [briefing, setBriefing] = useState(initial?.briefing_md ?? "");
  // NPC 기본 규칙 덮어쓰기 — 비어 있으면 전역 기본을 쓴다. 기본값은 필요할 때 서버에서 받아 온다.
  const [npcRules, setNpcRules] = useState(initial?.npc_base_prompt ?? "");
  const [npcDefault, setNpcDefault] = useState<string | null>(null);
  const loadNpcDefault = async () => {
    if (npcDefault !== null) return npcDefault;
    const r = await api.get<{ prompt: string }>("/scenarios/npc-default-prompt");
    setNpcDefault(r.prompt);
    return r.prompt;
  };
  const [briefingPreview, setBriefingPreview] = useState(false);
  const [agentEnabled, setAgentEnabled] = useState(initial?.agent_enabled ?? true);
  // 이 시나리오에서 제공할 앱 — 비어 있으면 전부 제공(기존 동작)
  const [desktopApps, setDesktopApps] = useState<DesktopAppId[]>(initial?.desktop_apps ?? []);
  const [runTimeout, setRunTimeout] = useState(initial?.run_timeout_s ?? 0);
  const [characters, setCharacters] = useState<Character[]>(initial?.characters ?? []);
  const [opening, setOpening] = useState<OpeningMessage[]>(initial?.opening_messages ?? []);
  const [files, setFiles] = useState<InitialFile[]>(initial?.initial_files ?? []);
  const [activeFile, setActiveFile] = useState<string | null>(initial?.initial_files?.[0]?.path ?? null);
  const [objectives, setObjectives] = useState(initial?.objectives_md ?? "");
  const [checks, setChecks] = useState<Check[]>(initial?.checks ?? []);
  /** 명령 실행 체크의 수 — 여럿이면 채점이 그만큼 느려지므로 화면에서 말해 준다 */
  const commandCount = useMemo(() => checks.filter((c) => c.type === "command").length, [checks]);
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
    desktop_apps: desktopApps,
    run_timeout_s: runTimeout,
    office_public: officePublic,
  });
  const applyDraft = (d: ScenarioDraft) => {
    if (d.office_public) setOfficePublic(d.office_public);
    setTitle(d.title); setSummary(d.summary); setDifficulty(d.difficulty); setBriefing(d.briefing_md);
    setCharacters(d.characters); setOpening(d.opening_messages); setFiles(d.initial_files);
    setActiveFile(d.initial_files[0]?.path ?? null); setObjectives(d.objectives_md); setChecks(d.checks);
    setRubric(d.rubric); setAgentEnabled(d.agent_enabled); setDesktopApps(d.desktop_apps ?? []);
    setRunTimeout(d.run_timeout_s ?? 0);
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
        else if (op.field === "desktop_apps") setDesktopApps((Array.isArray(v) ? v : []) as DesktopAppId[]);
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
      npc_base_prompt: npcRules.trim(),
      checks,
      rubric,
      agent_enabled: agentEnabled,
      desktop_apps: desktopApps,
      run_timeout_s: runTimeout,
      office_public: officePublic,
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
          {/* 되돌릴 수 없는 버튼은 저장 옆에 붙이지 않는다 — 한 번의 오클릭이 시나리오 하나를 지운다 */}
          {scenarioId && (
            <>
              <Button variant="danger" onClick={remove} write>
                삭제
              </Button>
              <span className="mx-2 h-6 w-px bg-slate-200" aria-hidden="true" />
            </>
          )}
          <Button variant="secondary" onClick={() => router.push("/admin/scenarios")}>
            취소
          </Button>
          <span title={aiBusy ? "AI 편집이 끝나면 저장할 수 있습니다" : undefined}>
            <Button onClick={save} disabled={busy || aiBusy} write>
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
            {t.key === "opening" && opening.length > 0 && (
              <span className="ml-1.5 rounded-full bg-slate-100 px-1.5 text-xs text-slate-500">{opening.length}</span>
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

          <div className={`space-y-2 rounded-xl border border-slate-200 p-4 ${hl("desktop_apps")}`}>
            <p className="text-sm font-semibold text-slate-700">시험 데스크톱에 제공할 앱</p>
            <p className="text-xs text-slate-400">
              아무것도 고르지 않으면 <b>전부 제공</b>합니다(기존 동작). 사무·커뮤니케이션 과제라면 터미널과 IDE를 빼는 편이
              좋습니다 — 화면에 있는 도구가 곧 &ldquo;이건 어떤 종류의 문제인가&rdquo;라는 신호이기 때문입니다.
            </p>
            <div className="flex flex-wrap gap-2">
              {DESKTOP_APP_OPTIONS.map((app) => {
                const on = desktopApps.includes(app.id);
                return (
                  <button
                    key={app.id}
                    type="button"
                    onClick={() =>
                      setDesktopApps((cur) => (on ? cur.filter((x) => x !== app.id) : [...cur, app.id]))
                    }
                    className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
                      on
                        ? "border-sky-400 bg-sky-50 text-sky-700"
                        : "border-slate-200 bg-white text-slate-500 hover:bg-slate-50"
                    }`}
                  >
                    {app.label}
                  </button>
                );
              })}
            </div>
            <div className="flex flex-wrap items-center gap-2 pt-1 text-xs text-slate-400">
              <span>빠른 설정:</span>
              {APP_PRESETS.map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  onClick={() => setDesktopApps(preset.apps)}
                  className="rounded-md border border-slate-200 px-2 py-1 text-slate-500 hover:bg-slate-50"
                >
                  {preset.label}
                </button>
              ))}
              <button
                type="button"
                onClick={() => setDesktopApps([])}
                className="rounded-md border border-slate-200 px-2 py-1 text-slate-500 hover:bg-slate-50"
              >
                전부 제공(기본)
              </button>
            </div>

            {/* 명령 실행 제한 시간 — 시나리오마다 다르다 */}
            <div className="mt-5 border-t border-slate-100 pt-4">
              <p className="text-sm font-semibold text-slate-700">명령 실행 제한 시간</p>
              <p className="mt-1 text-xs text-slate-400">
                터미널·에이전트가 명령 하나를 돌릴 수 있는 초. <b>0이면 기본값</b>을 씁니다. 의존성 설치나
                빌드가 필요한 시나리오는 늘려 주세요 — 러너가 받아들이는 상한은 60초입니다.
              </p>
              <div className="mt-2 flex items-center gap-2">
                <input
                  className="w-28 rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
                  type="number"
                  min={0}
                  max={60}
                  value={runTimeout}
                  onChange={(e) => setRunTimeout(Math.max(0, Math.min(60, Number(e.target.value) || 0)))}
                />
                <span className="text-xs text-slate-400">
                  {runTimeout === 0 ? "기본값" : `${runTimeout}초`}
                </span>
              </div>
            </div>
          </div>
        </Card>
      )}

      {/* ── 등장인물 ── */}
      {tab === "characters" && (
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-4 rounded-xl bg-slate-50 px-4 py-3">
            <p className="text-xs text-slate-500">공개된 상황과 성격에 맞춰 감정이 드러나는 첫 대사·말투·대화 주제를 함께 작성합니다.</p>
            <button type="button" className="shrink-0 whitespace-nowrap rounded-lg border border-sky-200 bg-white px-2.5 py-1 text-xs font-medium text-sky-700 transition hover:bg-sky-50 disabled:cursor-not-allowed disabled:opacity-40" {...writeProps(readOnly, officeAuthorBusy || !characters.length)}
              onClick={async () => {
                setOfficeAuthorBusy(true);
                try {
                  const result = await api.post<{ office_public: OfficePublic; voices: { key: string; voice: string; encounter: string }[] }>("/scenarios/office-author", {
                    characters: characters.map(c => ({ key: c.key, name: c.name, role: c.role, encounter: c.encounter || "", office_voice: c.office_voice || "" })), public_setting: officePublic.setting, scenario_title: title,
                  });
                  setOfficePublic(result.office_public);
                  setCharacters(arr => arr.map(c => {
                    const voice = result.voices.find(v => v.key === c.key);
                    return voice ? { ...c, office_voice: voice.voice, encounter: voice.encounter } : c;
                  }));
                  toast("공개 설정 초안을 작성했습니다. 내용을 확인하고 공개 여부를 선택해 주세요", "info");
                } catch (e) { toast(e instanceof Error ? e.message : "초안 작성 실패", "error"); }
                finally { setOfficeAuthorBusy(false); }
              }}>{officeAuthorBusy ? "초안 작성 중…" : "AI로 공개 설정 작성"}</button>
          </div>
          <OfficeContextEditor value={officePublic} onChange={setOfficePublic} />
          {characters.map((c, i) => (
            <Card key={c.key || i} className={`space-y-3 p-5 ${hl(`character:${c.key}`)}`}>
              {/* 칸마다 이름을 단다 — 값만 남으면 ga_narae 가 무엇인지, 옆 칸이 직함인지 알 수 없다 */}
              <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
                <CharField label="아바타 · 색">
                  <div className="flex h-[38px] items-center gap-2">
                    <input
                      type="color"
                      value={c.color}
                      onChange={(e) => setCharacters((arr) => arr.map((x, j) => (j === i ? { ...x, color: e.target.value } : x)))}
                      className="h-8 w-8 shrink-0 cursor-pointer rounded-full border-0 bg-transparent"
                      title="사무실에서 이 인물을 가리키는 색"
                    />
                    <AvatarPicker
                      characterKey={c.key}
                      value={c.avatar_preset ?? ""}
                      onChange={(id) =>
                        setCharacters((arr) => arr.map((x, j) => (j === i ? { ...x, avatar_preset: id } : x)))
                      }
                    />
                  </div>
                </CharField>
                <CharField label="이름">
                  <input
                    className={`${inputBaseCls} w-40`}
                    placeholder="예: 김수진"
                    value={c.name}
                    onChange={(e) => setCharacters((arr) => arr.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                  />
                </CharField>
                {/* 성별은 아바타를 고르지 않았을 때 **후보를 좁히는** 값이다.
                    김수진에게 남성 아바타가 붙으면 그건 무작위가 아니라 틀린 것이다. */}
                <CharField label="성별" hint="아바타를 고르지 않았을 때만 쓰입니다">
                  <select
                    className={`${inputBaseCls} w-24`}
                    value={c.gender ?? ""}
                    onChange={(e) => setCharacters((arr) => arr.map((x, j) => (j === i ? { ...x, gender: e.target.value } : x)))}
                  >
                    <option value="">—</option>
                    <option value="female">여</option>
                    <option value="male">남</option>
                  </select>
                </CharField>
                <CharField label="직함">
                  <input
                    className={`${inputBaseCls} w-52`}
                    placeholder="예: 프로덕트 매니저"
                    value={c.role}
                    onChange={(e) => setCharacters((arr) => arr.map((x, j) => (j === i ? { ...x, role: e.target.value } : x)))}
                  />
                </CharField>
                <CharField label="식별자" hint="자동 체크·기억이 이 인물을 가리키는 영문 id">
                  <input
                    className={`${inputBaseCls} w-40 font-mono text-xs`}
                    placeholder="예: pm_sujin"
                    value={c.key}
                    onChange={(e) =>
                      setCharacters((arr) =>
                        arr.map((x, j) => (j === i ? { ...x, key: e.target.value.replace(/[^a-z0-9_\-]/g, "") } : x)),
                      )
                    }
                  />
                </CharField>
                <button
                  onClick={() => setCharacters((arr) => arr.filter((_, j) => j !== i))}
                  title="이 등장인물 삭제"
                  className="mb-1 ml-auto flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-300 transition hover:bg-red-50 hover:text-red-500"
                >
                  <IconDelete size={14} />
                </button>
              </div>
                <label className="block text-xs text-slate-500">사무실 첫 대사 — 초상화 대화창에서 NPC가 먼저 말합니다
                  <textarea className={`${inputCls} mt-1 text-xs`} rows={2} maxLength={200} value={c.encounter ?? ""}
                    onChange={e => setCharacters(arr => arr.map((x,j) => j === i ? { ...x, encounter: e.target.value } : x))} />
                </label>
                <label className="flex items-center gap-3 text-xs text-slate-500">NPC 간 대화 참여 상한
                  <input type="number" min={0} max={50} className={`${inputBaseCls} w-20`} value={c.office_max_conversations ?? 12}
                    onChange={e => setCharacters(arr => arr.map((x,j) => j === i ? { ...x, office_max_conversations: Math.max(0, Math.min(50, Number(e.target.value))) } : x))} />
                  <span>사용자별 누적 횟수 · 0이면 자동 대화 안 함 · 사용자와의 대화는 계속 가능</span>
                </label>
              <Field label="사무실 말투 · 공개 성격" hint="현재 감정과 말투를 함께 적으세요. 예: 갈등으로 상처받아 말을 아끼지만, 경청해 주면 서서히 마음을 연다. 숨은 원인이나 정답은 제외하세요.">
                <textarea className={`${inputCls} text-xs`} rows={2} maxLength={600} value={c.office_voice ?? ""}
                  onChange={e => setCharacters(arr => arr.map((x,j) => j === i ? { ...x, office_voice: e.target.value } : x))}
                  placeholder="예: 차분하게 경청하며 짧은 문장으로 대답한다. 가벼운 농담을 좋아한다." />
              </Field>
              <details className="text-xs text-slate-500"><summary className="cursor-pointer">다른 시나리오의 동일 인물과 연결</summary>
                <p className="my-2">동일 인물 UUID를 입력하면 인물 정체성을 연결합니다. 이름이 같다는 이유만으로 연결하지 마세요. 비워 두면 이 시나리오의 독립 인물입니다.</p>
                <input className={`${inputCls} font-mono text-xs`} value={c.npc_id ?? ""} placeholder="인물 UUID (선택)"
                  onChange={e => setCharacters(arr => arr.map((x,j) => j === i ? { ...x, npc_id: e.target.value || null } : x))} />
              </details>
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
                <Field label="아는 것 (knowledge)" hint="물어보면 답할 수 있는 정보의 전부입니다 — 요구사항을 인물별로 나눠 담으세요">
                  <textarea
                    className={`${inputCls} min-h-44 text-xs`}
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
                className={`${inputBaseCls} w-44`}
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

      {/* ── NPC 규칙 ── */}
      {tab === "npc" && (
        <div className="space-y-6">
          <Card className="space-y-3 p-6">
            <h2 className="font-bold">NPC 기본 규칙 (이 시나리오 전용)</h2>
            <p className="text-xs text-slate-500">
              모든 등장인물의 시스템 프롬프트는 <b>인물 카드(성격·아는 것·동료)</b> 뒤에 이 <b>기본 규칙</b>이 붙는 구조입니다.
              규칙은 카드와 충돌하면 카드보다 우선하며, 어떤 메시지에 답할지·격식을 어떻게 가릴지·태도가 무엇에 비례하는지를 정합니다.
              비워 두면 전역 기본을 씁니다. 영어로 쓰는 것을 권장합니다 — 한국어 규칙은 그 어투가 답변에 새어 나옵니다.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                onClick={async () => {
                  const d = await loadNpcDefault();
                  if (npcRules.trim() && !(await confirm({ title: "기본값으로 덮어쓸까요?", message: "지금 적어 둔 규칙이 전역 기본값으로 바뀝니다.", confirmLabel: "덮어쓰기" }))) return;
                  setNpcRules(d);
                }}
              >
                전역 기본값 불러오기
              </Button>
              <Button variant="secondary" onClick={() => setNpcRules("")} disabled={!npcRules.trim()}>
                비우기 (전역 기본 사용)
              </Button>
              <span className="text-xs text-slate-400">
                {npcRules.trim() ? `이 시나리오 전용 규칙 사용 중 · ${npcRules.length.toLocaleString()}자` : "전역 기본 규칙 사용 중"}
              </span>
            </div>
            <textarea
              className={`${inputCls} min-h-[28rem] font-mono text-xs leading-relaxed`}
              value={npcRules}
              onChange={(e) => setNpcRules(e.target.value)}
              placeholder={"(비어 있음 — 전역 기본 규칙이 쓰입니다. [전역 기본값 불러오기] 로 가져와 고칠 수 있습니다)"}
              spellCheck={false}
            />
          </Card>
        </div>
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
              <div key={i} className="rounded-xl border border-slate-200 p-3">
                <div className="flex items-center gap-2">
                  <span className="w-5 shrink-0 text-center text-xs font-semibold text-slate-300">{i + 1}</span>
                  <input
                    className={`${inputBaseCls} min-w-0 flex-1`}
                    placeholder="라벨 (채점표에 보이는 이름)"
                    value={c.label}
                    onChange={(e) => setChecks((arr) => arr.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
                  />
                  <select
                    className={`${inputBaseCls} w-52 shrink-0`}
                    value={c.type}
                    onChange={(e) => setChecks((arr) => arr.map((x, j) => (j === i ? { ...x, type: e.target.value as CheckType } : x)))}
                  >
                    {(Object.keys(CHECK_TYPE_LABEL) as CheckType[]).map((t) => (
                      <option key={t} value={t}>
                        {CHECK_TYPE_LABEL[t]}
                      </option>
                    ))}
                  </select>
                  <label className="flex shrink-0 items-center gap-1 whitespace-nowrap text-xs text-slate-500">
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
                    title="이 체크 삭제"
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-300 transition hover:bg-red-50 hover:text-red-500"
                  >
                    <IconDelete size={14} />
                  </button>
                </div>
                <p className="mb-1 ml-7 mt-2 text-[11px] text-slate-400">{CHECK_HINT[c.type]}</p>
                {c.type === "command" && commandCount > 1 && (
                  <p className="mb-1 ml-7 text-[11px] text-amber-600">
                    이 시나리오의 명령 실행 체크가 {commandCount}개입니다. 채점할 때마다 러너에서 실제로
                    돌아가 기다리는 시간이 길어집니다 — 파일 값을 보는 체크로 바꿀 수 있는지 확인하세요.
                  </p>
                )}
                <div className="ml-7 flex flex-wrap items-center gap-2">
                {c.type !== "command" && (
                  <input
                    className={`${inputBaseCls} w-56 font-mono text-xs`}
                    placeholder="경로 (예: output/report.csv)"
                    value={c.path ?? ""}
                    onChange={(e) => setChecks((arr) => arr.map((x, j) => (j === i ? { ...x, path: e.target.value } : x)))}
                  />
                )}
                {(c.type === "file_contains" || c.type === "file_not_contains") && (
                  <input
                    className={`${inputBaseCls} w-64 font-mono text-xs`}
                    placeholder={c.type === "file_contains" ? "정규식 (예: ^date,total)" : "금칙어 정규식 (예: 법적\\s*책임)"}
                    value={c.pattern ?? ""}
                    onChange={(e) => setChecks((arr) => arr.map((x, j) => (j === i ? { ...x, pattern: e.target.value } : x)))}
                  />
                )}
                {c.type === "file_min_words" && (
                  <input
                    className={`${inputBaseCls} w-40`}
                    type="number"
                    min={1}
                    placeholder="최소 단어 수 (예: 200)"
                    value={c.min_count ?? ""}
                    onChange={(e) =>
                      setChecks((arr) => arr.map((x, j) => (j === i ? { ...x, min_count: Number(e.target.value) || null } : x)))
                    }
                  />
                )}
                {c.type === "file_max_words" && (
                  <input
                    className={`${inputBaseCls} w-40`}
                    type="number"
                    min={1}
                    placeholder="최대 단어 수 (예: 320)"
                    value={c.max_count ?? ""}
                    onChange={(e) =>
                      setChecks((arr) => arr.map((x, j) => (j === i ? { ...x, max_count: Number(e.target.value) || null } : x)))
                    }
                  />
                )}
                {CSV_CHECKS.includes(c.type) && (
                  <>
                    {NEEDS_COLUMN.includes(c.type) && (
                      <input
                        className={`${inputBaseCls} w-40 font-mono text-xs`}
                        placeholder="열 이름 (예: revenue)"
                        value={c.column ?? ""}
                        onChange={(e) => setChecks((arr) => arr.map((x, j) => (j === i ? { ...x, column: e.target.value } : x)))}
                      />
                    )}
                    <input
                      className={`${inputBaseCls} w-48 font-mono text-xs`}
                      placeholder={c.type === "csv_cell" ? "행 조건 (예: branch=서울)" : "행 조건 (선택, 예: verdict=반려)"}
                      value={c.row_match ?? ""}
                      onChange={(e) => setChecks((arr) => arr.map((x, j) => (j === i ? { ...x, row_match: e.target.value } : x)))}
                    />
                    {NEEDS_EXPECTED.includes(c.type) && (
                      <input
                        className={`${inputBaseCls} w-40 font-mono text-xs`}
                        placeholder={
                          c.type === "csv_row_count"
                            ? "기대 행 수 (예: 8)"
                            : c.type === "csv_column_sum"
                              ? "기대 합계 (예: 3000000)"
                              : "기대값 (예: 480000000)"
                        }
                        value={c.expected ?? ""}
                        onChange={(e) => setChecks((arr) => arr.map((x, j) => (j === i ? { ...x, expected: e.target.value } : x)))}
                      />
                    )}
                    {NEEDS_TOLERANCE.includes(c.type) && (
                    <input
                      className={`${inputBaseCls} w-28`}
                      type="number"
                      min={0}
                      step="any"
                      placeholder="허용 오차"
                      value={c.tolerance ?? ""}
                      onChange={(e) =>
                        setChecks((arr) =>
                          arr.map((x, j) => (j === i ? { ...x, tolerance: e.target.value === "" ? null : Number(e.target.value) } : x)),
                        )
                      }
                    />
                    )}
                  </>
                )}
                {c.type === "command" && (
                  <>
                    <input
                      className={`${inputBaseCls} w-64 font-mono text-xs`}
                      placeholder="명령 (예: python3 report.py)"
                      value={c.command ?? ""}
                      onChange={(e) => setChecks((arr) => arr.map((x, j) => (j === i ? { ...x, command: e.target.value } : x)))}
                    />
                    <input
                      className={`${inputBaseCls} w-52 font-mono text-xs`}
                      placeholder="기대 stdout 포함 (선택)"
                      value={c.expected_stdout ?? ""}
                      onChange={(e) => setChecks((arr) => arr.map((x, j) => (j === i ? { ...x, expected_stdout: e.target.value } : x)))}
                    />
                  </>
                )}
                </div>
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
                        className={`${inputBaseCls} w-48`}
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

    {/* 우측: 설계 대화 — 화면에 붙어 따라온다. 접으면 편집 칸이 그만큼 넓어진다 */}
    <aside className={`sticky top-[72px] h-[calc(100vh-96px)] shrink-0 ${chatOpen ? "w-[440px]" : "w-10"}`}>
      {chatOpen ? (
        <div className="flex h-full flex-col">
          <button
            type="button"
            onClick={() => setChatOpen(false)}
            className="mb-1 self-end rounded-lg px-2 py-1 text-xs text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
          >
            설계 대화 접기 ›
          </button>
          <div className="min-h-0 flex-1">
            <ScenarioAuthorChat
              hasContent={hasContent}
              getDraft={getDraft}
              applyOp={applyOp}
              applyScenario={applyDraft}
              onStreaming={setAiBusy}
            />
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setChatOpen(true)}
          title="시나리오 설계자와 대화하기"
          className="flex h-full w-10 flex-col items-center justify-start gap-2 rounded-2xl border border-slate-200 bg-white py-3 text-xs text-slate-500 transition hover:border-violet-300 hover:text-violet-700"
        >
          <span aria-hidden="true">‹</span>
          <span className="[writing-mode:vertical-rl]">설계 대화</span>
        </button>
      )}
    </aside>
    </div>
  );
}

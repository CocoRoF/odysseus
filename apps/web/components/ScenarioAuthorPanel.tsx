"use client";

import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "@/lib/api";
import type { AiSettingsMeta, AuthorResult, ScenarioDraft } from "@/lib/types";
import { Button } from "@/components/ui";
import { useToast } from "@/components/toast";
import { IconAgent, IconClose, IconWarn } from "@/components/icons";

/**
 * 시나리오 작성 어시스턴트 — 한 줄 요청으로 시나리오 전체를 설계해 스튜디오에 채운다.
 *
 * 인물·정보 분산·초기 데이터·숨은 정답·자동 체크까지 한 번에 오지만, 저장은 하지
 * 않는다. 채워진 것을 사람이 보고 고친 뒤 저장한다. 이미 채워진 초안이 있으면
 * "다듬기"로 지시만 보내 부분 수정도 된다. 적용 직전 상태는 되돌릴 수 있다.
 */

const PRESETS = [
  "커머스 데이터플랫폼팀. 주간 매출 리포트 숫자가 이상하다는 CS 제보 — 환불·취소·기간 밖 데이터가 섞이는 집계 버그. medium",
  "LLM 서빙팀. vLLM 을 docker compose 로 띄우는데 GPU 메모리 부족으로 죽는다 — 모델·tensor-parallel·max-model-len 설정을 대화로 파악해 compose 를 고친다. hard",
  "SRE. API 게이트웨이 라우팅 설정과 실제 요청 로그(jsonl)가 어긋나 비용이 폭증 — 로그를 분석해 라우팅 제안서(yaml+md)를 만든다. hard",
  "백엔드팀. 야간 배치가 가끔 중복 처리한다 — 로그와 코드에서 경쟁 조건을 찾아 멱등하게 고친다. hard",
];

export function ScenarioAuthorPanel({
  hasContent,
  getDraft,
  apply,
}: {
  hasContent: boolean;
  getDraft: () => ScenarioDraft;
  apply: (draft: ScenarioDraft) => void;
}) {
  const { toast, confirm } = useToast();
  const [open, setOpen] = useState(!hasContent);
  const [brief, setBrief] = useState("");
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState<"" | "create" | "refine">("");
  const [elapsed, setElapsed] = useState(0);
  const [result, setResult] = useState<AuthorResult | null>(null);
  const [providerName, setProviderName] = useState<string | null | undefined>(undefined);
  const undoRef = useRef<ScenarioDraft | null>(null);

  useEffect(() => {
    api
      .get<AiSettingsMeta>("/admin/settings/ai/meta")
      .then((m) => setProviderName(m.effective_chat?.name ?? null))
      .catch(() => setProviderName(null));
  }, []);

  useEffect(() => {
    if (!busy) return;
    setElapsed(0);
    const t = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [busy]);

  const run = async (mode: "create" | "refine") => {
    if (mode === "create" && !brief.trim()) return toast("어떤 시나리오를 만들지 한 줄이라도 적어 주세요", "info");
    if (mode === "refine" && !instruction.trim()) return toast("어떻게 다듬을지 적어 주세요", "info");
    if (mode === "create" && hasContent) {
      const ok = await confirm({
        title: "새로 설계할까요?",
        message: "지금 채워진 내용을 AI 가 설계한 시나리오로 바꿉니다. 적용 뒤 [되돌리기]로 복구할 수 있습니다.",
        confirmLabel: "새로 설계",
      });
      if (!ok) return;
    }
    setBusy(mode);
    try {
      const body =
        mode === "create"
          ? { brief }
          : { brief, draft: getDraft(), instruction };
      const r = await api.post<AuthorResult>("/scenarios/author", body);
      undoRef.current = getDraft();
      apply(r.scenario);
      setResult(r);
      setInstruction("");
      toast(
        r.warnings.length
          ? `시나리오를 채웠습니다 — 확인할 점 ${r.warnings.length}건`
          : "시나리오를 채웠습니다. 내용을 확인하고 저장하세요.",
        r.warnings.length ? "info" : "success",
      );
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "AI 작성에 실패했습니다", "error");
    } finally {
      setBusy("");
    }
  };

  const undo = () => {
    if (!undoRef.current) return;
    apply(undoRef.current);
    undoRef.current = null;
    setResult(null);
    toast("적용 전 상태로 되돌렸습니다", "info");
  };

  return (
    <div className="mb-5 overflow-hidden rounded-2xl border border-violet-200 bg-gradient-to-br from-violet-50 via-white to-sky-50">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-3 px-5 py-3.5 text-left"
      >
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500 to-sky-500 text-white shadow">
          <IconAgent size={18} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-bold text-slate-800">AI 로 시나리오 설계</span>
          <span className="block truncate text-xs text-slate-500">
            상황 한 줄이면 인물·정보 분산·초기 데이터·숨은 정답·자동 체크까지 설계해 채워 줍니다.
          </span>
        </span>
        <span className="shrink-0 text-xs text-slate-400">
          {providerName === undefined ? "" : providerName ? `공급자: ${providerName}` : "LLM 공급자 없음"}
        </span>
        <span className="shrink-0 text-slate-400">{open ? "접기" : "펼치기"}</span>
      </button>

      {open && (
        <div className="border-t border-violet-100 px-5 py-4">
          {providerName === null && (
            <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
              LLM 공급자가 설정되어 있지 않습니다. [설정]에서 먼저 등록하면 여기서 바로 쓸 수 있습니다.
            </p>
          )}

          {/* 새로 설계 */}
          <label className="block text-xs font-semibold text-slate-600">어떤 상황인가요?</label>
          <textarea
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            disabled={busy !== ""}
            rows={3}
            placeholder="팀·상황·무엇이 잘못됐는지·함정·난이도를 한두 줄로. 자세할수록 좋지만 한 줄이어도 됩니다."
            className="mt-1.5 w-full resize-none rounded-xl border border-slate-300 px-3.5 py-2.5 text-sm focus:border-violet-500 focus:outline-none disabled:bg-slate-50"
          />
          <div className="mt-2 flex flex-wrap gap-1.5">
            {PRESETS.map((p) => (
              <button
                key={p}
                onClick={() => setBrief(p)}
                disabled={busy !== ""}
                className="max-w-full truncate rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[11px] text-slate-500 transition hover:border-violet-300 hover:text-slate-800"
                title={p}
              >
                {p.slice(0, 44)}…
              </button>
            ))}
          </div>
          <div className="mt-3 flex items-center gap-3">
            <Button onClick={() => run("create")} disabled={busy !== "" || providerName === null}>
              {busy === "create" ? `설계 중… ${elapsed}s` : hasContent ? "새로 설계해 채우기" : "시나리오 설계해 채우기"}
            </Button>
            {busy !== "" && (
              <span className="text-xs text-slate-500">
                데이터 파일과 체크 값을 계산하느라 1~3분 걸릴 수 있습니다.
              </span>
            )}
          </div>

          {/* 다듬기 */}
          {hasContent && (
            <div className="mt-5 border-t border-violet-100 pt-4">
              <label className="block text-xs font-semibold text-slate-600">지금 초안을 다듬기</label>
              <div className="mt-1.5 flex gap-2">
                <input
                  value={instruction}
                  onChange={(e) => setInstruction(e.target.value)}
                  disabled={busy !== ""}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.nativeEvent.isComposing) run("refine");
                  }}
                  placeholder="예: QA 인물을 하나 더 넣고 재현 사례를 그 사람에게 옮겨 / 데이터를 40행으로 늘리고 체크를 다시 계산해 / 난이도를 hard 로"
                  className="min-w-0 flex-1 rounded-xl border border-slate-300 px-3.5 py-2 text-sm focus:border-violet-500 focus:outline-none disabled:bg-slate-50"
                />
                <Button variant="secondary" onClick={() => run("refine")} disabled={busy !== "" || providerName === null}>
                  {busy === "refine" ? `다듬는 중… ${elapsed}s` : "다듬기"}
                </Button>
              </div>
            </div>
          )}

          {/* 결과 */}
          {result && (
            <div className="mt-4 rounded-xl border border-slate-200 bg-white p-4">
              <div className="flex items-start justify-between gap-3">
                <p className="text-xs font-semibold uppercase tracking-wider text-violet-600">설계 노트</p>
                <div className="flex items-center gap-2">
                  {undoRef.current && (
                    <button onClick={undo} className="text-xs text-slate-500 underline-offset-2 hover:underline">
                      되돌리기
                    </button>
                  )}
                  <button onClick={() => setResult(null)} className="text-slate-400 hover:text-slate-600">
                    <IconClose size={14} />
                  </button>
                </div>
              </div>
              <p className="mt-1.5 whitespace-pre-wrap text-[13px] leading-relaxed text-slate-700">
                {result.notes || "(노트 없음)"}
              </p>
              {result.warnings.length > 0 && (
                <ul className="mt-3 space-y-1 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  {result.warnings.map((w, i) => (
                    <li key={i} className="flex items-start gap-1.5">
                      <IconWarn size={12} className="mt-0.5 shrink-0" /> {w}
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-2 text-[11px] text-slate-400">
                각 탭에 채워 두었습니다. 데이터와 체크 값이 맞는지 확인한 뒤 저장하세요. ({result.provider})
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

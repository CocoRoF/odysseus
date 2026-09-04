"use client";

import { useEffect, useRef, useState } from "react";
import { api, streamScenarioAuthor } from "@/lib/api";
import type { AiSettingsMeta, AuthorOp, ScenarioDraft } from "@/lib/types";
import { useToast } from "@/components/toast";
import { IconAgent, IconSend } from "@/components/icons";

/**
 * 시나리오 설계 대화 — 스튜디오 우측에 상주하는 AI 설계자.
 *
 * 한 번에 끝나지 않는다. "커머스 매출 리포트 버그, medium" 으로 시작해 "QA 를 하나
 * 더", "데이터를 40행으로", "함정을 더 어렵게" 를 이어 가며 고도화한다. AI 가 내는
 * 편집 명령은 도착하는 즉시 왼쪽 편집기에 반영되고 그 필드가 빛난다 — 무엇을
 * 고치는 중인지 눈으로 따라갈 수 있다. 저장은 사람이 한다.
 */

interface Turn {
  id: number;
  role: "user" | "assistant";
  text: string;
  edits: string[];
  warnings: string[];
  raw?: string;            // 모델이 낸 원문 (다음 턴의 대화 이력으로 보낸다)
  snapshot?: ScenarioDraft; // 이 턴을 적용하기 전의 초안 (되돌리기)
  stopped?: boolean;
}

const PRESETS = [
  "커머스 데이터플랫폼팀. 주간 매출 리포트 숫자가 이상하다는 CS 제보 — 환불·취소·기간 밖 데이터가 섞이는 집계 버그. medium",
  "LLM 서빙팀. vLLM 을 docker compose 로 띄우는데 GPU 메모리 부족으로 죽는다 — 설정을 대화로 파악해 compose 를 고친다. hard",
  "SRE. API 게이트웨이 라우팅과 요청 로그(jsonl)가 어긋나 비용 폭증 — 로그를 분석해 라우팅 제안서를 만든다. hard",
  "백엔드팀. 야간 배치가 가끔 중복 처리한다 — 경쟁 조건을 찾아 멱등하게 고친다. hard",
];

const FOLLOWUPS = ["QA 인물을 하나 더 넣고 재현 사례를 그쪽으로", "데이터를 40행으로 늘리고 체크를 다시 계산해", "함정을 하나 더 심어", "브리핑을 더 소설처럼"];

let seq = 1;

export function ScenarioAuthorChat({
  hasContent,
  getDraft,
  applyOp,
  applyScenario,
  onStreaming,
}: {
  hasContent: boolean;
  getDraft: () => ScenarioDraft;
  applyOp: (op: AuthorOp) => void;
  applyScenario: (s: ScenarioDraft) => void;
  onStreaming: (streaming: boolean) => void;
}) {
  const { toast } = useToast();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [providerName, setProviderName] = useState<string | null | undefined>(undefined);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    api
      .get<AiSettingsMeta>("/admin/settings/ai/meta")
      .then((m) => setProviderName(m.effective_chat?.name ?? null))
      .catch(() => setProviderName(null));
  }, []);

  useEffect(() => {
    if (!streaming) return;
    setElapsed(0);
    const t = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [streaming]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [turns]);

  const patchLast = (fn: (t: Turn) => Turn) =>
    setTurns((arr) => arr.map((t, i) => (i === arr.length - 1 ? fn(t) : t)));

  const send = async (text: string) => {
    const content = text.trim();
    if (!content || streaming) return;
    if (providerName === null) return toast("LLM 공급자를 먼저 등록하세요", "info");
    setInput("");
    const snapshot = getDraft();
    const history = [
      ...turns.map((t) => ({ role: t.role, content: t.role === "assistant" ? (t.raw ?? t.text) : t.text })),
      { role: "user" as const, content },
    ];
    setTurns((arr) => [
      ...arr,
      { id: seq++, role: "user", text: content, edits: [], warnings: [] },
      { id: seq++, role: "assistant", text: "", edits: [], warnings: [], snapshot },
    ]);
    setStreaming(true);
    onStreaming(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      await streamScenarioAuthor(
        { messages: history, draft: snapshot },
        {
          onDelta: (d) => patchLast((t) => ({ ...t, text: t.text + d })),
          onEdit: (op, label) => {
            applyOp(op);
            patchLast((t) => ({ ...t, edits: [...t.edits, label] }));
          },
          onWarning: (w) => patchLast((t) => ({ ...t, warnings: [...t.warnings, w] })),
          onDone: (scenario, warnings, raw) => {
            applyScenario(scenario); // 서버가 정규화한 최종본으로 맞춘다
            patchLast((t) => ({ ...t, raw, warnings: Array.from(new Set([...t.warnings, ...warnings])) }));
          },
          onError: (m) => patchLast((t) => ({ ...t, text: `${t.text}\n\n⚠ ${m}`.trim() })),
        },
        ctrl.signal,
      );
    } catch (e) {
      if ((e as Error).name === "AbortError") patchLast((t) => ({ ...t, stopped: true }));
      else patchLast((t) => ({ ...t, text: `${t.text}\n\n⚠ ${(e as Error).message}`.trim() }));
    } finally {
      abortRef.current = null;
      setStreaming(false);
      onStreaming(false);
      inputRef.current?.focus();
    }
  };

  const stop = () => abortRef.current?.abort();

  const undoTurn = (turnId: number) => {
    const idx = turns.findIndex((t) => t.id === turnId);
    const t = turns[idx];
    if (!t?.snapshot) return;
    applyScenario(t.snapshot);
    // 이 턴과 그 질문을 이력에서 지운다 — 모델이 "적용했다"고 기억하면 안 된다
    setTurns((arr) => arr.filter((x, i) => i !== idx && i !== idx - 1));
    toast("이 턴을 적용하기 전으로 되돌렸습니다", "info");
  };

  const lastAssistant = [...turns].reverse().find((t) => t.role === "assistant");

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-2xl border border-violet-200 bg-white shadow-sm">
      {/* 머리 */}
      <div className="flex items-center gap-3 border-b border-violet-100 bg-gradient-to-r from-violet-50 to-sky-50 px-4 py-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500 to-sky-500 text-white shadow">
          <IconAgent size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold text-slate-800">시나리오 설계자</p>
          <p className="truncate text-[11px] text-slate-500">
            {providerName === undefined ? "공급자 확인 중…" : providerName ? providerName : "LLM 공급자 없음 — [설정]에서 등록"}
          </p>
        </div>
        {streaming && (
          <span className="flex items-center gap-1.5 rounded-full bg-violet-600 px-2.5 py-1 text-[11px] font-semibold text-white">
            <span className="h-1.5 w-1.5 animate-ping rounded-full bg-white" />
            편집 중 {elapsed}s
          </span>
        )}
      </div>

      {/* 대화 */}
      <div ref={scrollRef} className="thin-scroll min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {turns.length === 0 && (
          <div className="space-y-3">
            <div className="rounded-2xl rounded-tl-md border border-slate-200 bg-slate-50 px-3.5 py-3 text-[13px] leading-relaxed text-slate-700">
              어떤 상황을 시험으로 만들까요? 팀·무엇이 잘못됐는지·난이도를 한 줄만 주시면 인물·정보 분산·초기 데이터·숨은 정답·자동 체크까지
              설계해 왼쪽에 채웁니다. 그 뒤로는 계속 대화하며 다듬으면 됩니다.
            </div>
            <div className="space-y-1.5">
              {(hasContent ? FOLLOWUPS : PRESETS).map((p) => (
                <button
                  key={p}
                  onClick={() => send(p)}
                  disabled={streaming || providerName === null}
                  className="block w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-left text-[12px] leading-snug text-slate-600 transition hover:border-violet-300 hover:bg-violet-50/40 disabled:opacity-50"
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
        )}

        {turns.map((t) =>
          t.role === "user" ? (
            <div key={t.id} className="flex justify-end">
              <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-slate-900 px-3.5 py-2 text-[13px] text-white">
                {t.text}
              </div>
            </div>
          ) : (
            <div key={t.id} className="max-w-[92%]">
              <div className="rounded-2xl rounded-tl-md border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-[13px] leading-relaxed text-slate-700">
                {t.text ? (
                  <span className="whitespace-pre-wrap">{t.text}</span>
                ) : streaming && t === lastAssistant ? (
                  <span className="text-slate-400">설계를 시작합니다…</span>
                ) : null}
                {streaming && t === lastAssistant && <span className="ai-caret ml-0.5 inline-block h-3.5 w-[2px] bg-violet-500 align-middle" />}
                {t.edits.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {t.edits.map((e, i) => (
                      <span
                        key={i}
                        className={`rounded-full px-2 py-0.5 text-[10.5px] font-medium ${
                          streaming && t === lastAssistant && i === t.edits.length - 1
                            ? "ai-chip-live bg-violet-600 text-white"
                            : "bg-violet-100 text-violet-700"
                        }`}
                      >
                        ✎ {e}
                      </span>
                    ))}
                  </div>
                )}
                {t.warnings.length > 0 && (
                  <ul className="mt-2 space-y-0.5 rounded-lg bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-800">
                    {t.warnings.map((w, i) => (
                      <li key={i}>· {w}</li>
                    ))}
                  </ul>
                )}
                {t.stopped && <p className="mt-1.5 text-[11px] text-slate-400">중단됨 — 여기까지의 편집은 적용되어 있습니다.</p>}
              </div>
              {!streaming && t === lastAssistant && t.snapshot && t.edits.length > 0 && (
                <button onClick={() => undoTurn(t.id)} className="mt-1 text-[11px] text-slate-400 underline-offset-2 hover:text-slate-700 hover:underline">
                  이 턴 되돌리기
                </button>
              )}
            </div>
          ),
        )}
      </div>

      {/* 입력 */}
      <div className="border-t border-slate-200 p-3">
        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              e.target.style.height = "auto";
              e.target.style.height = `${Math.min(e.target.scrollHeight, 120)}px`;
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send(input);
              }
            }}
            disabled={providerName === null}
            rows={1}
            placeholder={turns.length === 0 ? "어떤 상황인가요? (Enter 로 보내기)" : "이어서 다듬을 점을 말해 주세요"}
            className="thin-scroll max-h-[120px] min-h-[42px] flex-1 resize-none rounded-xl border border-slate-300 px-3.5 py-2.5 text-[13px] focus:border-violet-500 focus:outline-none disabled:bg-slate-50"
          />
          {streaming ? (
            <button
              onClick={stop}
              title="중단"
              className="flex h-[42px] shrink-0 items-center justify-center rounded-xl bg-red-500 px-3 text-xs font-semibold text-white transition hover:bg-red-600"
            >
              중단
            </button>
          ) : (
            <button
              onClick={() => send(input)}
              disabled={!input.trim() || providerName === null}
              title="보내기"
              className="flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-xl bg-violet-600 text-white transition hover:bg-violet-500 disabled:bg-slate-200 disabled:text-slate-400"
            >
              <IconSend size={16} />
            </button>
          )}
        </div>
        {streaming && (
          <p className="mt-1.5 text-[11px] text-slate-400">데이터 파일과 체크 값을 계산하느라 1~3분 걸릴 수 있습니다. 편집은 도착하는 대로 왼쪽에 반영됩니다.</p>
        )}
      </div>
    </div>
  );
}

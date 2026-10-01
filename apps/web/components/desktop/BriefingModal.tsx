"use client";

import { useEffect } from "react";
import { Markdown } from "@/components/Markdown";
import { Button } from "@/components/ui";
import { IconClose } from "@/components/icons";

/** 브리핑 카드 — 시험 도입부.
 *
 *  처음에는 "업무 시작하기"로 데스크톱을 여는 문이고(start), 그 뒤로는 작업 표시줄의
 *  [브리핑]으로 **언제든 다시 읽는** 창이다(review). 도입부는 이 시험의 유일한 상황
 *  설명이라 한 번 보고 사라지면 응시자가 자기가 누구이고 무엇이 벌어졌는지를 다시
 *  확인할 길이 없었다.
 */
export function BriefingModal({
  mode,
  title,
  chapter,
  briefing,
  notes,
  onStart,
  onClose,
}: {
  mode: "start" | "review";
  title: string;
  chapter?: string | null;
  briefing: string;
  notes: string[];
  onStart?: () => void;
  onClose?: () => void;
}) {
  const review = mode === "review";

  useEffect(() => {
    if (!review) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [review, onClose]);

  return (
    <div
      className="absolute inset-0 z-[9500] flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-sm"
      onClick={review ? onClose : undefined}
      role="dialog"
      aria-modal="true"
      aria-label={review ? "브리핑 다시 보기" : "시험 브리핑"}
    >
      <div
        className="window-shadow flex max-h-[85vh] w-full max-w-2xl flex-col rounded-2xl bg-white"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="shrink-0 px-7 pb-4 pt-7">
          <div className="flex items-center gap-2">
            <p className="text-xs font-bold uppercase tracking-widest text-sky-500">Odysseus</p>
            {chapter && (
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-500">
                {chapter}
              </span>
            )}
            {review && (
              <span className="rounded-full bg-sky-50 px-2 py-0.5 text-[11px] font-semibold text-sky-600">
                브리핑 다시 보기
              </span>
            )}
            {review && (
              <button
                onClick={onClose}
                title="닫기 (Esc)"
                className="ml-auto flex h-7 w-7 items-center justify-center rounded-lg text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
              >
                <IconClose size={15} />
              </button>
            )}
          </div>
          <h2 className="mt-1 text-xl font-bold">{title}</h2>
        </div>
        <div className="thin-scroll min-h-0 flex-1 overflow-y-auto px-7">
          <div className="rounded-xl bg-slate-50 p-5">
            {briefing ? (
              <Markdown>{briefing}</Markdown>
            ) : (
              <p className="text-sm text-slate-600">출근했습니다. 메신저에 새 메시지가 와 있습니다.</p>
            )}
          </div>
          <ul className="mt-4 space-y-1 pb-2 text-xs text-slate-500">
            {notes.map((n, i) => (
              <li key={i}>· {n}</li>
            ))}
          </ul>
        </div>
        <div className="shrink-0 px-7 pb-7 pt-4">
          {review ? (
            <Button className="w-full" variant="secondary" onClick={onClose}>
              닫기
            </Button>
          ) : (
            <Button className="w-full" onClick={onStart}>
              업무 시작하기
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

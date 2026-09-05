"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

/** 굵게(**…**)·코드(`…`)만 인지하는 최소 인라인 파서 — 타자기 연출과 함께 쓰려면
 *  마크다운 렌더러 대신 세그먼트 단위로 잘라 두어야 부분 노출이 가능하다. */
interface Seg {
  text: string;
  bold?: boolean;
  code?: boolean;
}

function parseInline(line: string): Seg[] {
  const out: Seg[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    if (m.index > last) out.push({ text: line.slice(last, m.index) });
    const token = m[0];
    if (token.startsWith("**")) out.push({ text: token.slice(2, -2), bold: true });
    else out.push({ text: token.slice(1, -1), code: true });
    last = m.index + token.length;
  }
  if (last < line.length) out.push({ text: line.slice(last) });
  return out.length ? out : [{ text: "" }];
}

/** 브리핑(Markdown)을 연출용 문단으로 자른다. 빈 줄이 문단 경계. */
function toParagraphs(md: string): Seg[][] {
  return md
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((block) =>
      block
        .split("\n")
        .map((l) => l.replace(/^#{1,6}\s+/, "").replace(/^[-*]\s+/, "· ").trim())
        .filter(Boolean)
        .join(" "),
    )
    .filter(Boolean)
    .map(parseInline);
}

const CHAR_MS = 26; // 한 글자 노출 간격
const PARA_PAUSE_MS = 620; // 문단 사이 여백

/** 시네마틱 인트로 — 검은 화면에 도입부를 한 문단씩 타이핑해 보여주고,
 *  낭독이 끝나면 시작 버튼이 떠오른다. (설정: 게이미피케이션) */
export function IntroCinematic({
  brand = "ODYSSEUS",
  title,
  chapter,
  briefing,
  notes,
  onStart,
}: {
  brand?: string;
  title: string;
  chapter?: string | null;
  briefing: string;
  notes: string[];
  onStart: () => void;
}) {
  const paragraphs = useMemo(() => toParagraphs(briefing), [briefing]);
  const lengths = useMemo(() => paragraphs.map((p) => p.reduce((n, s) => n + s.text.length, 0)), [paragraphs]);

  const [stage, setStage] = useState<"title" | "typing" | "done">("title");
  const [para, setPara] = useState(0); // 현재 타이핑 중인 문단
  const [chars, setChars] = useState(0); // 현재 문단에서 노출된 글자 수

  /** 남은 연출을 건너뛰고 전부 노출 */
  const skip = useCallback(() => {
    setStage("done");
    setPara(paragraphs.length);
    setChars(0);
  }, [paragraphs.length]);

  // 타이틀 → 타이핑 시작
  useEffect(() => {
    if (stage !== "title") return;
    const t = setTimeout(() => setStage("typing"), 900);
    return () => clearTimeout(t);
  }, [stage]);

  // 글자 단위 노출
  useEffect(() => {
    if (stage !== "typing") return;
    if (para >= paragraphs.length) {
      setStage("done");
      return;
    }
    if (chars < lengths[para]) {
      const t = setTimeout(() => setChars((c) => c + 1), CHAR_MS);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => {
      setPara((p) => p + 1);
      setChars(0);
    }, PARA_PAUSE_MS);
    return () => clearTimeout(t);
  }, [stage, para, chars, lengths, paragraphs.length]);

  // 클릭/스페이스/엔터로 건너뛰기, 완료 후에는 시작
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== " " && e.key !== "Enter") return;
      e.preventDefault();
      if (stage === "done") onStart();
      else skip();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [stage, skip, onStart]);

  // 문단은 처음부터 전체 길이로 그려 둔다 (레이아웃 고정). 아직 드러나지 않은 글자는
  // visibility:hidden 이라 자리는 차지하되 보이지 않는다 — 줄이 늘어도 화면이 밀리거나
  // 스크롤이 생기지 않는다. reveal = null 이면 전부 보이고, 0 이면 전부 숨긴다.
  const renderParagraph = (segs: Seg[], reveal: number | null) => {
    let left = reveal ?? Number.POSITIVE_INFINITY;
    return segs.map((seg, i) => {
      const n = Math.max(0, Math.min(seg.text.length, left));
      left -= seg.text.length;
      const shown = seg.text.slice(0, n);
      const hidden = seg.text.slice(n);
      const inner = (
        <>
          {shown}
          {hidden && <span className="invisible">{hidden}</span>}
        </>
      );
      if (seg.code) {
        return (
          <code key={i} className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-[0.92em] text-sky-200">
            {inner}
          </code>
        );
      }
      return (
        <span key={i} className={seg.bold ? "font-semibold text-white" : undefined}>
          {inner}
        </span>
      );
    });
  };

  return (
    <div
      className="intro-stage absolute inset-0 z-[9500] flex flex-col items-center justify-center overflow-hidden bg-black px-6"
      onClick={() => (stage === "done" ? undefined : skip())}
    >
      {/* 은은한 비네트 */}
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(120%_90%_at_50%_0%,rgba(56,189,248,0.10),transparent_60%)]" />

      {stage !== "done" && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            skip();
          }}
          className="absolute right-6 top-6 z-10 rounded-lg border border-white/15 px-3 py-1.5 text-xs text-slate-400 transition hover:border-white/30 hover:text-slate-200"
        >
          건너뛰기
        </button>
      )}

      <div className="relative flex w-full max-w-3xl flex-col" style={{ maxHeight: "88vh" }}>
        {/* 표제 */}
        <div className="intro-fade shrink-0 text-center">
          <p className="text-[11px] font-bold uppercase tracking-[0.4em] text-sky-400/80">{brand}</p>
          <h1 className="mt-2 text-2xl font-bold tracking-tight text-slate-100 md:text-3xl">{title}</h1>
          {chapter && <p className="mt-1.5 text-xs tracking-widest text-slate-500">{chapter}</p>}
          <div className="mx-auto mt-6 h-px w-24 bg-gradient-to-r from-transparent via-sky-400/50 to-transparent" />
        </div>

        {/* 낭독 */}
        <div className="intro-read mt-8 min-h-0 flex-1 overflow-y-auto px-1">
          <div className="space-y-5 text-[15px] leading-[1.9] text-slate-300 md:text-base">
            {paragraphs.map((segs, i) => {
              const typing = stage === "typing" && i === para;
              const reveal = stage === "title" ? 0 : stage === "done" ? null : i < para ? null : typing ? chars : 0;
              return (
                <p key={i}>
                  {renderParagraph(segs, reveal)}
                  {typing && <span className="intro-caret ml-0.5 text-sky-400">▌</span>}
                </p>
              );
            })}
          </div>
        </div>

        {/* 완료 후: 안내 + 시작 */}
        <div
          className={`mt-8 shrink-0 ${stage === "done" ? "intro-rise" : "invisible"}`}
          aria-hidden={stage !== "done"}
          onClick={(e) => e.stopPropagation()}
        >
          <ul className="space-y-1 text-[11px] leading-relaxed text-slate-500">
            {notes.map((n, i) => (
              <li key={i}>· {n}</li>
            ))}
          </ul>
          <button
            onClick={onStart}
            disabled={stage !== "done"}
            className="mt-5 w-full rounded-xl border border-sky-400/30 bg-sky-500/10 py-3.5 text-sm font-bold tracking-wide text-sky-200 transition hover:border-sky-400/60 hover:bg-sky-500/20 hover:text-white"
          >
            임무 시작
          </button>
        </div>
      </div>
    </div>
  );
}

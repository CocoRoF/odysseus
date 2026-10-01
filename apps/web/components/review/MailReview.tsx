"use client";

import { useEffect, useMemo, useState } from "react";
import { displayName, isInboxPath, isMailFile, parseMail } from "@/lib/mail";
import { fmtDateTime } from "@/lib/format";
import type { ReviewEvent } from "@/lib/types";
import { useWorkspace } from "@/components/desktop/workspace";
import { EmptyState, Spinner } from "@/components/ui";

/** 채점 화면의 [메일] — 응시자가 메일로 무엇을 했는지 그대로 본다.
 *
 *  파일 목록만 보여 주면 채점자는 `output/reply.md` 라는 이름에서 "보냈다" 를 유추해야 한다.
 *  그런데 사무 과제에서 **보냈는가**·**누구에게 보냈는가** 는 글의 내용과 별개의 평가 대상이고,
 *  그 답은 파일이 아니라 서버가 남긴 발송 기록에 있다(routers/mail.py).
 *
 *  그래서 세 묶음으로 나눈다.
 *
 *  · **보낸 메일** — 발송 기록이 있는 것. 언제·누구에게·참조까지 기록 그대로.
 *  · **보내지 않은 초안** — 메일 꼴로 써 두고 보내지 않은 파일. 글은 썼지만 업무는 끝나지 않았다.
 *  · **받은 메일** — 시나리오가 넣어 둔 편지함. 무엇에 답해야 했는지의 맥락이다.
 */
export function MailReview({ scenarioId, events }: { scenarioId: string; events: ReviewEvent[] | null }) {
  const ws = useWorkspace();
  const [picked, setPicked] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState("");

  /** 서버가 남긴 발송 기록 — 이 화면에서 가장 확실한 사실이다 */
  const sent = useMemo(() => {
    const rows = (events ?? []).filter((e) => e.type === "mail_sent" && e.scenario_id === scenarioId);
    return rows.map((e) => ({
      at: e.created_at,
      to: String(e.payload.to ?? ""),
      cc: String(e.payload.cc ?? ""),
      subject: String(e.payload.subject ?? ""),
      path: String(e.payload.path ?? ""),
      words: Number(e.payload.words ?? 0),
      quoted: Boolean(e.payload.quoted),
    }));
  }, [events, scenarioId]);

  const sentPaths = useMemo(() => new Set(sent.map((s) => s.path)), [sent]);

  const inbox = useMemo(
    () => ws.files.filter((f) => isInboxPath(f.path) && isMailFile(f.path)).map((f) => f.path),
    [ws.files],
  );

  /** 메일처럼 생겼는데 보낸 기록이 없는 파일 — 받은 편지함도 아닌 것 */
  const [drafts, setDrafts] = useState<string[]>([]);
  // 파일 목록은 10초마다 새 배열로 들어온다(workspace 폴링). 내용이 그대로면 다시 읽지 않도록
  // 경로와 해시로 열쇠를 만든다 — 그러지 않으면 채점 화면이 10초마다 파일을 전부 다시 내려받는다.
  const draftKey = useMemo(
    () =>
      ws.files
        .filter((f) => isMailFile(f.path) && !isInboxPath(f.path) && !sentPaths.has(f.path) && !ws.isInitial(f.path))
        .map((f) => `${f.path}:${f.sha256}`)
        .join("|"),
    [ws, sentPaths],
  );
  useEffect(() => {
    let alive = true;
    const paths = draftKey ? draftKey.split("|").map((x) => x.slice(0, x.lastIndexOf(":"))) : [];
    // 머리글이 있는 것만 초안으로 본다 — 보고서를 초안이라고 부르면 채점자를 헷갈리게 한다.
    Promise.all(
      paths.map((path) =>
        ws
          .loadContent(path)
          .then((c) => (parseMail(c.content).hasHeaders ? path : null))
          .catch(() => null),
      ),
    ).then((found) => {
      if (alive) setDrafts(found.filter((x): x is string => Boolean(x)));
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey]);

  // 처음 열면 보낸 메일 하나를 펴 둔다 — 채점자가 가장 먼저 볼 것이 그것이다.
  useEffect(() => {
    if (picked) return;
    const first = sent[0]?.path || drafts[0] || inbox[0] || null;
    if (first) setPicked(first);
  }, [sent, drafts, inbox, picked]);

  useEffect(() => {
    if (!picked) return;
    setContent(null);
    setError("");
    ws.loadContent(picked)
      .then((c) => setContent(c.content))
      .catch(() => setError("파일을 불러올 수 없습니다"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picked]);

  const nothing = sent.length === 0 && drafts.length === 0 && inbox.length === 0;
  if (ws.loading && nothing) return <Spinner />;
  if (nothing) return <EmptyState message="메일을 주고받은 기록이 없습니다." />;

  const parsed = content === null ? null : parseMail(content);
  const record = sent.find((s) => s.path === picked) ?? null;

  return (
    <div className="flex h-full min-h-0">
      {/* 왼쪽 — 무엇이 오갔는가 */}
      <div className="thin-scroll w-72 shrink-0 overflow-y-auto border-r border-slate-200 bg-slate-50">
        <Group label="보낸 메일" count={sent.length}>
          {sent.length === 0 ? (
            <p className="px-3 py-2 text-xs text-slate-400">보낸 메일이 없습니다</p>
          ) : (
            sent.map((s) => (
              <button
                key={`${s.at}-${s.path}`}
                onClick={() => setPicked(s.path)}
                className={`block w-full border-b border-slate-200/70 px-3 py-2 text-left ${
                  picked === s.path ? "bg-white" : "hover:bg-white/60"
                }`}
              >
                <span className="block truncate text-xs font-semibold text-slate-800">
                  {s.subject || "(제목 없음)"}
                </span>
                <span className="mt-0.5 block truncate text-[11px] text-slate-500">
                  {displayName(s.to) || "(수신자 미정)"}
                  {s.cc && ` · 참조 ${displayName(s.cc)}`}
                </span>
                <span className="mt-0.5 block text-[11px] text-slate-400">{fmtDateTime(s.at)} 보냄</span>
              </button>
            ))
          )}
        </Group>

        {drafts.length > 0 && (
          <Group label="보내지 않은 초안" count={drafts.length}>
            {drafts.map((p) => (
              <Row key={p} path={p} picked={picked === p} onClick={() => setPicked(p)} />
            ))}
          </Group>
        )}

        <Group label="받은 메일" count={inbox.length}>
          {inbox.length === 0 ? (
            <p className="px-3 py-2 text-xs text-slate-400">시나리오가 넣어 둔 메일이 없습니다</p>
          ) : (
            inbox.map((p) => <Row key={p} path={p} picked={picked === p} onClick={() => setPicked(p)} />)
          )}
        </Group>
      </div>

      {/* 오른쪽 — 고른 메일 */}
      <div className="thin-scroll min-w-0 flex-1 overflow-y-auto bg-white">
        {!picked ? (
          <div className="flex h-full items-center justify-center text-sm text-slate-400">왼쪽에서 메일을 고르세요</div>
        ) : error ? (
          <div className="flex h-full items-center justify-center text-sm text-red-500">{error}</div>
        ) : parsed === null ? (
          <div className="p-6">
            <Spinner />
          </div>
        ) : (
          <article className="p-5">
            <h3 className="text-base font-bold text-slate-900">
              {parsed.headers.subject || "(제목 없음)"}
            </h3>
            <dl className="mt-3 grid grid-cols-[3.5rem_1fr] gap-x-3 gap-y-1 text-xs">
              {parsed.headers.from && <Line label="보낸사람" value={parsed.headers.from} />}
              {parsed.headers.to && <Line label="받는사람" value={parsed.headers.to} />}
              {parsed.headers.cc && <Line label="참조" value={parsed.headers.cc} />}
              {parsed.headers.date && <Line label="날짜" value={parsed.headers.date} />}
              <Line label="파일" value={picked} mono />
            </dl>

            {record && (
              // 서버가 남긴 사실. 파일 머리글은 응시자가 고쳐 쓸 수 있지만 이 줄은 그렇지 않다.
              <p className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
                {fmtDateTime(record.at)} 보냄 · 받는사람 {displayName(record.to) || "(수신자 미정)"}
                {record.cc && ` · 참조 ${displayName(record.cc)}`} · 본문 {record.words}단어
                {record.quoted && " · 원문 인용"}
              </p>
            )}
            {!record && !isInboxPath(picked) && (
              <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
                보낸 기록이 없습니다 — 파일로만 남은 초안입니다.
              </p>
            )}

            <div className="mt-4 whitespace-pre-wrap break-words border-t border-slate-100 pt-4 text-sm leading-7 text-slate-700">
              {parsed.body || "(본문 없음)"}
            </div>
          </article>
        )}
      </div>
    </div>
  );
}

function Group({ label, count, children }: { label: string; count: number; children: React.ReactNode }) {
  return (
    <section>
      <h4 className="sticky top-0 z-10 flex items-center justify-between bg-slate-100/95 px-3 py-1.5 text-[11px] font-semibold text-slate-500">
        {label}
        <span className="text-slate-400">{count}</span>
      </h4>
      {children}
    </section>
  );
}

function Row({ path, picked, onClick }: { path: string; picked: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`block w-full border-b border-slate-200/70 px-3 py-2 text-left ${
        picked ? "bg-white" : "hover:bg-white/60"
      }`}
    >
      <span className="block truncate text-xs text-slate-700">{path.split("/").pop()}</span>
      <span className="mt-0.5 block truncate text-[11px] text-slate-400">{path}</span>
    </button>
  );
}

function Line({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <>
      <dt className="text-slate-400">{label}</dt>
      <dd className={`min-w-0 break-words text-slate-700${mono ? " font-mono text-[11px]" : ""}`}>{value}</dd>
    </>
  );
}

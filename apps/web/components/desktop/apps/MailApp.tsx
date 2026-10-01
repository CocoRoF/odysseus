"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Markdown } from "@/components/Markdown";
import { useToast } from "@/components/toast";
import { copyText, selectedText } from "@/lib/clipboard";
import { IconInbox, IconMail, IconRefresh, IconReply, IconSend } from "@/components/icons";
import { displayName, isInboxPath, isMailFile, parseMail, quoteBody, replySubject } from "@/lib/mail";
import { ContextMenuView, MenuEntry, useContextMenu } from "../ContextMenu";
import { isKeepPath, useWorkspaceAs } from "../workspace";
import { Recipients } from "./mail/Recipients";
import type { AttemptCharacter } from "@/lib/types";

/** 단어 수 — 서버의 분량 체크와 같은 규칙(글자가 있는 공백 토큰만 센다). */
function countWords(text: string): number {
  return text.split(/\s+/).filter((t) => /[0-9A-Za-z가-힣]/.test(t)).length;
}

/** 파일 경로에서 기본 회신 파일명을 만든다 — 같은 이름을 덮어쓰지 않도록. */
function suggestReplyPath(existing: Set<string>, base: string): string {
  const clean = base.replace(/[^0-9A-Za-z가-힣_-]+/g, "_").replace(/^_+|_+$/g, "") || "reply";
  let path = `output/${clean}.md`;
  let n = 2;
  while (existing.has(path)) path = `output/${clean}_${n++}.md`;
  return path;
}

interface MailItem {
  path: string;
  subject: string;
  who: string;
  date: string;
  preview: string;
}

type Pane = { kind: "read"; path: string } | { kind: "compose" } | { kind: "empty" };

/** 메일 — 시험장의 사내 메일 클라이언트.
 *
 *  사무 업무의 절반은 "받은 메일에 어떻게 답하는가" 다. 그 절반을 문서 편집기로
 *  대신하면, 응시자는 누구에게 무엇을 보내는지가 아니라 파일을 만드는 일부터
 *  생각하게 된다. 그래서 받은 편지함과 작성 창을 따로 둔다.
 *
 *  다만 저장소는 새로 만들지 않는다. 받은 메일은 시나리오가 넣어 둔 `mail/`·`inbox/`
 *  파일이고, 보낸 메일은 `output/` 아래 파일이다. 보내기는 파일을 남기는 동시에 **보냈다는 사실**을
 *  서버에 기록한다(routers/mail.py) — 파일만 보면 "이 문서를 썼다" 까지만 보이고, 받는 사람을
 *  빠뜨렸는지는 사무 과제에서 그 자체로 평가 대상이기 때문이다.
 *
 *  회신에 원문을 인용할지는 응시자가 고른다(기본은 인용하지 않음). 인용을 기본으로
 *  두면 고객이 쓴 문장이 회신문에 섞여 들어가 "무엇을 스스로 썼는가" 가 흐려진다.
 */
export function MailApp({
  people = [],
}: {
  /** 이 시나리오의 등장인물 — 받는 사람 고르기가 쓴다 */
  people?: AttemptCharacter[];
} = {}) {
  const ws = useWorkspaceAs("mail");
  const { toast } = useToast();
  const { menu, open: openMenu, close: closeMenu } = useContextMenu();

  const [box, setBox] = useState<"inbox" | "sent">("inbox");
  const [pane, setPane] = useState<Pane>({ kind: "empty" });
  const [bodies, setBodies] = useState<Record<string, string>>({});

  // 작성 상태
  const [to, setTo] = useState("");
  const [cc, setCc] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [savePath, setSavePath] = useState("output/reply.md");
  const [quote, setQuote] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sentAt, setSentAt] = useState<string | null>(null);
  /** 파일 이름을 손으로 바꾸는 중 — 평소에는 접혀 있다 */
  const [pathOpen, setPathOpen] = useState(false);

  const paths = useMemo(() => ws.files.map((f) => f.path).filter((p) => !isKeepPath(p)), [ws.files]);

  const inboxPaths = useMemo(() => paths.filter((p) => isInboxPath(p) && isMailFile(p)).sort(), [paths]);

  /** 보낸 편지함 — 메일 앱이 쓴 파일(헤더에 받는사람/제목이 있는 output 문서). */
  const sentPaths = useMemo(
    () =>
      paths
        .filter((p) => !isInboxPath(p) && isMailFile(p))
        .filter((p) => {
          const text = bodies[p];
          if (text === undefined) return false;
          const parsed = parseMail(text);
          return parsed.hasHeaders && !!(parsed.headers.to || parsed.headers.subject);
        })
        .sort(),
    [paths, bodies],
  );

  // 읽기 창에 띄운 메일이 곧 **열어 본** 메일이다 — 목록 미리보기와 달리 이 읽기는 기록에 남는다.
  // 내용도 이때 다시 받아, 미리 읽어 둔 것이 낡았으면 새것으로 바꾼다.
  useEffect(() => {
    if (pane.kind !== "read") return;
    const p = pane.path;
    ws.loadContent(p)
      .then((fc) => setBodies((prev) => (prev[p] === fc.content ? prev : { ...prev, [p]: fc.content })))
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane.kind === "read" ? pane.path : null]);

  // 목록에 보여 줄 만큼은 내용을 미리 읽어 둔다 (제목·발신자·미리보기)
  useEffect(() => {
    const missing = paths.filter((p) => isMailFile(p) && bodies[p] === undefined).slice(0, 60);
    if (!missing.length) return;
    let alive = true;
    Promise.all(
      missing.map((p) =>
        ws
          // 목록을 채우려는 읽기다. 사람이 연 것이 아니니 열람으로 남기지 않는다.
          .loadContent(p, undefined, { quiet: true })
          .then((fc) => [p, fc.content] as const)
          .catch(() => [p, ""] as const),
      ),
    ).then((pairs) => {
      if (!alive) return;
      setBodies((prev) => {
        const next = { ...prev };
        for (const [p, text] of pairs) next[p] = text;
        return next;
      });
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paths.join("|")]);

  const itemOf = useCallback(
    (path: string): MailItem => {
      const text = bodies[path] ?? "";
      const { headers, body: mailBody } = parseMail(text);
      const name = path.split("/").pop() ?? path;
      return {
        path,
        subject: headers.subject?.trim() || name,
        who: displayName(box === "inbox" ? headers.from : headers.to) || (box === "inbox" ? "(발신자 없음)" : "(수신자 없음)"),
        date: headers.date?.trim() ?? "",
        preview: mailBody.replace(/[#>*_`|-]/g, " ").replace(/\s+/g, " ").trim().slice(0, 70),
      };
    },
    [bodies, box],
  );

  const list = useMemo(
    () => (box === "inbox" ? inboxPaths : sentPaths).map(itemOf),
    [box, inboxPaths, sentPaths, itemOf],
  );

  // 처음 열면 받은 메일 중 첫 통을 보여 준다 (빈 화면보다 낫다)
  useEffect(() => {
    if (pane.kind === "empty" && inboxPaths.length) setPane({ kind: "read", path: inboxPaths[0] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inboxPaths.length]);

  const startCompose = useCallback(
    (source?: { path: string }) => {
      const existing = new Set(paths);
      if (!source) {
        setTo("");
        setCc("");
        setSubject("");
        setBody("");
        setQuote(null);
        setSavePath(suggestReplyPath(existing, "mail"));
      } else {
        const { headers, body: original } = parseMail(bodies[source.path] ?? "");
        setTo(headers.from ?? "");
        setCc("");
        setSubject(replySubject(headers.subject ?? ""));
        setBody("");
        setQuote(quoteBody(original, displayName(headers.from)));
        const base = (source.path.split("/").pop() ?? "reply").replace(/\.[^.]+$/, "");
        setSavePath(suggestReplyPath(existing, `reply_to_${base}`));
      }
      setSentAt(null);
      setPane({ kind: "compose" });
    },
    [bodies, paths],
  );

  const openSent = useCallback(
    (path: string) => {
      const { headers, body: text } = parseMail(bodies[path] ?? "");
      setTo(headers.to ?? "");
      setCc(headers.cc ?? "");
      setSubject(headers.subject ?? "");
      setBody(text);
      setQuote(null);
      setSavePath(path);
      setSentAt(null);
      setPane({ kind: "compose" });
    },
    [bodies],
  );

  const send = useCallback(
    async (withQuote: boolean) => {
      const path = savePath.trim();
      if (!path) {
        toast("저장 경로를 입력하세요", "error");
        return;
      }
      if (!subject.trim()) {
        toast("제목이 비어 있습니다", "error");
        return;
      }
      setSending(true);
      try {
        // 보내기는 서버를 지난다. 파일을 쓰는 일과 "누구에게 무엇을 보냈다" 를 남기는 일이 한 번에
        // 끝나야 하고, 그 기록은 브라우저가 보고한 값이 아니어야 평가의 근거가 된다.
        const content = await ws.sendMail({
          to: to.trim() || "(수신자 미정)",
          cc: cc.trim(),
          subject: subject.trim(),
          body: withQuote && quote ? `${body}${quote}` : body,
          path,
          quoted: Boolean(withQuote && quote),
        });
        setBodies((prev) => ({ ...prev, [path]: content }));
        setSentAt(new Date().toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" }));
        toast(`${to.trim() || "수신자 미정"}에게 보냈습니다`, "success");
      } catch {
        toast("보내지 못했습니다", "error");
      } finally {
        setSending(false);
      }
    },
    [body, cc, quote, savePath, subject, to, ws, toast],
  );

  const copy = async (text: string, label: string) => {
    if (await copyText(text)) toast(`${label}을(를) 복사했습니다`, "success");
    else toast("복사에 실패했습니다", "error");
  };

  const inputCls =
    "w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-sm outline-none focus:border-rose-400";

  return (
    <div className="flex h-full bg-white text-slate-800">
      {/* 좌측 — 편지함과 목록 */}
      <div className="flex w-72 shrink-0 flex-col border-r border-slate-200 bg-slate-50">
        <div className="flex items-center gap-1 border-b border-slate-200 p-2">
          <button
            onClick={() => setBox("inbox")}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium ${
              box === "inbox" ? "bg-white text-rose-600 shadow-sm" : "text-slate-500 hover:bg-white/70"
            }`}
          >
            <IconInbox size={13} /> 받은 편지함
            <span className="text-[10px] text-slate-400">{inboxPaths.length}</span>
          </button>
          <button
            onClick={() => setBox("sent")}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium ${
              box === "sent" ? "bg-white text-rose-600 shadow-sm" : "text-slate-500 hover:bg-white/70"
            }`}
          >
            <IconSend size={13} /> 보낸 편지함
            <span className="text-[10px] text-slate-400">{sentPaths.length}</span>
          </button>
        </div>
        <div className="flex items-center gap-1 border-b border-slate-200 px-2 py-1.5">
          <button
            onClick={() => startCompose()}
            className="flex items-center gap-1.5 rounded-lg bg-rose-500 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-rose-600"
          >
            <IconMail size={13} /> 새 메일
          </button>
          <button
            onClick={() => ws.refresh()}
            title="새로 고침"
            className="flex h-7 w-7 items-center justify-center rounded-lg text-slate-400 hover:bg-white hover:text-slate-600"
          >
            <IconRefresh size={13} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {list.length === 0 && (
            <div className="px-3 py-6 text-center text-xs text-slate-400">
              {box === "inbox" ? "받은 메일이 없습니다" : "보낸 메일이 없습니다"}
            </div>
          )}
          {list.map((m) => {
            const active = pane.kind === "read" && pane.path === m.path;
            return (
              <button
                key={m.path}
                onClick={() => (box === "inbox" ? setPane({ kind: "read", path: m.path }) : openSent(m.path))}
                className={`block w-full border-b border-slate-100 px-3 py-2.5 text-left hover:bg-white ${
                  active ? "bg-white" : ""
                }`}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-xs font-semibold text-slate-700">{m.who}</span>
                  <span className="shrink-0 text-[10px] text-slate-400">{m.date}</span>
                </div>
                <div className="truncate text-sm text-slate-800">{m.subject}</div>
                <div className="truncate text-[11px] text-slate-400">{m.preview}</div>
              </button>
            );
          })}
        </div>
      </div>

      {/* 우측 — 읽기 / 작성 */}
      <div className="flex min-w-0 flex-1 flex-col">
        {pane.kind === "read" && (
          <ReadPane
            path={pane.path}
            text={bodies[pane.path] ?? ""}
            onReply={() => startCompose({ path: pane.path })}
            onContext={(e) => {
              const sel = selectedText();
              const items: MenuEntry[] = [];
              if (sel) items.push({ label: "선택 영역 복사", onClick: () => copy(sel, "선택 영역") });
              items.push({ label: "메일 전문 복사", onClick: () => copy(bodies[pane.path] ?? "", "메일") });
              items.push({ label: "파일 경로 복사", onClick: () => copy(pane.path, "경로") });
              if (ws.appAvailable("docs")) {
                items.push("separator");
                items.push({ label: "문서 편집기로 열기", onClick: () => ws.requestOpenInDocs(pane.path) });
              }
              openMenu(e, items);
            }}
          />
        )}

        {pane.kind === "compose" && (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="space-y-1.5 border-b border-slate-200 bg-slate-50 p-3">
              <Recipients label="받는사람" value={to} onChange={setTo} people={people} />
              <Recipients label="참조" value={cc} onChange={setCc} people={people} placeholder="(선택)" />
              <div className="flex items-center gap-2">
                <span className="w-12 shrink-0 text-xs text-slate-500">제목</span>
                <input className={inputCls} value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="제목" />
              </div>
            </div>
            <textarea
              className="min-h-0 flex-1 resize-none p-4 font-sans text-sm leading-relaxed outline-none"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="본문을 작성하세요."
              spellCheck={false}
            />
            {quote && (
              <div className="max-h-24 overflow-auto border-t border-slate-100 bg-slate-50 px-4 py-2 font-mono text-[11px] whitespace-pre-wrap text-slate-400">
                {quote.trim().slice(0, 600)}
              </div>
            )}
            <div className="flex items-center gap-2 border-t border-slate-200 bg-white px-3 py-2">
              <button
                disabled={sending}
                onClick={() => send(false)}
                className="flex items-center gap-1.5 rounded-lg bg-rose-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-rose-600 disabled:opacity-50"
              >
                <IconSend size={13} /> 보내기
              </button>
              {quote && (
                <button
                  disabled={sending}
                  onClick={() => send(true)}
                  className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                >
                  원문 인용해 보내기
                </button>
              )}
              <span className="ml-auto flex items-center gap-2 text-[11px] text-slate-400">
                {countWords(body)} 단어
                {sentAt && <span className="text-emerald-600">{sentAt} 보냄</span>}
                {/* 어디에 남는지는 평소에 보일 일이 아니다. 다만 시나리오가 파일 이름을 정해 주는
                    과제가 있어 바꿀 길은 남겨 둔다 — 눌렀을 때만 열린다. */}
                {pathOpen ? (
                  <input
                    autoFocus
                    className="w-56 rounded border border-slate-300 px-1.5 py-0.5 font-mono text-[11px] text-slate-600 outline-none focus:border-rose-400"
                    value={savePath}
                    onChange={(e) => setSavePath(e.target.value)}
                    onBlur={() => setPathOpen(false)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === "Escape") setPathOpen(false);
                    }}
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => setPathOpen(true)}
                    className="rounded px-1 text-slate-300 underline-offset-2 hover:text-slate-500 hover:underline"
                    title="이 메일이 남을 파일 이름을 바꿉니다"
                  >
                    파일 이름
                  </button>
                )}
              </span>
            </div>
          </div>
        )}

        {/* 읽기 칸의 빈 화면 — 왼쪽 목록의 "메일이 없습니다" 와 다른 말을 해야 한다.
            여기는 "받은 것이 없다" 가 아니라 "고른 것이 없다" 는 자리다. */}
        {pane.kind === "empty" && (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-slate-400">
            <IconMail size={28} />
            {list.length === 0
              ? "메일을 써서 보낼 수 있습니다"
              : "왼쪽에서 읽을 메일을 고르세요"}
            <button onClick={() => startCompose()} className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs hover:bg-slate-50">
              새 메일 쓰기
            </button>
          </div>
        )}
      </div>
      <ContextMenuView menu={menu} onClose={closeMenu} />
    </div>
  );
}

function ReadPane({
  path,
  text,
  onReply,
  onContext,
}: {
  path: string;
  text: string;
  onReply: () => void;
  onContext: (e: React.MouseEvent) => void;
}) {
  const { headers, body } = parseMail(text);
  const name = path.split("/").pop() ?? path;
  return (
    <div className="flex min-h-0 flex-1 flex-col" onContextMenu={onContext}>
      <div className="border-b border-slate-200 px-5 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold text-slate-800">{headers.subject?.trim() || name}</h2>
            <div className="mt-0.5 truncate text-xs text-slate-500">
              {headers.from ? `보낸사람 ${headers.from}` : path}
              {headers.to ? ` · 받는사람 ${headers.to}` : ""}
              {headers.date ? ` · ${headers.date}` : ""}
            </div>
          </div>
          <button
            onClick={onReply}
            className="flex shrink-0 items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
          >
            <IconReply size={13} /> 답장
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
        {/^\s*(#|\*|\||-\s)/m.test(body) ? (
          <Markdown>{body}</Markdown>
        ) : (
          <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed text-slate-700">{body}</pre>
        )}
      </div>
    </div>
  );
}

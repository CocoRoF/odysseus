"use client";

import { useEffect, useRef, useState } from "react";
import { useAutoGrow } from "@/components/useAutoGrow";
import { personFor } from "@/lib/avatars";
import { PERSON_W, PERSON_H, personSpriteStyle } from "@/lib/people";
import { aiErrorNotice } from "@/lib/ai-errors";
import { retryableFailureId } from "@/lib/failed-turns";
import type { AttemptCharacter, MessengerMessage } from "@/lib/types";
import { fmtTime } from "@/lib/format";
import { Markdown } from "@/components/Markdown";
import { IconCheck, IconCopy, IconSend } from "@/components/icons";
import { copyText, selectedText } from "@/lib/clipboard";
import { useToast } from "@/components/toast";
import { ContextMenuView, MenuEntry, useContextMenu } from "../ContextMenu";
import { useMessengerSession } from "../messengerSession";
import { useAutoFocus, useWindowVisible } from "../Window";

function CopyButton({ text, tone = "light" }: { text: string; tone?: "light" | "dark" }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      title="메시지 복사"
      onClick={async (e) => {
        e.stopPropagation();
        if (await copyText(text)) {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        }
      }}
      className={`flex h-6 w-6 shrink-0 items-center justify-center self-center rounded-md opacity-0 transition group-hover:opacity-100 ${
        tone === "dark"
          ? "text-slate-300 hover:bg-white/15 hover:text-white"
          : "text-slate-400 hover:bg-slate-200/70 hover:text-slate-600"
      }`}
    >
      {done ? <IconCheck size={13} /> : <IconCopy size={13} />}
    </button>
  );
}

/** 대화 목록의 얼굴 — 그 인물의 도트 아바타를 동그라미에 담는다.
 *  글자 한 자보다 사람 얼굴이 먼저 읽힌다. */
function Avatar({ ch, size = 40 }: { ch: AttemptCharacter; size?: number }) {
  const person = personFor({ key: ch.key, avatar_preset: ch.avatar_preset, gender: ch.gender });
  // 도트를 동그라미에 맞춰 키운다 — 머리가 가운데 오도록 위쪽을 잡는다
  const scale = size / (PERSON_H * 0.52);
  return (
    <div
      className="relative shrink-0 overflow-hidden rounded-full"
      style={{ backgroundColor: `${ch.color}22`, width: size, height: size }}
    >
      <span
        aria-hidden="true"
        className="absolute"
        style={{
          ...personSpriteStyle(person.row, "down"),
          left: "50%",
          top: size * 0.08,
          marginLeft: -(PERSON_W * scale) / 2,
          transform: `scale(${scale})`,
          transformOrigin: "top left",
        }}
      />
    </div>
  );
}

/** 답을 받지 못한 질문 — 인물의 말풍선이 아니라 **시스템 알림**으로 세운다.
 *
 *  예전에는 "(지금 자리를 비운 것 같습니다)" 라는 대사로 내보냈다. 그러면 응시자는 공급자
 *  장애를 상황으로 읽고 다른 사람에게 물으러 갔고, 자기 질문 하나가 사라진 줄도 몰랐다.
 *  실패는 실패처럼 보여야 하고, 다시 보내는 길이 같은 자리에 있어야 한다. */
function FailedTurn({
  message,
  onRetry,
  busy,
  readOnly,
  canRetry,
}: {
  message: MessengerMessage;
  onRetry: () => void;
  busy: boolean;
  readOnly: boolean;
  /** 스레드의 마지막 실패일 때만 — 지난 실패의 버튼은 다른 질문을 보내게 된다 */
  canRetry: boolean;
}) {
  return (
    <div className="msg-in flex justify-center px-2">
      <div className="w-full max-w-[92%] rounded-xl border border-amber-300 bg-amber-50 px-3.5 py-2.5">
        <p className="text-xs font-semibold text-amber-800">
          {readOnly ? "답변 실패 (평가 참고)" : "답변을 받지 못했습니다"}
        </p>
        <p className="mt-0.5 text-xs leading-relaxed text-amber-700">{aiErrorNotice(message.meta)}</p>
        <div className="mt-2 flex items-center gap-2">
          {/* 평가자 화면에서는 다시 보낼 수 없다 — 지난 응시의 대화는 바뀌면 안 된다 */}
          {!readOnly && canRetry && (
            <button
              type="button"
              onClick={onRetry}
              disabled={busy}
              className="rounded-lg bg-amber-600 px-2.5 py-1 text-[11px] font-semibold text-white transition hover:bg-amber-500 disabled:bg-amber-300"
            >
              {busy ? "다시 보내는 중…" : "같은 질문 다시 보내기"}
            </button>
          )}
          {message.meta?.correlation_id && (
            <span className="text-[10px] text-amber-600/80">오류 번호 {message.meta.correlation_id}</span>
          )}
        </div>
      </div>
    </div>
  );
}

/** 대화를 열면 그 사람이 옆에 선다.
 *
 *  초상을 띄우는 이유는 장식이 아니다. 이 시험에서 NPC 는 문제를 쥔 사람이고,
 *  응시자는 그들에게 **말을 걸어야** 요구사항을 얻는다. 이름 석 자보다 얼굴이 있는
 *  편이 말을 걸게 만든다.
 *
 *  말풍선 위에 겹쳐 두지 않는다 — 메신저는 이 시험의 유일한 문제 제시 통로라
 *  글이 그림에 밀리면 안 된다. 그래서 자기 칸을 갖고, 좁은 창에서는 사라진다.
 *  초상이 없는 프리셋이면 도트를 키워 세운다.
 */
function PortraitPane({ ch, typing }: { ch: AttemptCharacter; typing: boolean }) {
  const person = personFor({ key: ch.key, avatar_preset: ch.avatar_preset, gender: ch.gender });
  return (
    <aside className="msg-portrait-pane" data-typing={typing ? "true" : undefined} aria-hidden="true">
      {person.bust ? (
        <img src={person.bust} alt="" className="msg-portrait-art" draggable={false} />
      ) : (
        <span className="msg-portrait-dot" style={personSpriteStyle(person.row, "down")} />
      )}
      <p className="msg-portrait-name">{ch.name}</p>
      <p className="msg-portrait-role">{ch.role}</p>
    </aside>
  );
}

/** 사내 메신저 — 등장인물별 스레드. 문제 파악의 유일한 통로.
 *
 *  대화 내용·읽음·답장 대기는 이 컴포넌트가 아니라 MessengerSessionProvider 가 갖는다.
 *  여기는 어느 대화를 보고 있는지와 입력창만 안다. 창을 닫았다 열어도 세션은 그대로다. */
export function MessengerApp({ onActivity }: { onActivity?: () => void }) {
  const session = useMessengerSession();
  const { characters, messages, readOnly, typingKeys, error, unreadOf } = session;
  const visible = useWindowVisible();
  const [activeKey, setActiveKey] = useState<string>(characters[0]?.key ?? "");
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useAutoGrow(inputRef, input, 128);
  const activeKeyRef = useRef(activeKey);
  activeKeyRef.current = activeKey;
  const { menu, open: openMenu, close: closeMenu } = useContextMenu();
  const { toast } = useToast();

  // 보고 있는 대화는 읽은 것이다 — 단, 창이 화면에 있을 때만. 최소화된 창은 내려가지
  // 않고 숨겨질 뿐이라, 그 사이 온 답장은 다시 창을 올릴 때까지 '읽지 않음'으로 남는다.
  useEffect(() => {
    if (!messages || !visible) return;
    session.markSeen(activeKey);
  }, [messages, activeKey, visible, session]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, typingKeys, activeKey]);

  const active = characters.find((c) => c.key === activeKey);
  const typing = typingKeys.has(activeKey);
  const thread = (messages ?? []).filter((m) => m.character_key === activeKey);

  // 다시 보낼 수 있는 실패는 스레드의 마지막 메시지뿐이다 (lib/failed-turns)
  const retryableId = retryableFailureId(thread);

  const threadText = () =>
    thread
      .map((m) =>
        m.meta?.error
          ? "[시스템] 답변을 받지 못했습니다"
          : `[${m.sender === "candidate" ? "나" : active?.name ?? m.character_key}] ${m.content}`,
      )
      .join("\n\n");

  // 창을 열거나 대화를 바꾸면 **입력칸**에 포커스를 준다.
  //
  // 예전에는 대화 영역(읽기용 div)에 줬다. Ctrl+A/C 단축키는 먹었지만, 창을 열자마자 친 글자는
  // 아무 데도 들어가지 않았다 — 메신저는 이 시험에서 말을 거는 유일한 통로인데 한 번 더
  // 클릭해야 했다. 단축키는 창 전체의 onKeyDown 이 받으므로 입력칸에 있어도 그대로 동작한다.
  useAutoFocus(inputRef, !readOnly);
  useEffect(() => {
    if (visible && !readOnly) inputRef.current?.focus({ preventScroll: true });
  }, [activeKey, visible, readOnly]);

  const selectThread = () => {
    const el = threadRef.current;
    if (!el) return;
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    el.focus();
  };

  const messageMenu = (text: string): MenuEntry[] => {
    const sel = selectedText();
    const entries: MenuEntry[] = [];
    if (sel) entries.push({ label: "선택 영역 복사", shortcut: "Ctrl+C", onClick: () => copyText(sel) });
    entries.push({ label: "메시지 복사", onClick: () => copyText(text) });
    entries.push("separator");
    entries.push({ label: "대화 전체 복사", onClick: () => copyText(threadText()) });
    return entries;
  };

  const send = async () => {
    const content = input.trim();
    if (!content || typing || !active || readOnly) return;
    const target = activeKey; // 응답을 기다리는 동안 대화를 옮겨도 이 방으로 돌아와야 한다
    setInput("");
    onActivity?.();
    const ok = await session.send(target, content);
    // 실패했으면 쓴 글을 돌려준다 — 아직 그 대화를 보고 있을 때만
    if (!ok && target === activeKeyRef.current) setInput(content);
  };

  return (
    <div
      className="flex h-full min-h-0"
      onKeyDown={(e) => {
        // 메신저 창 어디서든 Ctrl+A 는 **지금 보고 있는 대화만** 선택한다.
        // 페이지 전체가 잡히면 사이드바·작업 표시줄까지 복사돼 쓸 수 없다.
        // 입력창 안에서는 원래 동작(입력 내용 전체 선택)을 그대로 둔다.
        const el = e.target as HTMLElement;
        if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") return;
        if ((e.ctrlKey || e.metaKey) && (e.key === "a" || e.key === "A")) {
          e.preventDefault();
          selectThread();
          return;
        }
        if ((e.ctrlKey || e.metaKey) && (e.key === "c" || e.key === "C")) {
          const picked = selectedText();
          if (picked) {
            e.preventDefault();
            void copyText(picked).then((okCopy) =>
              toast(okCopy ? "복사했습니다" : "복사에 실패했습니다", okCopy ? "success" : "error"),
            );
          }
        }
      }}
    >
      <ContextMenuView menu={menu} onClose={closeMenu} />
      {/* 대화 상대 목록 */}
      <div className="flex w-56 shrink-0 flex-col border-r border-slate-200 bg-slate-50/70">
        <div className="border-b border-slate-200 px-4 py-3">
          <p className="text-xs font-bold uppercase tracking-wide text-slate-400">대화</p>
        </div>
        <div className="thin-scroll min-h-0 flex-1 overflow-y-auto p-2">
          {characters.map((ch) => {
            const unread = unreadOf(ch.key);
            const last = (messages ?? []).filter((m) => m.character_key === ch.key).at(-1);
            return (
              <button
                key={ch.key}
                onClick={() => setActiveKey(ch.key)}
                className={`flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition ${
                  activeKey === ch.key ? "bg-white shadow-sm" : "hover:bg-white/60"
                }`}
              >
                <Avatar ch={ch} size={36} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-1">
                    <span className="truncate text-sm font-semibold text-slate-800">{ch.name}</span>
                    {unread > 0 && activeKey !== ch.key && (
                      <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">
                        {unread}
                      </span>
                    )}
                  </div>
                  {typingKeys.has(ch.key) ? (
                    <p className="truncate text-xs font-medium text-sky-600">답장을 기다리는 중…</p>
                  ) : (
                    <p className="truncate text-xs text-slate-400">
                      {last ? (last.meta?.error ? "답변을 받지 못했습니다" : last.content) : ch.role}
                    </p>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* 스레드 */}
      <div className="flex min-w-0 flex-1 bg-white">
        {active ? (
          <>
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex items-center gap-3 border-b border-slate-200 px-4 py-2.5">
              <Avatar ch={active} size={32} />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-bold text-slate-800">{active.name}</p>
                <p className="truncate text-xs text-slate-400">{active.role}</p>
              </div>
              {/* 남은 질문 수 — 에이전트에는 진작 있었는데 메신저에만 없었다.
                  누구에게 몇 번 더 물어볼 수 있는지가 이 시험에서는 전략 그 자체다. */}
              {session.usage && (
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                    session.usage.remaining <= 0
                      ? "bg-red-100 text-red-600"
                      : session.usage.remaining <= 5
                        ? "bg-amber-100 text-amber-700"
                        : "bg-slate-100 text-slate-500"
                  }`}
                  title={[
                    session.usage.shared
                      ? "메신저와 AI 에이전트를 합쳐 셉니다"
                      : "",
                    (session.usage.refunded ?? 0) > 0
                      ? `AI 오류로 답을 받지 못한 질문 ${session.usage.refunded}회는 남은 횟수에서 빼지 않았습니다`
                      : "",
                  ]
                    .filter(Boolean)
                    .join(" · ") || undefined}
                >
                  남은 질문 {session.usage.remaining}/{session.usage.max}
                  {session.usage.shared && <span className="ml-1 font-normal opacity-70">(합산)</span>}
                </span>
              )}
            </div>
            <div
              ref={(el) => {
                scrollRef.current = el;
                threadRef.current = el;
              }}
              data-thread
              tabIndex={-1}
              className="thin-scroll min-h-0 flex-1 space-y-3 overflow-y-auto bg-slate-50/50 p-4 outline-none"
              onContextMenu={(e) => {
                const sel = selectedText();
                openMenu(e, [
                  ...(sel
                    ? ([{ label: "선택 영역 복사", shortcut: "Ctrl+C", onClick: () => copyText(sel) }] as MenuEntry[])
                    : []),
                  { label: "대화 전체 선택", shortcut: "Ctrl+A", onClick: selectThread },
                  { label: "대화 전체 복사", onClick: () => copyText(threadText()) },
                ]);
              }}
            >
              {thread.length === 0 && (
                <p className="pt-8 text-center text-xs text-slate-400">
                  아직 대화가 없습니다. 먼저 말을 걸어 보세요.
                </p>
              )}
              {thread.map((m) =>
                m.meta?.error ? (
                  <FailedTurn
                    key={m.id}
                    message={m}
                    busy={typing}
                    readOnly={readOnly}
                    canRetry={m.id === retryableId}
                    onRetry={() => {
                      onActivity?.();
                      void session.retry(activeKey, m.id);
                    }}
                  />
                ) : m.sender === "candidate" ? (
                  <div
                    key={m.id}
                    className="msg-in group flex justify-end gap-1.5"
                    onContextMenu={(e) => openMenu(e, messageMenu(m.content))}
                  >
                    <CopyButton text={m.content} />
                    <span className="mt-auto shrink-0 text-[10px] text-slate-300">{fmtTime(m.created_at)}</span>
                    <div className="max-w-[75%] select-text whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-sky-600 px-3.5 py-2 text-sm text-white">
                      {m.content}
                    </div>
                  </div>
                ) : (
                  <div
                    key={m.id}
                    className="msg-in group flex items-start gap-2.5"
                    onContextMenu={(e) => openMenu(e, messageMenu(m.content))}
                  >
                    <Avatar ch={active} size={30} />
                    <div className="min-w-0">
                      <div className="max-w-full select-text rounded-2xl rounded-tl-md border border-slate-200 bg-white px-3.5 py-2 text-sm text-slate-800 shadow-sm">
                        {m.social && <p className="mb-2 text-sm text-slate-500">{m.social}</p>}
                        <Markdown>{m.content}</Markdown>
                      </div>
                      <span className="mt-0.5 block text-[10px] text-slate-300">{fmtTime(m.created_at)}</span>
                    </div>
                    <CopyButton text={m.content} />
                  </div>
                ),
              )}
              {typing && (
                <div className="flex items-start gap-2.5">
                  <Avatar ch={active} size={30} />
                  <div className="flex items-center gap-1 rounded-2xl rounded-tl-md border border-slate-200 bg-white px-3.5 py-3 shadow-sm">
                    <span className="typing-dot h-1.5 w-1.5 rounded-full bg-slate-400" />
                    <span className="typing-dot h-1.5 w-1.5 rounded-full bg-slate-400" />
                    <span className="typing-dot h-1.5 w-1.5 rounded-full bg-slate-400" />
                  </div>
                </div>
              )}
            </div>
            {error && <p className="border-t border-red-100 bg-red-50 px-4 py-1.5 text-xs text-red-600">{error}</p>}
            {!readOnly && (
              <div className="flex items-end gap-2 border-t border-slate-200 p-3">
                <textarea
                  ref={inputRef}
                  className="thin-scroll max-h-32 min-h-[42px] flex-1 resize-none rounded-xl border border-slate-300 px-3.5 py-2.5 text-sm focus:border-sky-500 focus:outline-none"
                  placeholder={`${active.name}에게 메시지 보내기...`}
                  value={input}
                  rows={1}
                  onChange={(e) => {
                    setInput(e.target.value);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      send();
                    }
                  }}
                />
                <button
                  onClick={send}
                  disabled={!input.trim() || typing}
                  className="flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-xl bg-sky-600 text-white transition hover:bg-sky-500 disabled:bg-slate-200 disabled:text-slate-400"
                >
                  <IconSend size={16} />
                </button>
              </div>
            )}
            </div>
            <PortraitPane ch={active} typing={typing} />
          </>
        ) : (
          <p className="m-auto text-sm text-slate-400">등장인물이 없습니다</p>
        )}
      </div>
    </div>
  );
}

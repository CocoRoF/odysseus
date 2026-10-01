"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { IconClose } from "@/components/icons";
import { personFor } from "@/lib/avatars";
import { PERSON_SHEET_H, personSpriteAt } from "@/lib/people";
import { api } from "@/lib/api";
import type { OfficeColleague } from "@/lib/types";
import type { OfficeEventView, OfficeJobView } from "./life";

interface History { messages: OfficeEventView[]; job: OfficeJobView | null }

/** The original portrait dialogue, with an optional composer below the current line. */
export function TalkBox({ colleague, worldId, tabId, events, connectionError, onEvents, onClose, onBusyChange }: {
  colleague: OfficeColleague; worldId: string | null; tabId: string; events: OfficeEventView[]; connectionError?: string;
  onEvents: (events: OfficeEventView[]) => void; onClose: () => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [job, setJob] = useState<OfficeJobView | null>(null);
  const [history, setHistory] = useState<OfficeEventView[]>([]);
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [pendingUser, setPendingUser] = useState<{ id: string; content: string } | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const request = useRef<{ id: string; content: string } | null>(null);
  const live = useRef(true);
  const inFlight = useRef(false);
  const handled = useRef(0);
  const busy = sending || job?.status === "queued" || job?.status === "running";
  useEffect(() => { onBusyChange(busy); return () => onBusyChange(false); }, [busy, onBusyChange]);
  const refresh = useCallback(async (id: string) => {
    const result = await api.get<History>(`/office/conversations/${id}/messages`);
    if (live.current) {
      setJob(result.job); setHistory(result.messages); onEvents(result.messages);
      setPendingUser(current => current && result.messages.some(e => e.meta.request_id === current.id) ? null : current);
    }
  }, [onEvents]);

  useEffect(() => {
    live.current = true;
    let cancelled = false;
    setConversationId(null); setJob(null); handled.current = 0;
    // The server persists the configured NPC opening once, with no user turn or LLM call.
    if (worldId && tabId) api.post<{ id: string }>(`/office/worlds/${worldId}/conversations`, { actor_id: colleague.npc_id || colleague.key, tab_id: tabId })
      .then(async conversation => {
        if (!cancelled) { setConversationId(conversation.id); await refresh(conversation.id); }
      }).catch(e => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; live.current = false; };
  }, [worldId, tabId, colleague.npc_id, colleague.key, refresh]);

  useEffect(() => { if (composing) input.current?.focus(); }, [composing]);
  useEffect(() => {
    if (!conversationId) return;
    const latest = events.filter(e => e.conversation_id === conversationId && ["npc_message", "job_failed"].includes(e.kind)).at(-1);
    if (latest && latest.sequence > handled.current) {
      handled.current = latest.sequence;
      void refresh(conversationId).catch(() => {});
    }
  }, [events, conversationId, refresh]);
  useEffect(() => {
    if (!conversationId || !busy) return;
    const poll = setInterval(() => { void refresh(conversationId).catch(() => {}); }, 4500);
    return () => clearInterval(poll);
  }, [conversationId, busy, refresh]);

  const send = useCallback(async () => {
    const content = draft.trim();
    if (!conversationId || busy || inFlight.current || !content) return;
    if (!request.current || request.current.content !== content) request.current = { id: crypto.randomUUID(), content };
    const submitted = request.current;
    inFlight.current = true; setSending(true); setError("");
    try {
      const accepted = await api.post<OfficeJobView>(`/office/conversations/${conversationId}/messages`, {
        request_id: submitted.id, content, intent: "message",
      });
      if (!live.current) return;
      setJob(accepted); setPendingUser(submitted); setDraft(""); setComposing(false); request.current = null;
      await refresh(conversationId);
    } catch (e) { if (live.current) setError(e instanceof Error ? e.message : "메시지를 보내지 못했습니다"); }
    finally { inFlight.current = false; if (live.current) { setSending(false); input.current?.focus(); } }
  }, [draft, conversationId, busy, refresh]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === "Escape") {
        e.preventDefault(); e.stopImmediatePropagation();
        if (composing) setComposing(false); else onClose();
      } else if (e.key === "Enter" && !e.altKey && !e.metaKey) {
        e.preventDefault(); e.stopImmediatePropagation();
        if (e.ctrlKey) {
          const field = input.current;
          if (composing && field && document.activeElement === field && !e.repeat) {
            const start = field.selectionStart, end = field.selectionEnd;
            const next = field.value.slice(0, start) + "\n" + field.value.slice(end);
            if (next.length <= field.maxLength) {
              setDraft(next);
              requestAnimationFrame(() => field.setSelectionRange(start + 1, start + 1));
            }
          }
          return;
        }
        if (e.repeat || busy || !conversationId) return;
        if (composing) void send(); else setComposing(true);
      }
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [onClose, composing, busy, conversationId, send]);
  const retry = async () => {
    if (!job || busy || inFlight.current) return;
    inFlight.current = true; setSending(true); setError("");
    try { const value = await api.post<OfficeJobView>(`/office/jobs/${job.id}/retry`); if (live.current) setJob(value); }
    catch (e) { if (live.current) setError(e instanceof Error ? e.message : "다시 시도해 주세요"); }
    finally { inFlight.current = false; if (live.current) setSending(false); }
  };
  const failed = job && ["failed", "expired", "cancelled"].includes(job.status);
  const person = personFor({ key: colleague.key, avatar_preset: colleague.avatar_preset, gender: colleague.gender });
  const latest = history.filter(e => e.kind === "npc_message").at(-1);
  // History is chronological across world revisions; sequence numbers are world-local.
  const lastTurn = history.filter(e => e.kind === "npc_message" || e.kind === "user_message").at(-1);
  const userLine = pendingUser?.content || (lastTurn?.kind === "user_message" ? lastTurn.content : "");
  const line = latest?.content || colleague.encounter || (conversationId ? "반갑습니다. 편하게 이야기해 주세요." : "…");
  return <section className="talk-wrap talk-interactive" role="dialog" aria-label={`${colleague.name}와의 대화`} data-office-ui
    onPointerDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()}>
    <div className="talk-portrait" aria-hidden="true">
      {person.bust ? <img src={person.bust} alt="" className="talk-art" draggable={false} /> :
        <span className="talk-dot" style={personSpriteAt(person.row, "down", "idle", PERSON_SHEET_H)} />}
    </div>
    <div className="talk-panel">
      <header className="talk-name">{colleague.name}<span className="talk-role">{colleague.role}</span>
        <button className="talk-close" type="button" onClick={onClose} aria-label="대화 닫기">
          <IconClose size={13} />
        </button></header>
      <p className="talk-line" aria-live="polite" aria-atomic="true">{line}</p>
      {userLine && <p className="talk-user-line" aria-label="내가 보낸 말">{userLine}</p>}
      {busy && <div className="talk-wait" role="status" aria-label="답변을 기다리고 있어요">
        <span className="office-speech-wait" aria-hidden="true"><i/><i/><i/></span>
      </div>}
      {(error || connectionError || failed) && <p className="office-talk-error" role="alert">
        {error || connectionError || (job?.error === "provider_quota" ? "대화 서비스의 사용 한도에 도달했습니다." : "답변을 마치지 못했습니다. 보낸 말은 보관되어 있어요.")}
        {failed && job?.status !== "cancelled" && <button onClick={retry} disabled={busy}>다시 시도</button>}
      </p>}
      {composing ? <form className="talk-compose" onSubmit={e => { e.preventDefault(); void send(); }}>
        <label className="sr-only" htmlFor="office-utterance">{colleague.name}에게 말하기</label>
        <textarea id="office-utterance" ref={input} value={draft} maxLength={2000} rows={2}
          placeholder="하고 싶은 말을 입력하세요…" aria-label="메시지" onChange={e => setDraft(e.target.value)}
          onKeyDown={e => e.stopPropagation()} />
        <div className="talk-actions"><small>Enter 전송 · Ctrl+Enter 줄바꿈 · Esc 입력 접기</small>
          <button type="submit" aria-keyshortcuts="Enter" disabled={busy || !conversationId || !draft.trim()}>보내기</button></div>
      </form> : <footer className="talk-actions">
        <small>Enter 말걸기 · Esc 대화 닫기</small><button type="button" aria-keyshortcuts="Enter" onClick={() => setComposing(true)} disabled={busy || !conversationId}>말걸기</button>
      </footer>}
    </div>
  </section>;
}

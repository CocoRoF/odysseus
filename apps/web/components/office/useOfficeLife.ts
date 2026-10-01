"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import type { CrewMember } from "./useCrew";
import { AMBIENT_RANGE, MEET_GRACE_MS, MEET_RANGE, mergeEvents, nearbyPairs, visibleActors, type WorldBounds, type AmbientView, type OfficeEventView, type OfficeWorldView } from "./life";

export function useOfficeLife(roomId: string | null, live: { current: readonly CrewMember[] }, talkingId: string | null,
  bounds: { current: WorldBounds | null }) {
  const [world, setWorld] = useState<OfficeWorldView | null>(null);
  const [events, setEvents] = useState<OfficeEventView[]>([]);
  const [ambient, setAmbient] = useState<AmbientView | null>(null);
  const [error, setError] = useState("");
  const [controller, setController] = useState(false);
  const tabId = useRef("");
  const latest = useRef({ live, talkingId });
  latest.current = { live, talkingId };
  const beatRef = useRef<() => void>(() => {});
  const ambientRef = useRef(ambient);
  ambientRef.current = ambient;
  const worldRef = useRef(world);
  worldRef.current = world;
  const receive = useCallback((incoming: OfficeEventView[]) => {
    // History refreshes recover missed SSE events, without replaying old speech.
    const fresh = incoming.filter(e => (!e.world_id || e.world_id === worldRef.current?.id) && e.sequence > (worldRef.current?.sequence ?? Infinity));
    if (fresh.length) setEvents(current => mergeEvents(current, fresh));
  }, []);

  useEffect(() => {
    setWorld(null); setEvents([]); setAmbient(null); setError(""); setController(false);
    if (!roomId) return;
    let disposed = false;
    api.post<OfficeWorldView>(`/office/rooms/${roomId}/enter`).then(value => {
      if (!disposed) setWorld(value);
    }).catch(e => { if (!disposed) setError(e.message ?? "사무실에 연결하지 못했습니다"); });
    return () => { disposed = true; };
  }, [roomId]);

  useEffect(() => {
    if (!world || !roomId || world.assessment_id !== roomId) return;
    if (!tabId.current) tabId.current = crypto.randomUUID();
    let disposed = false, beating = false, advancing = false;
    let controls = false;
    let meeting: { id: string; since: number } | null = null;
    const ingest = (event: OfficeEventView) => {
      if (disposed) return;
      setEvents(current => mergeEvents(current, [event]));
      if (event.kind === "ambient_end") setAmbient(null);
      if (event.kind === "ambient_start" || ["ambient_ready", "ambient_paused", "ambient_resumed"].includes(event.kind)) void heartbeat();
    };
    const heartbeat = async () => {
      if (disposed || beating) return;
      beating = true;
      try {
        const actors = visibleActors(latest.current.live.current.map(a => ({ id: a.c.npc_id || a.c.key, roomId: a.roomId, x: a.x, y: a.y })), bounds.current);
        const response = await api.post<{ controller: boolean; ambient: AmbientView | null }>(`/office/worlds/${world.id}/presence`, {
          tab_id: tabId.current, active: document.visibilityState === "visible",
          talking_to: latest.current.talkingId, pairs: nearbyPairs(actors, roomId),
        });
        if (!disposed) {
          controls = response.controller; setController(controls); setAmbient(response.ambient); setError("");
        }
      } catch (e) {
        if (!disposed) { setError(e instanceof Error ? e.message : "연결을 확인해 주세요"); controls = false; setController(false); }
      } finally { beating = false; }
    };
    beatRef.current = () => { void heartbeat(); };
    const source = new EventSource(`/api/office/worlds/${world.id}/events?after=${world.sequence}`, { withCredentials: true });
    source.addEventListener("office", e => {
      try { ingest(JSON.parse((e as MessageEvent).data)); } catch { /* A malformed event cannot mutate navigation. */ }
    });
    source.addEventListener("revoked", () => {
      source.close(); setError("로그인 또는 사무실 접근 권한을 확인해 주세요");
    });
    source.onopen = () => { if (!disposed) setError(""); };
    const advance = async () => {
      const scene = ambientRef.current;
      if (disposed || advancing || !controls || !scene || scene.status !== "speaking" || latest.current.talkingId || document.hidden) return;
      if (scene.next_at && Date.parse(scene.next_at) > Date.now()) return;
      const people = scene.participants.map(id => latest.current.live.current.find(a => (a.c.npc_id || a.c.key) === id && a.roomId === roomId));
      const apart = people.length === 2 && people[0] && people[1] ? Math.hypot(people[0].x - people[1].x, people[0].y - people[1].y) : Infinity;
      if (apart > AMBIENT_RANGE + 8) return;
      // 첫 줄은 둘이 옆자리에 나란히 선 뒤에(useCrew 가 한 사람을 상대 옆으로 데려간다). 길이 막혔으면 잠시 뒤 그냥 말한다.
      // 기다린 시간은 이 탭의 시계로 잰다 — 서버 시각(next_at)과 견주면 PC 시계가 어긋난 만큼 기다림이 늘거나 사라진다
      if (scene.index === 0 && apart > MEET_RANGE) {
        if (meeting?.id !== scene.id) meeting = { id: scene.id, since: Date.now() };
        if (Date.now() - meeting.since < MEET_GRACE_MS) return;
      }
      if (visibleActors(people.map(a => ({ id: a!.c.npc_id || a!.c.key, roomId: a!.roomId, x: a!.x, y: a!.y })), bounds.current).length !== 2) return;
      advancing = true;
      try {
        const response = await api.post<{ ambient: AmbientView | null; event?: OfficeEventView }>(`/office/conversations/${scene.id}/advance`, { tab_id: tabId.current, index: scene.index });
        if (!disposed) {
          setAmbient(response.ambient);
          if (response.event) ingest(response.event);
        }
      } catch { /* A newer controller or cancellation supersedes this scene. */ }
      finally { advancing = false; }
    };
    const beats = setInterval(heartbeat, 5000), advances = setInterval(advance, 500);
    document.addEventListener("visibilitychange", heartbeat);
    void heartbeat();
    return () => {
      disposed = true; source.close(); clearInterval(beats); clearInterval(advances);
      document.removeEventListener("visibilitychange", heartbeat); beatRef.current = () => {};
      void fetch(`/api/office/worlds/${world.id}/presence`, { method: "POST", credentials: "include", keepalive: true,
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tab_id: tabId.current, active: false }) }).catch(() => {});
    };
  }, [world, roomId, bounds]);

  useEffect(() => { beatRef.current(); }, [talkingId]);
  return { world, events, ambient, receive, error, controller, tabId: tabId.current };
}

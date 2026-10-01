"use client";

import { useEffect, useState } from "react";
import type { CrewMember } from "./useCrew";
import type { OfficeEventView } from "./life";
import { bubblePosition, currentSpeech } from "./speech";

export function SpeechBubble({ events, crew, roomId, camera, pendingSpeakerId }: {
  events: OfficeEventView[]; crew: readonly CrewMember[]; roomId: string | null;
  pendingSpeakerId?: string | null;
  camera: { x: number; y: number; scale: number; width: number; height: number };
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const tick = setInterval(() => setNow(Date.now()), 250); return () => clearInterval(tick); }, []);
  const speech = pendingSpeakerId ? null : currentSpeech(events, now);
  const speakerId = pendingSpeakerId || speech?.event.speaker_id;
  const actor = crew.find(a => a.roomId === roomId && (a.c.npc_id || a.c.key) === speakerId);
  if (!speakerId || !actor) return null;
  const person = actor;
  const x = person.x * camera.scale + camera.x;
  const y = (person.y - 90) * camera.scale + camera.y;
  if (x < 0 || x > camera.width || y < -70 || y > camera.height) return null;
  const position = bubblePosition(x, y, camera.width, camera.height, !speech);
  return <div className="office-speech" data-speaker={speakerId} data-kind={speech?.event.kind ?? "pending"}
    data-side={position.below ? "below" : "above"} role="status" aria-live="polite" aria-atomic="true"
    style={{ left: position.left, top: position.top, width: position.width, ["--speech-tail" as string]: `${position.tail}px` }}>
    {speech ? <><strong>{actor.c.name}</strong><p>{speech.text}</p>
      {speech.total > 1 && <small aria-label="메시지 이어 읽기">{speech.page+1} / {speech.total}</small>}</> :
      <span className="office-speech-wait" aria-label={`${actor!.c.name}님이 답변하고 있어요`}><i/><i/><i/></span>}
  </div>;
}

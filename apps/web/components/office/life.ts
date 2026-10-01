/** Shared office protocol and navigation observations; coordinates never grant permissions. */
export interface OfficeWorldView { id: string; assessment_id: string; revision: string; sequence: number; ambient_enabled: boolean }
export interface OfficeEventView {
  id: string; world_id?: string; sequence: number; kind: string; conversation_id: string | null;
  speaker_id: string; content: string; created_at: string; meta: Record<string, unknown>;
}
export interface OfficeJobView { id: string; status: string; error: string; request_id: string; conversation_id: string }
export interface AmbientView {
  id: string; participants: string[]; status: string; index: number; total: number;
  next_at?: string; expires_at?: string;
}
export interface PositionedActor { id: string; x: number; y: number; roomId: string }
export interface WorldBounds { left: number; top: number; right: number; bottom: number }
export const NPC_MOTION = { baseWalkSpeed: 52, multiplier: 1.3, baseStepMs: 190 } as const;
export const NPC_WALK_SPEED = NPC_MOTION.baseWalkSpeed * NPC_MOTION.multiplier;
export const NPC_STEP_MS = NPC_MOTION.baseStepMs / NPC_MOTION.multiplier;
export const AMBIENT_RANGE = 240;
/** 잡담은 둘이 가까이 마주 선 뒤 시작한다. 이 거리 안이면 마주 선 것으로 본다(두 칸 96px + 여유 — 옆자리가 막혀 한 칸 건너 서기도 한다) */
export const MEET_RANGE = 100;
/** 다가가는 길이 막혔을 때 — 이만큼 지나면 떨어진 채로도 말한다 */
export const MEET_GRACE_MS = 8000;

export function visibleActors(actors: readonly PositionedActor[], bounds: WorldBounds | null): PositionedActor[] {
  if (!bounds) return [];
  return actors.filter(a => a.x >= bounds.left && a.x <= bounds.right && a.y >= bounds.top && a.y <= bounds.bottom);
}

/** Observe one visible room at a time, including from the corridor. Keep a stable
 * room while a pair is visible so navigation never starts an AI call per frame. */
export function observedRoom(actors: readonly PositionedActor[], bounds: WorldBounds | null, current: string | null): string | null {
  if (!bounds) return null;
  const visible = visibleActors(actors, bounds);
  const candidates = [...new Set(visible.map(a => a.roomId))].filter(id => nearbyPairs(visible, id).length);
  if (current && candidates.includes(current)) return current;
  const cx = (bounds.left + bounds.right) / 2, cy = (bounds.top + bounds.bottom) / 2;
  const distance = (id: string) => Math.min(...visible.filter(a => a.roomId === id).map(a => Math.hypot(a.x-cx, a.y-cy)));
  return candidates.sort((a, b) => distance(a)-distance(b) || a.localeCompare(b))[0] ?? null;
}

export function nearbyPairs(actors: readonly PositionedActor[], roomId: string): string[][] {
  const buckets = new Map<string, PositionedActor[]>();
  const pairs: string[][] = [];
  for (const actor of actors) {
    if (actor.roomId !== roomId) continue;
    const bx = Math.floor(actor.x / AMBIENT_RANGE), by = Math.floor(actor.y / AMBIENT_RANGE);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const other of buckets.get(`${bx + dx}:${by + dy}`) ?? []) {
        if (actor.id !== other.id && Math.hypot(actor.x - other.x, actor.y - other.y) <= AMBIENT_RANGE)
          pairs.push([other.id, actor.id].sort());
      }
    }
    const key = `${bx}:${by}`;
    buckets.set(key, [...(buckets.get(key) ?? []), actor]);
  }
  return pairs.slice(0, 15);
}

export function mergeEvents(previous: OfficeEventView[], incoming: OfficeEventView[], limit = 150): OfficeEventView[] {
  const events = new Map(previous.map(event => [event.id, event]));
  for (const event of incoming) events.set(event.id, event);
  return [...events.values()].sort((a, b) => a.sequence - b.sequence).slice(-limit);
}

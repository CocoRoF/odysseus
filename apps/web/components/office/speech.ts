import type { OfficeEventView } from "./life";

/** 말풍선 한 쪽에 담는 글자 수 상한. 사람이 두 칸 키라 말풍선이 세 줄을 넘으면 옆 사람을 가린다 — 긴 말은 쪽으로 나눠 보여 준다. */
export const SPEECH_PAGE_CHARS = 64;
/** 쪽을 나눌 때 목표 길이에서 이만큼 앞뒤로 자를 자리를 찾는다 */
const SPEECH_PAGE_SLACK = 22;
/** 마지막 쪽이 이보다 짧으면 앞 쪽에 붙인다 — "같아요." 한 토막만 남으면 말이 잘린 것처럼 보인다 */
const SPEECH_TAIL_MIN = 14;

const SENTENCE_END = /[.!?。…]/u;
const CLAUSE_END = /[,、;:]/u;
const SPACE = /\s/u;

/** 긴 말을 여러 쪽으로 — 쪽 길이를 비슷하게 맞추고, 자르는 자리는 문장 끝 → 쉼표 → 띄어쓰기 순으로 고른다.
 *  앞에서부터 꽉 채워 단어 단위로 자르면 마지막 쪽에 꼬리만 남아 말이 잘린 것처럼 보인다. */
export function speechPages(text: string): string[] {
  const chars = Array.from(text.trim());
  if (chars.length <= SPEECH_PAGE_CHARS) return chars.length ? [chars.join("")] : [];
  const pages: string[] = [];
  let rest = chars;
  while (rest.length > SPEECH_PAGE_CHARS) {
    const count = Math.ceil(rest.length / SPEECH_PAGE_CHARS);
    const target = Math.ceil(rest.length / count);
    const lo = Math.max(1, target - SPEECH_PAGE_SLACK);
    const hi = Math.min(rest.length - 1, target + SPEECH_PAGE_SLACK, SPEECH_PAGE_CHARS);
    // i 앞에서 자른다(rest[0..i) 가 한 쪽). 문장 끝 뒤, 쉼표 뒤, 띄어쓰기 앞 — 그 순서로, 목표 길이에 가장 가까운 자리
    const afterSentence = (i: number) => SENTENCE_END.test(rest[i - 1]) && !SENTENCE_END.test(rest[i]);
    const afterClause = (i: number) => CLAUSE_END.test(rest[i - 1]);
    const beforeSpace = (i: number) => SPACE.test(rest[i]);
    let cut = -1;
    for (const ok of [afterSentence, afterClause, beforeSpace]) {
      let best = -1;
      for (let i = lo; i <= hi; i += 1) if (ok(i) && (best < 0 || Math.abs(i - target) < Math.abs(best - target))) best = i;
      if (best > 0) { cut = best; break; }
    }
    if (cut < 0) cut = Math.min(target, hi);
    if (rest.length - cut < SPEECH_TAIL_MIN) break; // 꼬리가 너무 짧으면 나누지 않고 한 쪽에 담는다
    pages.push(rest.slice(0, cut).join("").trim());
    rest = rest.slice(cut);
  }
  if (rest.length) pages.push(rest.join("").trim());
  return pages.filter(Boolean);
}

/** 한 줄을 말풍선에 띄워 두는 **전체** 시간. 서버(office_dialogue.advance)가 다음 줄을 넘기는 간격과 같은 식이다 —
 *  어긋나면 말풍선이 사라진 뒤 다음 줄까지 빈틈이 생기거나, 다음 줄이 앞 줄의 마지막 쪽을 자른다.
 *  64자를 넘는 줄은 여러 쪽이라 쪽마다 최소 3.2초를 준다. 쪽 사이는 글자 수에 비례해 나눈다(currentSpeech). */
export function speechDuration(text: string): number {
  const chars = Array.from(text).length;
  return Math.max(3200 * Math.ceil(chars / SPEECH_PAGE_CHARS), Math.min(11000, chars * 90));
}

export function currentSpeech(events: OfficeEventView[], now: number) {
  const event = [...events].reverse().find(e => e.kind === "ambient_line");
  if (!event) return null;
  if (event.kind === "ambient_line" && events.some(e => e.sequence > event.sequence && ["ambient_end", "ambient_paused"].includes(e.kind) &&
      e.conversation_id === event.conversation_id && e.meta.reason !== "completed")) return null;
  let age = Math.max(0, now - Date.parse(event.created_at));
  const pages = speechPages(event.content);
  const total = speechDuration(event.content);
  const chars = pages.reduce((n, page) => n + Array.from(page).length, 0) || 1;
  for (let i = 0; i < pages.length; i++) {
    const duration = total * Array.from(pages[i]).length / chars;
    if (age < duration) return { event, text: pages[i], page: i, total: pages.length };
    age -= duration;
  }
  return null;
}

/** Keep text readable at every zoom and keep the tail attached to its speaker. */
export function bubblePosition(x: number, headY: number, viewWidth: number, viewHeight: number, compact = false) {
  const width = Math.min(compact ? 44 : 168, Math.max(80, viewWidth-24));
  const height = compact ? 32 : 74;
  const left = Math.max(12, Math.min(viewWidth-width-12, x-width/2));
  const below = headY < height+18;
  const edge = Math.max(12, Math.min(viewHeight-12, below ? headY+26 : headY-12));
  return { left, width, top: edge, below, tail: Math.max(16, Math.min(width-16, x-left)) };
}

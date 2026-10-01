import assert from "node:assert/strict";
import { test } from "node:test";
import { nearbyPairs, mergeEvents, observedRoom, type OfficeEventView } from "./life.ts";
import { currentSpeech, speechDuration, speechPages, bubblePosition } from "./speech.ts";

test("pair triggers only use nearby distinct actors in the same room, including bucket boundaries", () => {
  const actors = [
    { id: "a", roomId: "r", x: 239, y: 239 }, { id: "b", roomId: "r", x: 241, y: 241 },
    { id: "c", roomId: "other", x: 240, y: 240 }, { id: "d", roomId: "r", x: 800, y: 800 },
  ];
  assert.deepEqual(nearbyPairs(actors, "r"), [["a", "b"]]);
});

test("resumed SSE events merge without duplicated or reordered messages", () => {
  const event = (id: string, sequence: number) => ({ id, sequence, kind: "npc_message", conversation_id: "c", speaker_id: "a", content: id, meta: {}, created_at: "now" } as OfficeEventView);
  assert.deepEqual(mergeEvents([event("b", 2)], [event("a", 1), event("b", 2)]).map(e => e.id), ["a", "b"]);
});

test("corridor observation picks a visible pair, stays stable and releases offscreen rooms", () => {
  const actors = [
    {id:"a",roomId:"upper",x:100,y:100}, {id:"b",roomId:"upper",x:150,y:100},
    {id:"c",roomId:"lower",x:100,y:700}, {id:"d",roomId:"lower",x:150,y:700},
  ];
  const all = {left:0,top:0,right:400,bottom:760};
  assert.equal(observedRoom(actors, all, null), "upper");
  assert.equal(observedRoom(actors, all, "lower"), "lower");
  assert.equal(observedRoom(actors, {...all,bottom:300}, "lower"), "upper");
  assert.equal(observedRoom(actors, {...all,top:350,bottom:500}, "lower"), null);
  assert.equal(observedRoom(actors.slice(0,1), all, null), null);
});

test("world speech follows actual turns and expires without replaying cancelled dialogue", () => {
  const event = {id:"line",sequence:1,kind:"ambient_line",conversation_id:"c",speaker_id:"a",content:"안녕하세요.",meta:{},created_at:new Date(1000).toISOString()} as OfficeEventView;
  assert.equal(currentSpeech([event], 1100)?.text, "안녕하세요.");
  assert.equal(currentSpeech([event], 6000), null);
  const end = {...event,id:"end",sequence:2,kind:"ambient_end",meta:{reason:"interrupted"}};
  assert.equal(currentSpeech([event,end], 1200), null);
  assert.ok(currentSpeech([event,{...end,meta:{reason:"completed"}}], 1200));
  const reply = {...event,id:"reply",sequence:3,kind:"npc_message",speaker_id:"b",content:"반갑습니다."};
  assert.equal(currentSpeech([event,reply], 1200)?.event.speaker_id, "a");
  assert.equal(currentSpeech([reply], 1200), null, "private replies belong in the portrait dialogue");
  assert.equal(currentSpeech([event,{...end,kind:"ambient_paused"}], 1200), null);
});

test("long Unicode utterances page and bubbles stay readable inside small viewports", () => {
  const text = "한글😀".repeat(110);
  const pages = speechPages(text);
  assert.equal(pages.join(""), text);
  assert.ok(pages.every(page=>Array.from(page).length<=110));
  const left = bubblePosition(4, 40, 360, 640);
  assert.equal(left.left, 12); assert.equal(left.below, true);
  const right = bubblePosition(359, 400, 360, 640);
  assert.ok(right.left+right.width <= 348); assert.equal(right.below, false);
});

test("a spoken line stays up exactly as long as the server waits before the next line", () => {
  // 서버 office_dialogue.advance 의 next_at 간격: max(3.2초 × ceil(글자/64), min(11초, 글자 × 0.09초))
  const serverGap = (text: string) => { const n = Array.from(text).length; return Math.max(3200 * Math.ceil(n / 64), Math.min(11000, n * 90)); };
  const base = "보고 준비 때문에 다들 예민해요. 그래도 점심은 같이 먹을까요, 아니면 오늘은 각자 해결할까요? 저는 아무래도 좋아요.";
  for (let n = 4; n <= 110; n += 3) {
    const text = Array.from(base + base).slice(0, n).join("").trim();
    assert.equal(speechDuration(text), serverGap(text));
    const line = { id: "l", sequence: 1, kind: "ambient_line", conversation_id: "c", speaker_id: "a", content: text, meta: {}, created_at: new Date(0).toISOString() } as OfficeEventView;
    const pages = speechPages(text);
    assert.equal(currentSpeech([line], serverGap(text) - 1)?.page, pages.length - 1, `last page still visible at n=${n}`);
    assert.equal(currentSpeech([line], serverGap(text) + 1), null, `bubble gone once the next line is due at n=${n}`);
  }
});


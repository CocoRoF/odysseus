/** 아바타 후보 뽑기 — 선택창은 성별마다 여섯, 시나리오 인물은 전체.
 *   node --test lib/ */
import assert from "node:assert/strict";
import test from "node:test";

import { PEOPLE } from "./people.ts";
import { CHOICES_PER_GENDER, pickAvatarChoices } from "./avatar-choices.ts";

/** 같은 씨앗이면 같은 수열 — mulberry32 */
function seeded(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("아바타 후보: 지금 매니페스트에서 여성 6 · 남성 6 을 겹치지 않게 뽑는다", () => {
  const female = PEOPLE.filter((p) => p.gender === "female");
  const male = PEOPLE.filter((p) => p.gender === "male");
  assert.ok(female.length >= CHOICES_PER_GENDER && male.length >= CHOICES_PER_GENDER, `여성 ${female.length} · 남성 ${male.length} — 선택창에 여섯씩 못 채운다`);
  for (let s = 1; s <= 50; s += 1) {
    const got = pickAvatarChoices(PEOPLE, CHOICES_PER_GENDER, seeded(s));
    assert.equal(got.length, 12);
    assert.equal(new Set(got.map((p) => p.id)).size, 12, "같은 얼굴이 두 번 나왔다");
    assert.deepEqual(got.map((p) => p.gender), [...Array(6).fill("female"), ...Array(6).fill("male")], "여성 여섯 다음 남성 여섯");
  }
});

test("아바타 후보: 무작위다 — 많은 쪽 성별은 뽑을 때마다 다르고, 오래 뽑으면 전원이 한 번은 나온다", () => {
  const seen = new Set<string>();
  const sets = new Set<string>();
  for (let s = 1; s <= 400; s += 1) {
    const got = pickAvatarChoices(PEOPLE, CHOICES_PER_GENDER, seeded(s));
    got.forEach((p) => seen.add(p.id));
    sets.add(got.filter((p) => p.gender === "female").map((p) => p.id).sort().join(","));
  }
  assert.equal(seen.size, PEOPLE.filter((p) => p.gender === "female" || p.gender === "male").length, "한 번도 후보에 오르지 못한 프리셋이 있다");
  assert.ok(sets.size > 100, `여성 후보 조합이 ${sets.size}가지뿐이다`);
  // 같은 씨앗이면 같은 결과(부르는 쪽이 한 번 뽑아 들고 있으면 화면이 흔들리지 않는다)
  assert.deepEqual(pickAvatarChoices(PEOPLE, 6, seeded(7)), pickAvatarChoices(PEOPLE, 6, seeded(7)));
});

test("아바타 후보: 모자라면 있는 만큼, 원본 목록은 그대로", () => {
  const few = PEOPLE.filter((p) => p.gender === "male").slice(0, 2).concat(PEOPLE.filter((p) => p.gender === "female").slice(0, 8));
  const before = few.map((p) => p.id).join(",");
  const got = pickAvatarChoices(few, 6, seeded(3));
  assert.equal(got.filter((p) => p.gender === "male").length, 2);
  assert.equal(got.filter((p) => p.gender === "female").length, 6);
  assert.equal(few.map((p) => p.id).join(","), before, "원본 목록을 섞어 버렸다");
  assert.deepEqual(pickAvatarChoices([], 6, seeded(1)), []);
});

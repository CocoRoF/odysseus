/** 인물 → 캐릭터 프리셋 고르기.
 *
 *  나중에 시험의 **참여자 설정창**에서 사람마다 직접 고르게 된다. 지정되지 않았으면
 *  인물 키에서 하나를 고른다 — 무작위이되 **같은 인물은 언제나 같은 사람**이다.
 *  화면을 다시 그릴 때마다 얼굴이 바뀌면 그건 무작위가 아니라 고장이다.
 */
import { PEOPLE, type Dir } from "@/lib/people";

export type { Dir };

/** 문자열 → 안정적인 정수.
 *
 *  FNV-1a 뒤에 murmur3 의 마무리 섞기(fmix32)를 한 번 더 건다. FNV 만으로는 짧고
 *  비슷한 키(`pm_sujin`, `hr_yuna` …)가 낮은 비트에서 뭉쳐, 실측으로 여성 인물 35명이
 *  프리셋 여섯에 [4, 8, 0, 9, 10, 4] 로 떨어졌다 — 하나는 한 번도 안 쓰였다. 섞기를
 *  더하면 [10, 7, 7, 4, 6, 1] 로 전부 쓰인다. 같은 키는 여전히 같은 값이다. */
function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

export interface HasAvatar {
  key: string;
  /** 참여자 설정에서 고른 프리셋 id. 비어 있으면 키로 정한다. */
  avatar_preset?: string | null;
  /** "female" | "male" | "" — 자동으로 고를 때 후보를 좁힌다. */
  gender?: string | null;
}

/** 이 인물이 쓸 프리셋.
 *
 *  1) 직접 고른 것이 있으면 그것.
 *  2) 없으면 **성별이 맞는 것 중에서** 키로 고른다 — 김수진에게 남성 아바타가
 *     붙으면 그건 무작위가 아니라 틀린 것이다.
 *  3) 성별이 비어 있거나 맞는 프리셋이 없으면 전체에서 고른다.
 */
export function personFor(character: HasAvatar) {
  const chosen = (character.avatar_preset ?? "").trim();
  const picked = chosen && PEOPLE.find((p) => p.id === chosen);
  if (picked) return picked;
  const want = (character.gender ?? "").trim();
  const pool = want ? PEOPLE.filter((p) => p.gender === want) : [];
  const from = pool.length ? pool : PEOPLE;
  return from[hash(character.key) % Math.max(1, from.length)];
}

export function rowFor(character: HasAvatar): number {
  return personFor(character)?.row ?? 0;
}

export { PEOPLE };

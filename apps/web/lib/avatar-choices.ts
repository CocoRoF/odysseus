/** 게스트가 고르는 아바타 후보 — 성별마다 같은 수를 **무작위로**.
 *
 *  프리셋은 계속 늘어난다(2026-09-13 여성 13명 추가 → 여성 19 · 남성 6). 전부 늘어놓으면 선택창이 길어지고 한 성별이
 *  화면을 채운다. 그래서 성별마다 CHOICES_PER_GENDER 명을 뽑아 보여 준다. 시나리오 속 인물은 이것과 무관하게 **전체**
 *  프리셋에서 얼굴을 받는다(서버 avatar_alloc · 웹 avatars.personFor).
 *
 *  섞는 것은 한 번이다 — 화면이 다시 그려질 때마다 얼굴이 바뀌면 고를 수 없다. 부르는 쪽이 결과를 들고 있어야 한다.
 */
import type { Person } from "./people.ts";

export const CHOICES_PER_GENDER = 6;
/** 보여 주는 순서 — 한 줄에 여섯이면 줄마다 한 성별이 된다 */
export const CHOICE_GENDERS = ["female", "male"] as const;

/** 섞은 앞 n 개(Fisher–Yates, 앞 n 칸만) — 원본은 건드리지 않는다 */
function sample<T>(list: readonly T[], n: number, random: () => number): T[] {
  const a = [...list];
  const k = Math.min(n, a.length);
  for (let i = 0; i < k; i += 1) {
    const j = i + Math.floor(random() * (a.length - i));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, k);
}

/** 성별마다 perGender 명(모자라면 있는 만큼)을 무작위로 뽑는다. 여성 먼저, 남성 다음. 다른 성별 값의 프리셋은 넣지 않는다. */
export function pickAvatarChoices(
  people: readonly Person[],
  perGender: number = CHOICES_PER_GENDER,
  random: () => number = Math.random,
): Person[] {
  return CHOICE_GENDERS.flatMap((g) => sample(people.filter((p) => p.gender === g), perGender, random));
}

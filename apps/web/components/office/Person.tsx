/** 캐릭터 한 명을 놓는다 — images/charactor_* 에서 들여온 도트 프리셋.
 *
 *  가구 아틀라스와 시트를 나눈 이유는 크기가 다르기 때문이다. 가구는 32px 칸에
 *  맞지만 사람은 한 칸 반(48px)이다. 사람이 책상보다 작으면 사람으로 보이지 않는다.
 *
 *  방향·자세 이름은 원본 파일 이름 그대로(`down|left|right|up` × `idle|move`)다.
 *  여기서 다시 번역하지 않는다 — 번역이 끼는 자리가 곧 방향이 어긋나는 자리였다.
 */
import { PERSON_W, PERSON_H, personSpriteStyle, type Dir, type Pose } from "@/lib/people";

export function Person({
  row,
  dir = "down",
  pose = "idle",
  x,
  y,
  className = "",
  style,
  title,
}: {
  row: number;
  dir?: Dir;
  /** idle = 서 있는 자세, move = 내딛는 자세 */
  pose?: Pose;
  x: number;
  y: number;
  className?: string;
  style?: React.CSSProperties;
  title?: string;
}) {
  return (
    <span
      aria-hidden="true"
      data-person={title}
      data-dir={dir}
      data-pose={pose}
      className={`o-person-slot ${className}`}
      style={{
        // **자리는 transform 으로 옮긴다.** left/top 을 고치면 그 사람이 있던 자리와 갈 자리가 '다시 그릴 곳'이 되어
        // 같은 층의 지도(바닥·벽·소품)까지 다시 래스터된다 — 소수 배율에서는 그때마다 무늬가 미세하게 달라져 화면
        // 전체가 떨리는 것으로 보였다(2026-09-13). transform + will-change 면 합성기가 옮기므로 지도는 건드리지 않는다.
        left: 0,
        top: 0,
        width: PERSON_W,
        height: PERSON_H,
        // 발끝이 기준이다 — 사람은 서 있는 바닥 칸에 발을 딛는다
        transform: `translate3d(${Math.round(x - PERSON_W / 2)}px, ${Math.round(y - PERSON_H)}px, 0)`,
        ...style,
      }}
    >
      {/* 숨쉬기(o-breathe)는 이 안쪽 그림에만 건다 — 바깥 자리와 같은 속성(transform)이라 한 요소에 겹치면 자리가 어긋난다 */}
      <span className="o-person-sprite" style={personSpriteStyle(row, dir, pose)} />
    </span>
  );
}

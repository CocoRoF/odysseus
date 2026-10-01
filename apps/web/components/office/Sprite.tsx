/** 시트에서 스프라이트 한 장을 꺼내 놓는다.
 *
 *  칸마다 이미지를 따로 받지 않는다 — 묶음 시트(ATLAS[sheet])에서 background-position 으로 꺼낸다. 시트는 월드 배율 1
 *  (48px = 한 칸)이고 픽셀 아트라 image-rendering: pixelated 로 늘린다(CSS .o-sprite).
 *  반복되는 면(바닥·벽)은 여기 오지 않는다. 그건 CSS 가 타일 이미지를 깔아 준다. */
import { ATLAS, S, type SpriteName } from "./atlas";

export function Sprite({
  name,
  x,
  y,
  className = "",
  style,
  dataState,
  dataPeeked,
}: {
  name: SpriteName;
  x: number;
  y: number;
  className?: string;
  style?: React.CSSProperties;
  /** 시작 책상의 상태(open|resume|done) — CSS 가 불빛을 정한다 */
  dataState?: string;
  dataPeeked?: string;
}) {
  const s = S[name];
  const sheet = ATLAS[s.sheet];
  return (
    <span
      aria-hidden="true"
      data-state={dataState}
      data-peeked={dataPeeked}
      className={`o-sprite ${className}`}
      style={{
        left: x,
        top: y,
        width: s.w,
        height: s.h,
        backgroundImage: `url(${sheet.src})`,
        backgroundSize: `${sheet.w}px ${sheet.h}px`,
        backgroundPosition: `-${s.x}px -${s.y}px`,
        ...style,
      }}
    />
  );
}

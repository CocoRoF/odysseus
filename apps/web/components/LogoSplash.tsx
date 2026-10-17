"use client";

import { useEffect } from "react";

/** 로고 전환막: 검은 화면에 오디세우스 로고가 섰다가, 다음 화면 위에서 걷힌다.
 *
 *  시험을 시작할 때 부팅 연출 끝에 나오는 로고(`BootSequence` 의 logo 단계)와 같은 모습이다.
 *  사무실이 출근길 대신 이 막으로 들어올 때 쓴다(움직임을 줄인 경우): 사무실 화면이 그 아래에서
 *  준비되는 동안 머물다가(hold), 준비되면 걷힌다(leave).
 *
 *  `prefers-reduced-motion` 이면 움직임 없이 막만 있다가 바로 걷힌다.
 */
export function LogoSplash({
  mode,
  label,
  onDone,
}: {
  mode: "hold" | "leave";
  /** 보조기술에 읽히는 한 줄 — 화면에 글자는 없다 */
  label: string;
  /** leave 가 끝났을 때 — 이 컴포넌트를 내려도 된다 */
  onDone?: () => void;
}) {
  useEffect(() => {
    if (mode !== "leave" || !onDone) return;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    // animationend 에 기대지 않는다 — 탭이 뒤에 있으면 애니메이션이 안 돌아 막이 영원히 남는다.
    const t = setTimeout(onDone, reduced ? 0 : 1100);
    return () => clearTimeout(t);
  }, [mode, onDone]);

  return (
    <div className="logo-splash" data-mode={mode} role="status" aria-live="polite" aria-label={label}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/brand/odysseus-logo.png" alt="" className="select-none" draggable={false} />
    </div>
  );
}

/** 사무실에 들어올 때 주고받는 표식. 주소로 건네고 세션 저장소는 보조다.
 *  값: "office" = 사무실 출근길을 다시 본다 (`/office?arrive=office`). */
export const ARRIVE_PARAM = "arrive";
export const ARRIVE_KEY = "odysseus:arrive";
export type ArriveKind = "office";

/** 이 페이지가 어떤 표식을 들고 열렸는가 — 읽으면서 지운다(새로고침에 재연출하지 않게). */
export function takeArrival(): ArriveKind | null {
  try {
    const fromUrl = new URLSearchParams(window.location.search).get(ARRIVE_PARAM);
    const fromStore = sessionStorage.getItem(ARRIVE_KEY);
    sessionStorage.removeItem(ARRIVE_KEY);
    const v = fromUrl || fromStore;
    if (fromUrl) window.history.replaceState(null, "", window.location.pathname);
    return v === "office" ? v : null;
  } catch {
    return null;
  }
}

"use client";

import { useEffect } from "react";

/** 로고 전환막 — 검은 화면에 오디세우스 로고가 떠올랐다가, 다음 화면 위에서 걷힌다.
 *
 *  시험을 시작할 때 부팅 연출 끝에 나오는 로고(`BootSequence` 의 logo 단계)와 같은
 *  움직임이다. 게스트가 들어올 때도 같은 막을 쓴다 — 로그인 화면에서 떠오르고(enter),
 *  사무실 화면이 그 아래에서 준비되는 동안 머물다가(hold), 준비되면 걷힌다(leave).
 *
 *  두 화면에 걸쳐 있으므로 **enter 의 끝 모습과 hold 의 첫 모습이 같아야** 한다.
 *  페이지가 바뀌는 순간 로고가 다시 떠오르거나 깜빡이면 전환이 아니라 재시작으로 보인다.
 *  그래서 hold 는 애니메이션 없이 enter 의 마지막 프레임 그대로 선다.
 *
 *  `prefers-reduced-motion` 이면 움직임 없이 막만 있다가 바로 걷힌다.
 */
export function LogoSplash({
  mode,
  label,
  onDone,
  logo = true,
}: {
  mode: "enter" | "hold" | "leave";
  /** 보조기술에 읽히는 한 줄 — 화면에 글자는 없다 */
  label: string;
  /** leave 가 끝났을 때 — 이 컴포넌트를 내려도 된다 */
  onDone?: () => void;
  /** false 면 로고 없는 검은 막 — 이미 검은 화면(온보딩)에서 사무실로 건너올 때.
   *  로고를 두 번 보여 주면 전환이 아니라 재시작으로 보인다. */
  logo?: boolean;
}) {
  useEffect(() => {
    if (mode !== "leave" || !onDone) return;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    // animationend 에 기대지 않는다 — 탭이 뒤에 있으면 애니메이션이 안 돌아 막이 영원히 남는다.
    const t = setTimeout(onDone, reduced ? 0 : 1100);
    return () => clearTimeout(t);
  }, [mode, onDone]);

  return (
    <div className="logo-splash" data-mode={mode} data-logo={logo ? "true" : "false"} role="status" aria-live="polite" aria-label={label}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {logo && <img src="/brand/odysseus-logo.png" alt="" className="select-none" draggable={false} />}
    </div>
  );
}

/** 화면 사이를 건너올 때 주고받는 표식. URL 로 건네고 세션 저장소는 보조다.
 *  값: "guest" = 로그인 → 온보딩(로고 막 이어받음), "welcome" = 온보딩 → 사무실(검은 막만),
 *  "office" = 사무실 출근길을 다시 본다. */
export const ARRIVE_PARAM = "arrive";
export const ARRIVE_KEY = "odysseus:arrive";
export type ArriveKind = "guest" | "welcome" | "office";

/** 이 페이지가 어떤 표식을 들고 열렸는가 — 읽으면서 지운다(새로고침에 재연출하지 않게). */
export function takeArrival(): ArriveKind | null {
  try {
    const fromUrl = new URLSearchParams(window.location.search).get(ARRIVE_PARAM);
    const fromStore = sessionStorage.getItem(ARRIVE_KEY);
    sessionStorage.removeItem(ARRIVE_KEY);
    const v = fromUrl || fromStore;
    if (fromUrl) window.history.replaceState(null, "", window.location.pathname);
    return v === "guest" || v === "welcome" || v === "office" ? v : null;
  } catch {
    return null;
  }
}

export function markArrival(kind: ArriveKind): string {
  try {
    sessionStorage.setItem(ARRIVE_KEY, kind);
  } catch {
    // 저장소가 없어도 주소의 표식으로 충분하다
  }
  return `?${ARRIVE_PARAM}=${kind}`;
}

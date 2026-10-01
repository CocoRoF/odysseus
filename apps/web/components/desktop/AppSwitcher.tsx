"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { APP_META } from "./Window";
import { appIcon } from "./appIcons";
import { openWindowsByRecency, type WindowManager, type WinState } from "./wm";

/** 앱 전환기 — Alt+Tab.
 *
 *  실제 OS 처럼 Alt 를 누른 채 Tab 을 치면 열린 창을 최근 사용 순으로 돌고, Alt 를 놓는
 *  순간 고른 창이 앞으로 온다(최소화돼 있었으면 복원). Shift+Tab 은 역순, Esc 는 취소.
 *
 *  Alt+Tab 은 원래 브라우저가 아니라 OS 가 가져간다. 전체화면에서 키보드 잠금
 *  (Keyboard Lock API, Chromium 계열)을 걸어 두면 페이지로 들어온다 —
 *  useFullscreenKeyboardLock 이 그 일을 한다. 잠금이 안 되는 브라우저를 위해
 *  **Alt+`** 는 언제나 같은 동작을 한다.
 */

/** list 는 창 인스턴스 id — 같은 앱의 창이 여럿이면(문서·표) 각각 따로 돈다 */
interface SwitchState {
  list: string[];
  index: number;
}

export function useAppSwitcher(wm: WindowManager) {
  const [state, setState] = useState<SwitchState | null>(null);
  const stateRef = useRef<SwitchState | null>(null);
  stateRef.current = state;
  const wmRef = useRef(wm);
  wmRef.current = wm;

  const commit = useCallback(() => {
    const cur = stateRef.current;
    if (!cur) return;
    setState(null);
    const target = cur.list[cur.index];
    if (target) wmRef.current.activate(target);
  }, []);

  const cancel = useCallback(() => setState(null), []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const isTab = e.key === "Tab";
      const isBackquote = e.code === "Backquote" || e.key === "`";
      if (!e.altKey || (!isTab && !isBackquote)) {
        if (e.key === "Escape" && stateRef.current) {
          e.preventDefault();
          cancel();
        }
        return;
      }
      if (e.ctrlKey || e.metaKey) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat && !stateRef.current) return;
      const cur = stateRef.current;
      if (!cur) {
        const list = openWindowsByRecency(wmRef.current.wins);
        if (list.length === 0) return;
        // 앞에 있는 창이 0번 — 한 번 누르면 바로 다음(직전에 쓰던) 창을 가리킨다
        const index = list.length === 1 ? 0 : e.shiftKey ? list.length - 1 : 1;
        setState({ list, index });
        return;
      }
      const step = e.shiftKey ? -1 : 1;
      setState({ list: cur.list, index: (cur.index + step + cur.list.length) % cur.list.length });
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (!stateRef.current) return;
      // Alt 를 놓았다 — 어느 쪽 Alt 든, 그리고 altKey 가 이미 false 인 뒤늦은 이벤트든
      if (e.key === "Alt" || !e.altKey) commit();
    };
    // 창을 벗어나면(OS 가 Alt+Tab 을 가져간 경우 등) 열려 있던 전환기는 그대로 닫는다
    const onBlur = () => cancel();
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [commit, cancel]);

  return { state, commit, cancel };
}

/** 전환기 화면 — 가운데 어두운 판에 열린 창이 카드로 늘어선다. */
export function AppSwitcherOverlay({
  state,
  wins,
  onPick,
  labelOf,
}: {
  state: SwitchState | null;
  wins: Record<string, WinState>;
  onPick: (id: string) => void;
  labelOf?: (win: WinState) => string;
}) {
  if (!state) return null;
  return (
    <div className="pointer-events-none absolute inset-0 z-[9400] flex items-center justify-center">
      <div className="pointer-events-auto app-switcher-in flex max-w-[92vw] flex-col gap-3 rounded-2xl border border-white/10 bg-slate-950/85 px-5 pb-4 pt-4 shadow-2xl backdrop-blur-xl">
        <div className="flex flex-wrap justify-center gap-2">
          {state.list.map((id, i) => {
            const win = wins[id];
            if (!win) return null;
            const picked = i === state.index;
            return (
              <button
                key={id}
                onClick={() => onPick(id)}
                className={`flex w-[104px] flex-col items-center gap-2 rounded-xl border px-2 pb-2.5 pt-3 transition ${
                  picked
                    ? "border-sky-400/60 bg-sky-400/20 text-white"
                    : "border-transparent text-slate-300 hover:bg-white/5"
                }`}
              >
                <span
                  className={`flex h-12 w-12 items-center justify-center rounded-xl ${
                    picked ? "bg-white/15" : "bg-white/5"
                  }`}
                >
                  {appIcon(win.appId, 24)}
                </span>
                <span className="max-w-full truncate text-[12px] font-medium">
                  {labelOf ? labelOf(win) : APP_META[win.appId].title}
                </span>
              </button>
            );
          })}
        </div>
        <p className="text-center text-[11px] text-slate-400">
          Alt 를 누른 채 Tab 으로 다음 창 · Shift+Tab 으로 이전 창 · Alt 를 놓으면 전환 · Esc 취소
        </p>
      </div>
    </div>
  );
}

type KeyboardLockApi = { lock?: (keys?: string[]) => Promise<void>; unlock?: () => void };

function keyboardApi(): KeyboardLockApi | null {
  if (typeof navigator === "undefined") return null;
  const kb = (navigator as Navigator & { keyboard?: KeyboardLockApi }).keyboard;
  return kb && typeof kb.lock === "function" ? kb : null;
}

/** 이 브라우저에서 Alt+Tab 을 페이지가 받을 수 있는가 (전체화면일 때) */
export function keyboardLockSupported(): boolean {
  return keyboardApi() !== null;
}

/** 전체화면에 들어가면 Alt·Tab 을 잠가 Alt+Tab 이 OS 로 새지 않게 하고, 나오면 푼다.
 *  잠금은 전체화면에서만 유효하므로(브라우저 규칙) 전체화면 전환 이벤트에 맞춰 건다. */
export function useFullscreenKeyboardLock(onLocked?: (ok: boolean) => void) {
  const cbRef = useRef(onLocked);
  cbRef.current = onLocked;
  useEffect(() => {
    const kb = keyboardApi();
    const sync = () => {
      if (!kb) return;
      if (document.fullscreenElement) {
        kb.lock?.(["AltLeft", "AltRight", "Tab"])
          .then(() => cbRef.current?.(true))
          .catch(() => cbRef.current?.(false));
      } else {
        try {
          kb.unlock?.();
        } catch {
          /* 잠겨 있지 않았다 */
        }
      }
    };
    document.addEventListener("fullscreenchange", sync);
    sync();
    return () => {
      document.removeEventListener("fullscreenchange", sync);
      try {
        kb?.unlock?.();
      } catch {
        /* 무시 */
      }
    };
  }, []);
}

/** 전체화면 요청 — 사용자 제스처 안에서만 성공한다. 거부되면 조용히 넘어간다. */
export function requestDesktopFullscreen(): void {
  if (typeof document === "undefined" || document.fullscreenElement) return;
  document.documentElement.requestFullscreen?.().catch(() => undefined);
}

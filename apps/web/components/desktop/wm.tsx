"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** 데스크톱 앱 식별자 */
export type AppId =
  | "messenger"
  | "ide"
  | "mail"
  | "docs"
  | "sheet"
  | "agent"
  | "files"
  | "terminal"
  | "github"
  | "viewer";

/** 창을 여러 개 띄울 수 있는 앱. 나머지는 여전히 앱당 창 1개. */
export const MULTI_INSTANCE_APPS: readonly AppId[] = ["docs", "sheet"];

/** id 는 인스턴스 식별자(기본 인스턴스="appId", 추가 인스턴스="docs::2"),
 *  appId 는 어떤 앱인지(아이콘·기본 크기 조회용). */
export interface WinState {
  id: string;
  appId: AppId;
  open: boolean;
  minimized: boolean;
  maximized: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
}

const DEFAULTS: Record<AppId, Omit<WinState, "id" | "appId" | "z">> = {
  messenger: { open: false, minimized: false, maximized: false, x: 120, y: 60, w: 780, h: 560 },
  ide: { open: false, minimized: false, maximized: false, x: 200, y: 40, w: 1000, h: 640 },
  mail: { open: false, minimized: false, maximized: false, x: 160, y: 40, w: 1000, h: 640 },
  docs: { open: false, minimized: false, maximized: false, x: 220, y: 50, w: 1020, h: 660 },
  sheet: { open: false, minimized: false, maximized: false, x: 250, y: 70, w: 1020, h: 620 },
  agent: { open: false, minimized: false, maximized: false, x: 320, y: 110, w: 620, h: 580 },
  files: { open: false, minimized: false, maximized: false, x: 240, y: 80, w: 940, h: 580 },
  terminal: { open: false, minimized: false, maximized: false, x: 260, y: 200, w: 760, h: 420 },
  github: { open: false, minimized: false, maximized: false, x: 150, y: 50, w: 1080, h: 680 },
  viewer: { open: false, minimized: false, maximized: false, x: 380, y: 70, w: 760, h: 560 },
};

/** 창 최소 크기 — Window 의 리사이즈 핸들과 같은 값이어야 한다 */
export const MIN_WIN_W = 380;
export const MIN_WIN_H = 260;

/** 새 창이 이전 창 위에 완전히 포개지지 않도록 살짝 계단식으로 어긋낸다. */
function cascade(base: Omit<WinState, "id" | "appId" | "z">, step: number): Omit<WinState, "id" | "appId" | "z"> {
  if (step <= 0) return base;
  const offset = (step % 6) * 28;
  return { ...base, x: base.x + offset, y: base.y + offset };
}

function makeWin(appId: AppId, id: string, z: number, cascadeStep = 0): WinState {
  return { id, appId, z, ...cascade(DEFAULTS[appId], cascadeStep) };
}

/** 열린 창(인스턴스 id)을 최근 사용 순(가장 앞에 있는 창부터)으로 — 앱 전환기가 이 순서로 돈다.
 *  최소화된 창은 OS 처럼 맨 뒤로 보낸다: 방금 최소화한 창이 "직전 창"으로 잡히면 Alt+Tab 이 그 창을 도로 올린다. */
export function openWindowsByRecency(wins: Record<string, WinState>): string[] {
  return Object.keys(wins)
    .filter((id) => wins[id].open)
    .sort((a, b) => {
      const ma = wins[a].minimized ? 1 : 0;
      const mb = wins[b].minimized ? 1 : 0;
      return ma !== mb ? ma - mb : wins[b].z - wins[a].z;
    });
}

/** 복원할 때 화면 밖으로 밀려나지 않게 자리와 크기를 지금 화면에 맞춘다. */
function fitToScreen(win: WinState): WinState {
  const vw = typeof window !== "undefined" ? window.innerWidth : 1440;
  const vh = typeof window !== "undefined" ? window.innerHeight : 900;
  const w = Math.max(MIN_WIN_W, Math.min(win.w, vw - 40));
  const h = Math.max(MIN_WIN_H, Math.min(win.h, vh - 100));
  return {
    ...win,
    w,
    h,
    x: Math.max(16, Math.min(win.x, vw - w - 16)),
    y: Math.max(12, Math.min(win.y, vh - h - 70)),
  };
}

function defaultWins(): Record<string, WinState> {
  const out: Record<string, WinState> = {};
  (Object.keys(DEFAULTS) as AppId[]).forEach((id, i) => {
    out[id] = makeWin(id, id, 10 + i);
  });
  return out;
}

/** 저장해 둔 창 배치를 읽는다. 읽을 수 없으면 null — 그러면 기본 배치로 시작한다.
 *
 *  뷰어 창은 복원하지 않는다. 뷰어는 "어떤 파일을 보고 있었는가" 를 창 밖(데스크톱)에
 *  들고 있어서, 창만 되살리면 빈 뷰어가 뜬다. */
function readWins(key: string): Record<string, WinState> | null {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const saved = JSON.parse(raw) as Record<string, WinState>;
    const base = defaultWins();
    const out: Record<string, WinState> = { ...base };
    for (const [id, win] of Object.entries(saved)) {
      if (!win || typeof win !== "object" || typeof win.appId !== "string") continue;
      if (!(win.appId in DEFAULTS)) continue;
      if (win.appId === "viewer") continue;
      if (!win.open) continue;
      out[id] = fitToScreen({ ...makeWin(win.appId as AppId, id, 10), ...win });
    }
    return out;
  } catch {
    return null;
  }
}

/** 창 배치를 기억한다 (`storageKey` 를 준 화면만).
 *
 *  시험 중 새로고침 한 번이면 메신저·문서·표가 전부 닫혀 빈 바탕화면부터 다시 시작해야 했다.
 *  sessionStorage 라 **그 탭에서만** 산다 — 새 탭은 자기 배치로 시작하고, 서로 덮어쓰지 않는다. */
export function useWindowManager(
  onAppEvent?: (type: "app_open" | "app_close", app: AppId) => void,
  storageKey?: string,
) {
  const zRef = useRef(10);
  const seqRef = useRef(0);
  const [wins, setWins] = useState<Record<string, WinState>>(defaultWins);

  // 복원은 마운트 뒤에 한다 — 첫 렌더를 서버와 같게 두어야 하이드레이션이 어긋나지 않는다.
  useEffect(() => {
    if (!storageKey) return;
    const saved = readWins(storageKey);
    if (!saved) return;
    let maxZ = 10;
    let maxSeq = 0;
    for (const [id, win] of Object.entries(saved)) {
      maxZ = Math.max(maxZ, win.z);
      const suffix = id.includes("::") ? Number(id.split("::")[1]) : 0;
      if (Number.isFinite(suffix)) maxSeq = Math.max(maxSeq, suffix);
    }
    zRef.current = maxZ + 1;
    seqRef.current = maxSeq;
    setWins(saved);
  }, [storageKey]);
  // 갱신 함수 밖에서 현재 상태를 읽기 위한 거울. 이벤트 보고를 갱신 함수 안에서 하면
  // StrictMode 가 갱신 함수를 두 번 부를 때 app_open/app_close 가 두 번 기록된다.
  const winsRef = useRef(wins);
  winsRef.current = wins;

  // 배치를 남긴다. 창을 끄는 동안 좌표가 픽셀마다 바뀌므로 조금 미뤘다 한 번만 쓴다.
  useEffect(() => {
    if (!storageKey) return;
    const t = setTimeout(() => {
      try {
        const open = Object.fromEntries(Object.entries(wins).filter(([, w]) => w.open));
        sessionStorage.setItem(storageKey, JSON.stringify(open));
      } catch {
        /* 저장 못 해도 동작에는 지장이 없다 */
      }
    }, 400);
    return () => clearTimeout(t);
  }, [wins, storageKey]);

  const focus = useCallback((id: string) => {
    zRef.current += 1;
    const z = zRef.current;
    setWins((w) => (w[id] ? { ...w, [id]: { ...w[id], z, minimized: false } } : w));
  }, []);

  /** instanceId 를 안 주면 기본 인스턴스를 연다 — 기존 호출부는 그대로 동작한다. */
  const open = useCallback(
    (appId: AppId, instanceId?: string) => {
      const id = instanceId ?? appId;
      if (!winsRef.current[id]?.open) onAppEvent?.("app_open", appId);
      zRef.current += 1;
      const z = zRef.current;
      setWins((w) => {
        const cur = w[id] ?? makeWin(appId, id, z);
        // 화면 크기에 맞춰 초기 위치 보정
        const vw = typeof window !== "undefined" ? window.innerWidth : 1440;
        const vh = typeof window !== "undefined" ? window.innerHeight : 900;
        const width = Math.min(cur.w, vw - 40);
        const height = Math.min(cur.h, vh - 100);
        const x = cur.open ? cur.x : Math.max(16, Math.min(cur.x, vw - width - 16));
        const y = cur.open ? cur.y : Math.max(12, Math.min(cur.y, vh - height - 70));
        return {
          ...w,
          [id]: { ...cur, open: true, minimized: false, z, x, y, w: width, h: height },
        };
      });
      return id;
    },
    [onAppEvent],
  );

  /** 같은 앱의 새 창을 하나 더 띄운다 (문서·표만) — 항상 새 인스턴스 id 를 발급한다. */
  const openNew = useCallback(
    (appId: AppId) => {
      seqRef.current += 1;
      const id = `${appId}::${seqRef.current}`;
      setWins((w) => ({ ...w, [id]: makeWin(appId, id, zRef.current, seqRef.current) }));
      open(appId, id);
      return id;
    },
    [open],
  );

  const close = useCallback(
    (id: string) => {
      const cur = winsRef.current[id];
      if (!cur) return;
      if (cur.open) onAppEvent?.("app_close", cur.appId);
      setWins((w) => (w[id] ? { ...w, [id]: { ...w[id], open: false, minimized: false, maximized: false } } : w));
    },
    [onAppEvent],
  );

  const minimize = useCallback((id: string) => {
    setWins((w) => (w[id] ? { ...w, [id]: { ...w[id], minimized: true } } : w));
  }, []);

  const toggleMaximize = useCallback((id: string) => {
    zRef.current += 1;
    const z = zRef.current;
    setWins((w) => (w[id] ? { ...w, [id]: { ...w[id], maximized: !w[id].maximized, minimized: false, z } } : w));
  }, []);

  const move = useCallback((id: string, x: number, y: number) => {
    setWins((w) => (w[id] ? { ...w, [id]: { ...w[id], x, y } } : w));
  }, []);

  const resize = useCallback((id: string, width: number, height: number) => {
    setWins((w) =>
      w[id] ? { ...w, [id]: { ...w[id], w: Math.max(MIN_WIN_W, width), h: Math.max(MIN_WIN_H, height) } } : w,
    );
  }, []);

  /** 열려 있으면 앞으로(최소화 해제), 닫혀 있으면 연다 — 작업 표시줄 클릭·앱 전환기·알림 클릭이 쓰는 한 동작.
   *  인스턴스 id("docs::2")도, 앱 id("docs" = 기본 인스턴스)도 받는다. */
  const activate = useCallback(
    (id: string) => {
      const appId = (winsRef.current[id]?.appId ?? id) as AppId;
      open(appId, id);
      focus(id);
    },
    [open, focus],
  );

  /** 이 앱 타입의 창 인스턴스 전부(닫힌 것 포함) — taskbar·데스크톱 렌더링용. */
  const instancesOf = useCallback((appId: AppId) => Object.values(wins).filter((w) => w.appId === appId), [wins]);

  return { wins, open, openNew, close, focus, minimize, toggleMaximize, move, resize, activate, instancesOf };
}

export type WindowManager = ReturnType<typeof useWindowManager>;

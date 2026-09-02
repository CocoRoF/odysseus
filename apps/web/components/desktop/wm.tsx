"use client";

import { useCallback, useRef, useState } from "react";

/** 데스크톱 앱 식별자 — 4개 고정 (앱당 창 1개) */
export type AppId = "messenger" | "ide" | "agent" | "files" | "viewer";

export interface WinState {
  id: AppId;
  open: boolean;
  minimized: boolean;
  maximized: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
}

const DEFAULTS: Record<AppId, Omit<WinState, "id" | "z">> = {
  messenger: { open: false, minimized: false, maximized: false, x: 120, y: 60, w: 780, h: 560 },
  ide: { open: false, minimized: false, maximized: false, x: 200, y: 40, w: 1000, h: 640 },
  agent: { open: false, minimized: false, maximized: false, x: 320, y: 110, w: 620, h: 580 },
  files: { open: false, minimized: false, maximized: false, x: 240, y: 80, w: 940, h: 580 },
  viewer: { open: false, minimized: false, maximized: false, x: 380, y: 70, w: 760, h: 560 },
};

export function useWindowManager(onAppEvent?: (type: "app_open" | "app_close", app: AppId) => void) {
  const zRef = useRef(10);
  const [wins, setWins] = useState<Record<AppId, WinState>>(() => {
    const out = {} as Record<AppId, WinState>;
    (Object.keys(DEFAULTS) as AppId[]).forEach((id, i) => {
      out[id] = { id, z: 10 + i, ...DEFAULTS[id] };
    });
    return out;
  });

  const focus = useCallback((id: AppId) => {
    zRef.current += 1;
    const z = zRef.current;
    setWins((w) => ({ ...w, [id]: { ...w[id], z, minimized: false } }));
  }, []);

  const open = useCallback(
    (id: AppId) => {
      setWins((w) => {
        if (!w[id].open) onAppEvent?.("app_open", id);
        zRef.current += 1;
        // 화면 크기에 맞춰 초기 위치 보정
        const vw = typeof window !== "undefined" ? window.innerWidth : 1440;
        const vh = typeof window !== "undefined" ? window.innerHeight : 900;
        const cur = w[id];
        const width = Math.min(cur.w, vw - 40);
        const height = Math.min(cur.h, vh - 100);
        const x = cur.open ? cur.x : Math.max(16, Math.min(cur.x, vw - width - 16));
        const y = cur.open ? cur.y : Math.max(12, Math.min(cur.y, vh - height - 70));
        return {
          ...w,
          [id]: { ...cur, open: true, minimized: false, z: zRef.current, x, y, w: width, h: height },
        };
      });
    },
    [onAppEvent],
  );

  const close = useCallback(
    (id: AppId) => {
      setWins((w) => {
        if (w[id].open) onAppEvent?.("app_close", id);
        return { ...w, [id]: { ...w[id], open: false, maximized: false } };
      });
    },
    [onAppEvent],
  );

  const minimize = useCallback((id: AppId) => {
    setWins((w) => ({ ...w, [id]: { ...w[id], minimized: true } }));
  }, []);

  const toggleMaximize = useCallback((id: AppId) => {
    zRef.current += 1;
    const z = zRef.current;
    setWins((w) => ({ ...w, [id]: { ...w[id], maximized: !w[id].maximized, minimized: false, z } }));
  }, []);

  const move = useCallback((id: AppId, x: number, y: number) => {
    setWins((w) => ({ ...w, [id]: { ...w[id], x, y } }));
  }, []);

  const resize = useCallback((id: AppId, width: number, height: number) => {
    setWins((w) => ({ ...w, [id]: { ...w[id], w: Math.max(380, width), h: Math.max(260, height) } }));
  }, []);

  const restoreOrOpen = useCallback(
    (id: AppId) => {
      setWins((w) => {
        if (!w[id].open) return w; // open()이 처리
        zRef.current += 1;
        return { ...w, [id]: { ...w[id], minimized: w[id].minimized ? false : w[id].minimized, z: zRef.current } };
      });
      open(id);
    },
    [open],
  );

  return { wins, open, close, focus, minimize, toggleMaximize, move, resize, restoreOrOpen };
}

export type WindowManager = ReturnType<typeof useWindowManager>;

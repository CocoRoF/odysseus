"use client";

import { ReactNode, useRef } from "react";
import { IconClose, IconMaximize, IconMinimize } from "@/components/icons";
import type { AppId, WindowManager, WinState } from "./wm";

/** 데스크톱 창 프레임 — 타이틀바 드래그, 우하단 리사이즈, 최소화/최대화/닫기 */
export function Window({
  win,
  wm,
  title,
  icon,
  accent = "bg-slate-100",
  children,
}: {
  win: WinState;
  wm: WindowManager;
  title: string;
  icon: ReactNode;
  accent?: string;
  children: ReactNode;
}) {
  const dragRef = useRef<{ startX: number; startY: number; baseX: number; baseY: number } | null>(null);

  if (!win.open || win.minimized) return null;

  const style = win.maximized
    ? { left: 8, top: 8, width: "calc(100vw - 16px)", height: "calc(100vh - 74px)", zIndex: win.z }
    : { left: win.x, top: win.y, width: win.w, height: win.h, zIndex: win.z };

  const startDrag = (e: React.PointerEvent) => {
    if (win.maximized) return;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    dragRef.current = { startX: e.clientX, startY: e.clientY, baseX: win.x, baseY: win.y };
    const moveHandler = (ev: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const nx = Math.max(-win.w + 120, Math.min(d.baseX + ev.clientX - d.startX, window.innerWidth - 100));
      const ny = Math.max(0, Math.min(d.baseY + ev.clientY - d.startY, window.innerHeight - 90));
      wm.move(win.id, nx, ny);
    };
    const upHandler = (ev: PointerEvent) => {
      el.releasePointerCapture(ev.pointerId);
      el.removeEventListener("pointermove", moveHandler);
      el.removeEventListener("pointerup", upHandler);
      dragRef.current = null;
    };
    el.addEventListener("pointermove", moveHandler);
    el.addEventListener("pointerup", upHandler);
  };

  const startResize = (e: React.PointerEvent) => {
    if (win.maximized) return;
    e.stopPropagation();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const base = { w: win.w, h: win.h, x: e.clientX, y: e.clientY };
    const moveHandler = (ev: PointerEvent) => {
      wm.resize(win.id, base.w + ev.clientX - base.x, base.h + ev.clientY - base.y);
    };
    const upHandler = (ev: PointerEvent) => {
      el.releasePointerCapture(ev.pointerId);
      el.removeEventListener("pointermove", moveHandler);
      el.removeEventListener("pointerup", upHandler);
    };
    el.addEventListener("pointermove", moveHandler);
    el.addEventListener("pointerup", upHandler);
  };

  return (
    <div
      className="window-in window-shadow absolute flex flex-col overflow-hidden rounded-xl border border-slate-300/60 bg-white"
      style={style}
      onPointerDown={() => wm.focus(win.id)}
    >
      {/* 타이틀바 */}
      <div
        className={`flex h-10 shrink-0 select-none items-center gap-2 border-b border-slate-200 px-3 ${accent}`}
        onPointerDown={startDrag}
        onDoubleClick={() => wm.toggleMaximize(win.id)}
      >
        <span className="flex h-5 w-5 items-center justify-center text-slate-500">{icon}</span>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-700">{title}</span>
        <div className="flex items-center gap-1" onPointerDown={(e) => e.stopPropagation()}>
          <button
            title="최소화"
            onClick={() => wm.minimize(win.id)}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-200/70 hover:text-slate-600"
          >
            <IconMinimize size={14} />
          </button>
          <button
            title={win.maximized ? "이전 크기" : "최대화"}
            onClick={() => wm.toggleMaximize(win.id)}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-200/70 hover:text-slate-600"
          >
            <IconMaximize size={13} />
          </button>
          <button
            title="닫기"
            onClick={() => wm.close(win.id)}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-slate-400 hover:bg-red-500 hover:text-white"
          >
            <IconClose size={15} />
          </button>
        </div>
      </div>
      {/* 본문 */}
      <div className="min-h-0 flex-1">{children}</div>
      {/* 리사이즈 핸들 */}
      {!win.maximized && (
        <div
          className="absolute bottom-0 right-0 h-4 w-4 cursor-nwse-resize"
          onPointerDown={startResize}
        />
      )}
    </div>
  );
}

export const APP_META: Record<
  AppId,
  { title: string; accent: string }
> = {
  messenger: { title: "메신저", accent: "bg-violet-50" },
  ide: { title: "IDE", accent: "bg-slate-100" },
  agent: { title: "AI 에이전트", accent: "bg-sky-50" },
  files: { title: "폴더", accent: "bg-amber-50" },
};

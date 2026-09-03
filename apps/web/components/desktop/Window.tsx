"use client";

import { ReactNode, useRef } from "react";
import { IconClose, IconMaximize, IconMinimize } from "@/components/icons";
import type { AppId, WindowManager, WinState } from "./wm";

const MIN_W = 380;
const MIN_H = 260;
const EDGE = 6; // 잡을 수 있는 변 두께(px) — 얇으면 못 잡고, 두꺼우면 내용 클릭을 가린다
const CORNER = 14;

type ResizeDir = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

/** 변은 창 테두리에 걸쳐 놓아 바깥에서도 잡히게 한다. (Tailwind 는 계산된 클래스를
 *  만들지 못하므로 위치는 인라인 스타일로 준다.) */
const RESIZE_HANDLES: { dir: ResizeDir; cursor: string; style: React.CSSProperties }[] = [
  { dir: "n", cursor: "ns-resize", style: { left: CORNER, right: CORNER, top: -EDGE / 2, height: EDGE } },
  { dir: "s", cursor: "ns-resize", style: { left: CORNER, right: CORNER, bottom: -EDGE / 2, height: EDGE } },
  { dir: "w", cursor: "ew-resize", style: { top: CORNER, bottom: CORNER, left: -EDGE / 2, width: EDGE } },
  { dir: "e", cursor: "ew-resize", style: { top: CORNER, bottom: CORNER, right: -EDGE / 2, width: EDGE } },
  { dir: "nw", cursor: "nwse-resize", style: { left: -EDGE / 2, top: -EDGE / 2, width: CORNER, height: CORNER } },
  { dir: "ne", cursor: "nesw-resize", style: { right: -EDGE / 2, top: -EDGE / 2, width: CORNER, height: CORNER } },
  { dir: "sw", cursor: "nesw-resize", style: { left: -EDGE / 2, bottom: -EDGE / 2, width: CORNER, height: CORNER } },
  { dir: "se", cursor: "nwse-resize", style: { right: -EDGE / 2, bottom: -EDGE / 2, width: CORNER, height: CORNER } },
];

/** 데스크톱 창 프레임 — 타이틀바 드래그, 8방향 리사이즈, 최소화/최대화/닫기 */
export function Window({
  win,
  wm,
  title,
  icon,
  accent = "bg-slate-100",
  theme = "light",
  children,
}: {
  win: WinState;
  wm: WindowManager;
  title: string;
  icon: ReactNode;
  accent?: string;
  theme?: "light" | "dark";
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

  /** 8방향 리사이즈 — 변과 모서리 어디를 잡아도 된다. 왼쪽·위를 잡으면 창이 그쪽으로 늘어난다. */
  const startResize = (e: React.PointerEvent, dir: ResizeDir) => {
    if (win.maximized) return;
    e.stopPropagation();
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const base = { x: win.x, y: win.y, w: win.w, h: win.h, px: e.clientX, py: e.clientY };
    const moveHandler = (ev: PointerEvent) => {
      const dx = ev.clientX - base.px;
      const dy = ev.clientY - base.py;
      let { x, y, w, h } = base;
      if (dir.includes("e")) w = base.w + dx;
      if (dir.includes("s")) h = base.h + dy;
      if (dir.includes("w")) {
        w = Math.max(MIN_W, base.w - dx);
        x = base.x + (base.w - w); // 오른쪽 변은 고정
      }
      if (dir.includes("n")) {
        h = Math.max(MIN_H, base.h - dy);
        y = Math.max(0, base.y + (base.h - h)); // 아래 변은 고정
      }
      wm.resize(win.id, w, h);
      if (dir.includes("w") || dir.includes("n")) wm.move(win.id, x, y);
    };
    const upHandler = (ev: PointerEvent) => {
      el.releasePointerCapture(ev.pointerId);
      el.removeEventListener("pointermove", moveHandler);
      el.removeEventListener("pointerup", upHandler);
    };
    el.addEventListener("pointermove", moveHandler);
    el.addEventListener("pointerup", upHandler);
  };

  const dark = theme === "dark";
  const frameCls = dark
    ? "border-black/60 bg-[#1e1e1e]"
    : "border-slate-300/60 bg-white";
  const titleCls = dark
    ? "border-black/50 bg-[#323233]"
    : `border-slate-200 ${accent}`;
  const btnCls = dark
    ? "text-[#9a9a9a] hover:bg-white/10 hover:text-white"
    : "text-slate-400 hover:bg-slate-200/70 hover:text-slate-600";

  return (
    <div
      data-app={win.id}
      className={`window-in window-shadow absolute flex flex-col rounded-xl border ${frameCls}`}
      style={style}
      onPointerDown={() => wm.focus(win.id)}
    >
      {/* 타이틀바 */}
      <div
        className={`flex h-10 shrink-0 select-none items-center gap-2 rounded-t-xl border-b px-3 ${titleCls}`}
        onPointerDown={startDrag}
        onDoubleClick={() => wm.toggleMaximize(win.id)}
      >
        <span className={`flex h-5 w-5 items-center justify-center ${dark ? "text-[#9a9a9a]" : "text-slate-500"}`}>{icon}</span>
        <span className={`min-w-0 flex-1 truncate text-sm font-semibold ${dark ? "text-[#cccccc]" : "text-slate-700"}`}>{title}</span>
        <div className="flex items-center gap-1" onPointerDown={(e) => e.stopPropagation()}>
          <button
            title="최소화"
            onClick={() => wm.minimize(win.id)}
            className={`flex h-7 w-7 items-center justify-center rounded-lg ${btnCls}`}
          >
            <IconMinimize size={14} />
          </button>
          <button
            title={win.maximized ? "이전 크기" : "최대화"}
            onClick={() => wm.toggleMaximize(win.id)}
            className={`flex h-7 w-7 items-center justify-center rounded-lg ${btnCls}`}
          >
            <IconMaximize size={13} />
          </button>
          <button
            title="닫기"
            onClick={() => wm.close(win.id)}
            className={`flex h-7 w-7 items-center justify-center rounded-lg ${dark ? "text-[#9a9a9a]" : "text-slate-400"} hover:bg-red-500 hover:text-white`}
          >
            <IconClose size={15} />
          </button>
        </div>
      </div>
      {/* 본문 — 모서리 둥글기를 따라 잘라낸다 */}
      <div className="min-h-0 flex-1 overflow-hidden rounded-b-xl">{children}</div>
      {/* 리사이즈 핸들 — 변 4개 + 모서리 4개. 모서리가 변보다 위에 오도록 뒤에 그린다. */}
      {!win.maximized &&
        RESIZE_HANDLES.map(({ dir, cursor, style }) => (
          <div
            key={dir}
            data-resize={dir}
            className="absolute z-10"
            style={{ ...style, cursor }}
            onPointerDown={(e) => startResize(e, dir)}
          />
        ))}
    </div>
  );
}

export const APP_META: Record<
  AppId,
  { title: string; accent: string; theme: "light" | "dark" }
> = {
  messenger: { title: "메신저", accent: "bg-violet-50", theme: "light" },
  ide: { title: "IDE", accent: "bg-slate-100", theme: "dark" },
  agent: { title: "AI 에이전트", accent: "bg-sky-50", theme: "light" },
  files: { title: "폴더", accent: "bg-amber-50", theme: "light" },
  terminal: { title: "터미널", accent: "bg-slate-100", theme: "dark" },
  github: { title: "GitHub", accent: "bg-slate-100", theme: "dark" },
  browser: { title: "인터넷", accent: "bg-sky-50", theme: "light" },
  viewer: { title: "뷰어", accent: "bg-slate-50", theme: "light" },
};

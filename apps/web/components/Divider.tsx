"use client";

import { useState } from "react";

/** 패널 구분선 — 호버 강조 + 포인터 캡처 드래그 (수직/수평) */
export function Divider({
  orientation,
  onMove,
  tone = "light",
}: {
  orientation: "vertical" | "horizontal";
  onMove: (clientX: number, clientY: number) => void;
  tone?: "light" | "dark";
}) {
  const [dragging, setDragging] = useState(false);
  const palette =
    tone === "dark"
      ? dragging
        ? "bg-[#0078d4]"
        : "bg-black/40 hover:bg-[#0078d4]/80"
      : dragging
        ? "bg-violet-500"
        : "bg-slate-200 hover:bg-violet-400/80";
  const base = "relative z-20 shrink-0 transition-colors " + palette;
  const dims =
    orientation === "vertical"
      ? "w-1 cursor-col-resize after:absolute after:inset-y-0 after:-left-1.5 after:-right-1.5"
      : "h-1 cursor-row-resize after:absolute after:inset-x-0 after:-top-1.5 after:-bottom-1.5";
  return (
    <div
      className={`${base} ${dims} after:content-['']`}
      onPointerDown={(e) => {
        e.preventDefault();
        setDragging(true);
        const el = e.currentTarget;
        el.setPointerCapture(e.pointerId);
        const move = (ev: PointerEvent) => onMove(ev.clientX, ev.clientY);
        const up = (ev: PointerEvent) => {
          el.releasePointerCapture(ev.pointerId);
          el.removeEventListener("pointermove", move);
          el.removeEventListener("pointerup", up);
          setDragging(false);
        };
        el.addEventListener("pointermove", move);
        el.addEventListener("pointerup", up);
      }}
    />
  );
}

"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export interface MenuItem {
  label: string;
  onClick: () => void;
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
}

export type MenuEntry = MenuItem | "separator";

interface MenuState {
  x: number;
  y: number;
  items: MenuEntry[];
  dark: boolean;
}

/** 데스크톱 앱 공용 우클릭 메뉴 — 브라우저 기본 메뉴를 대체한다. */
export function useContextMenu() {
  const [menu, setMenu] = useState<MenuState | null>(null);

  const open = useCallback(
    (e: React.MouseEvent, items: MenuEntry[], opts?: { dark?: boolean }) => {
      e.preventDefault();
      e.stopPropagation();
      if (items.length === 0) return;
      setMenu({ x: e.clientX, y: e.clientY, items, dark: opts?.dark ?? false });
    },
    [],
  );

  const close = useCallback(() => setMenu(null), []);

  return { menu, open, close };
}

export function ContextMenuView({ menu, onClose }: { menu: MenuState | null; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    // 캡처 단계로 듣되, 메뉴 내부 클릭은 무시한다.
    // (stopPropagation은 캡처 리스너보다 늦게 실행되므로 메뉴가 먼저 닫혀 항목 클릭이 사라진다)
    const onDown = (e: Event) => {
      if (ref.current && e.target instanceof Node && ref.current.contains(e.target)) return;
      onClose();
    };
    const onBlur = () => onClose();
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [menu, onClose]);

  if (!menu) return null;

  // 화면 밖으로 나가지 않게 보정 (메뉴 크기 추정치)
  const width = 208;
  const height = menu.items.length * 30 + 12;
  const x = Math.min(menu.x, (typeof window !== "undefined" ? window.innerWidth : 1440) - width - 8);
  const y = Math.min(menu.y, (typeof window !== "undefined" ? window.innerHeight : 900) - height - 8);

  const shell = menu.dark
    ? "border-black/60 bg-[#252526] text-[#cccccc]"
    : "border-slate-200 bg-white text-slate-700";
  const sep = menu.dark ? "bg-white/10" : "bg-slate-200";

  return (
    <div
      ref={ref}
      className={`fixed z-[10000] min-w-52 rounded-lg border py-1 shadow-2xl ${shell}`}
      style={{ left: Math.max(4, x), top: Math.max(4, y) }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {menu.items.map((item, i) =>
        item === "separator" ? (
          <div key={`s${i}`} className={`my-1 h-px ${sep}`} />
        ) : (
          <button
            key={item.label + i}
            disabled={item.disabled}
            onClick={() => {
              onClose();
              item.onClick();
            }}
            className={`flex w-full items-center gap-3 px-3 py-1.5 text-left text-[13px] disabled:opacity-40 ${
              item.danger
                ? menu.dark
                  ? "text-red-400 hover:bg-red-500/20"
                  : "text-red-600 hover:bg-red-50"
                : menu.dark
                  ? "hover:bg-[#04395e]"
                  : "hover:bg-slate-100"
            }`}
          >
            <span className="min-w-0 flex-1 truncate">{item.label}</span>
            {item.shortcut && (
              <span className={menu.dark ? "text-[11px] text-[#8a8a8a]" : "text-[11px] text-slate-400"}>
                {item.shortcut}
              </span>
            )}
          </button>
        ),
      )}
    </div>
  );
}

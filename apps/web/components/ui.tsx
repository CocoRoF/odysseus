"use client";

import Link from "next/link";
import { IconClose, IconLock } from "./icons";
import { READ_ONLY_REASON, useReadOnly } from "./readonly";
import { ReactNode, useEffect, useRef } from "react";
import { IconSearch } from "./icons";

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-16 text-slate-500">
      <div className="h-5 w-5 animate-spin rounded-full border-2 border-slate-300 border-t-slate-600" />
      {label && <span className="text-sm">{label}</span>}
    </div>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-xl border border-slate-200 bg-white shadow-sm ${className}`}>{children}</div>
  );
}

const badgeColors: Record<string, string> = {
  // verdict
  AC: "bg-emerald-100 text-emerald-700",
  WA: "bg-red-100 text-red-700",
  CE: "bg-amber-100 text-amber-700",
  RE: "bg-orange-100 text-orange-700",
  TLE: "bg-purple-100 text-purple-700",
  IE: "bg-slate-200 text-slate-600",
  // difficulty
  easy: "bg-emerald-100 text-emerald-700",
  medium: "bg-amber-100 text-amber-700",
  hard: "bg-red-100 text-red-700",
  // status
  in_progress: "bg-blue-100 text-blue-700",
  submitted: "bg-emerald-100 text-emerald-700",
  expired: "bg-slate-200 text-slate-600",
  // mode
  standard: "bg-slate-100 text-slate-700",
  ai_assisted: "bg-violet-100 text-violet-700",
  // role
  admin: "bg-red-100 text-red-700",
  evaluator: "bg-blue-100 text-blue-700",
  candidate: "bg-slate-100 text-slate-700",
  guest: "bg-amber-100 text-amber-800",
  demo_admin: "bg-sky-100 text-sky-800",
};

export function Badge({ value, label }: { value: string; label?: string }) {
  const color = badgeColors[value] || "bg-slate-100 text-slate-700";
  return (
    <span
      className={`inline-block shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold ${color}`}
    >
      {label ?? value}
    </span>
  );
}

export function Button({
  children,
  onClick,
  variant = "primary",
  disabled,
  type = "button",
  className = "",
  write = false,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "primary" | "secondary" | "danger" | "ghost";
  disabled?: boolean;
  type?: "button" | "submit";
  className?: string;
  /** 무언가를 바꾸는 버튼인가 — 둘러보기 계정에서는 잠기고 자물쇠와 이유가 붙는다 (readonly.tsx) */
  write?: boolean;
}) {
  // 훅은 조건 없이 부른다 — write 가 바뀌는 자리에서 호출 순서가 달라지면 React 가 깨진다.
  const readOnly = useReadOnly();
  const locked = write && readOnly;
  const styles = {
    primary: "bg-slate-900 text-white hover:bg-slate-700 disabled:bg-slate-400",
    secondary: "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 disabled:text-slate-400",
    danger: "bg-red-600 text-white hover:bg-red-500 disabled:bg-red-300",
    ghost: "text-slate-600 hover:bg-slate-100 disabled:text-slate-300",
  }[variant];
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled || locked}
      title={locked ? READ_ONLY_REASON : undefined}
      className={`shrink-0 whitespace-nowrap rounded-lg px-4 py-2 text-sm font-medium transition disabled:cursor-not-allowed ${styles} ${className}`}
    >
      {locked ? (
        <span className="inline-flex items-center gap-1.5">
          <IconLock size={13} />
          {children}
        </span>
      ) : (
        children
      )}
    </button>
  );
}

/** 목록 헤더용 검색창 */
export function SearchInput({
  value,
  onChange,
  placeholder = "검색...",
  className = "",
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
}) {
  return (
    <div className={`relative ${className}`}>
      <IconSearch className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={14} />
      <input
        type="search"
        className="w-56 rounded-lg border border-slate-300 bg-white py-2 pl-8 pr-3 text-sm placeholder-slate-400 focus:border-slate-500 focus:outline-none"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

/** 표 액션용 아이콘 단일 버튼 — title이 접근성 라벨과 툴팁을 겸한다. */
export function IconButton({
  title,
  onClick,
  href,
  tone = "default",
  children,
  write = false,
  disabled = false,
}: {
  title: string;
  onClick?: () => void;
  href?: string;
  tone?: "default" | "danger";
  children: ReactNode;
  /** 무언가를 바꾸는 조작인가 — 둘러보기 계정에서는 잠긴다 (readonly.tsx) */
  write?: boolean;
  disabled?: boolean;
}) {
  const readOnly = useReadOnly();
  const locked = write && readOnly;
  const cls = `inline-flex h-8 w-8 items-center justify-center rounded-lg text-[15px] transition ${
    locked || disabled
      ? "cursor-not-allowed text-slate-300"
      : tone === "danger"
        ? "text-slate-400 hover:bg-red-50 hover:text-red-600"
        : "text-slate-400 hover:bg-slate-100 hover:text-slate-700"
  }`;
  if (locked || disabled) {
    // 자리는 남긴다 — 관리자 화면에 무엇이 있는지 보여 주는 것이 둘러보기의 목적이다.
    return (
      <button
        type="button"
        disabled
        aria-disabled
        title={locked ? `${title} — ${READ_ONLY_REASON}` : title}
        aria-label={title}
        className={cls}
      >
        {children}
      </button>
    );
  }
  if (href) {
    return (
      <Link href={href} title={title} aria-label={title} className={cls}>
        {children}
      </Link>
    );
  }
  return (
    <button type="button" title={title} aria-label={title} onClick={onClick} className={cls}>
      {children}
    </button>
  );
}

export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-slate-700">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-slate-400">{hint}</span>}
    </label>
  );
}

/** 입력칸 공통 모양. **너비는 넣지 않는다** — 칸마다 다른 너비를 주면 w-full 과 부딪혀
 *  한 칸이 줄을 통째로 먹는다(2026-09-19 자동 체크 행). 기본 너비는 inputCls 를 쓰는 쪽에서 준다. */
export const inputBaseCls =
  "rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none";
export const inputCls = `w-full ${inputBaseCls}`;

export function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  // 닫는 길은 눈에 보여야 한다. 예전에는 바깥을 클릭하는 방법뿐이라, 창이 열린 줄만 알고
  // 어떻게 나가는지는 짐작해야 했다. Esc 도 함께 받는다.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // text-slate-900을 명시해 다크 페이지(응시 화면 등) 위에서도 색이 깨지지 않게 한다
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-white p-6 text-slate-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <h3 className="text-lg font-bold text-slate-900">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            title="닫기 (Esc)"
            aria-label="닫기"
            className="-mr-1 -mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
          >
            <IconClose size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function EmptyState({ message }: { message: string }) {
  return <div className="py-16 text-center text-sm text-slate-400">{message}</div>;
}

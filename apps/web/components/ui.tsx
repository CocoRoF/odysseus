"use client";

import Link from "next/link";
import { ReactNode } from "react";
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
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "primary" | "secondary" | "danger" | "ghost";
  disabled?: boolean;
  type?: "button" | "submit";
  className?: string;
}) {
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
      disabled={disabled}
      className={`rounded-lg px-4 py-2 text-sm font-medium transition disabled:cursor-not-allowed ${styles} ${className}`}
    >
      {children}
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
}: {
  title: string;
  onClick?: () => void;
  href?: string;
  tone?: "default" | "danger";
  children: ReactNode;
}) {
  const cls = `inline-flex h-8 w-8 items-center justify-center rounded-lg text-[15px] transition ${
    tone === "danger"
      ? "text-slate-400 hover:bg-red-50 hover:text-red-600"
      : "text-slate-400 hover:bg-slate-100 hover:text-slate-700"
  }`;
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

export const inputCls =
  "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none";

export function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
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
        <h3 className="mb-4 text-lg font-bold text-slate-900">{title}</h3>
        {children}
      </div>
    </div>
  );
}

export function EmptyState({ message }: { message: string }) {
  return <div className="py-16 text-center text-sm text-slate-400">{message}</div>;
}

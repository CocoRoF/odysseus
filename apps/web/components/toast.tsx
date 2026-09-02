"use client";

import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";

type ToastKind = "success" | "error" | "info";

interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

interface ConfirmOptions {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

interface ToastContextValue {
  toast: (message: string, kind?: ToastKind) => void;
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}

const KIND_STYLE: Record<ToastKind, { bar: string; icon: ReactNode }> = {
  success: {
    bar: "bg-emerald-500",
    icon: (
      <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden>
        <path d="M5 10.5l3.5 3.5L15 6.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  error: {
    bar: "bg-red-500",
    icon: (
      <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden>
        <path d="M6 6l8 8M14 6l-8 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    ),
  },
  info: {
    bar: "bg-slate-500",
    icon: (
      <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden>
        <circle cx="10" cy="10" r="7.5" stroke="currentColor" strokeWidth="1.6" />
        <path d="M10 9v4.5M10 6.5v.01" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    ),
  },
};

const ICON_TONE: Record<ToastKind, string> = {
  success: "text-emerald-500",
  error: "text-red-500",
  info: "text-slate-500",
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [dialog, setDialog] = useState<(ConfirmOptions & { resolve: (v: boolean) => void }) | null>(null);
  const nextId = useRef(1);

  const toast = useCallback((message: string, kind: ToastKind = "info") => {
    const id = nextId.current++;
    setToasts((prev) => [...prev, { id, kind, message }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4000);
  }, []);

  const confirm = useCallback(
    (opts: ConfirmOptions) => new Promise<boolean>((resolve) => setDialog({ ...opts, resolve })),
    [],
  );

  const closeDialog = (value: boolean) => {
    dialog?.resolve(value);
    setDialog(null);
  };

  return (
    <ToastContext.Provider value={{ toast, confirm }}>
      {children}

      {/* 토스트 스택 */}
      <div className="pointer-events-none fixed bottom-5 right-5 z-[100] flex w-full max-w-sm flex-col gap-2">
        {toasts.map((t) => {
          const s = KIND_STYLE[t.kind];
          return (
            <div
              key={t.id}
              className="toast-in pointer-events-auto flex items-start gap-3 overflow-hidden rounded-xl border border-slate-200 bg-white pl-0 shadow-lg"
            >
              <span className={`w-1 self-stretch ${s.bar}`} />
              <span className={`mt-3 shrink-0 ${ICON_TONE[t.kind]}`}>{s.icon}</span>
              <p className="min-w-0 flex-1 whitespace-pre-wrap py-3 pr-3 text-sm text-slate-700">{t.message}</p>
            </div>
          );
        })}
      </div>

      {/* 확인 다이얼로그 */}
      {dialog && (
        <div
          className="fixed inset-0 z-[110] flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm"
          onClick={() => closeDialog(false)}
        >
          <div
            className="w-full max-w-sm rounded-2xl bg-white p-6 text-slate-900 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-base font-bold">{dialog.title}</h3>
            {dialog.message && <p className="mt-1.5 text-sm text-slate-500">{dialog.message}</p>}
            <div className="mt-5 flex justify-end gap-2">
              <button
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
                onClick={() => closeDialog(false)}
              >
                {dialog.cancelLabel ?? "취소"}
              </button>
              <button
                className={`rounded-lg px-4 py-2 text-sm font-semibold text-white ${
                  dialog.danger ? "bg-red-600 hover:bg-red-500" : "bg-slate-900 hover:bg-slate-700"
                }`}
                onClick={() => closeDialog(true)}
                autoFocus
              >
                {dialog.confirmLabel ?? "확인"}
              </button>
            </div>
          </div>
        </div>
      )}
    </ToastContext.Provider>
  );
}

"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, ApiError } from "@/lib/api";
import type { Role, User } from "@/lib/types";

export function useUser(requiredRoles?: Role[]) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;
    api
      .get<User>("/auth/me")
      .then((u) => {
        if (cancelled) return;
        if (requiredRoles && !requiredRoles.includes(u.role)) {
          router.replace(homeFor(u.role));
          return;
        }
        setUser(u);
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        if (e instanceof ApiError && e.status === 401) {
          router.replace("/login");
        }
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { user, loading };
}

export function homeFor(role: Role): string {
  if (role === "admin") return "/admin/scenarios";
  if (role === "evaluator") return "/review";
  return "/dashboard";
}

export async function logout(router: { replace: (p: string) => void }) {
  try {
    await api.post("/auth/logout");
  } finally {
    // 공유 PC 대비 — 서버의 Clear-Site-Data 와 별개로 여기서도 지운다 (ODY-023)
    try {
      sessionStorage.clear();
      localStorage.clear();
    } catch {
      /* 저장소 접근 불가 */
    }
    router.replace("/login");
  }
}

"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, ApiError, resetIdentityState, setReadOnly } from "@/lib/api";
import { useToast } from "@/components/toast";
import type { Role, User } from "@/lib/types";

/** 비밀번호로 다시 들어올 수 없는 역할 — 나가면 그 계정은 끝이다 (api: account_sweep). */
const ONE_WAY_ROLES: Role[] = ["guest", "demo_admin"];

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
        // 둘러보기 계정은 관리 화면을 관리자와 같은 자리에서 본다. 페이지마다 역할을 다시
        // 적지 않는다 — 한 곳에서 넓히는 편이 빠뜨릴 자리가 없다. 쓰기는 서버가 막는다(demo.py).
        const allowed =
          requiredRoles && requiredRoles.includes("admin")
            ? [...requiredRoles, "demo_admin" as Role]
            : requiredRoles;
        setReadOnly(u.role === "demo_admin");
        if (allowed && !allowed.includes(u.role)) {
          router.replace(homeFor(u.role));
          return;
        }
        setUser(u);
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        // 401 = 세션 없음/만료. 403 = 이 주소가 차단됨 (deps.get_current_user).
        // 둘 다 로그인 화면으로 보낸다 — 403 을 그냥 두면 화면이 영원히 로딩 상태로 남고,
        // 로그인 화면에서는 차단 사유가 그대로 보인다.
        if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
          // 더 이상 이 브라우저의 신분이 아니다 — 남은 잠금·경고를 걷고 보낸다
          resetIdentityState();
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
  // 게스트는 둘러보러 온 사람이다 — 목록이 아니라 사무실이 첫 화면이다.
  if (role === "guest") return "/office";
  // 둘러보기 계정은 관리 화면만 본다 — 응시자 화면은 서버가 거절한다.
  if (role === "demo_admin") return "/admin/scenarios";
  return "/dashboard";
}

/** 나가기 — 손님 계정에는 먼저 묻는다.
 *
 *  게스트도 둘러보기도 비밀번호 경로가 닫혀 있어, 한 번 나가면 **같은 계정으로 다시 들어올 수 없다.**
 *  응시 중이라면 그 시험까지 함께 끝난다. 확인 없이 나가지는 버튼 하나가 180분을 지울 수 있었다.
 */
export function useLogout() {
  const router = useRouter();
  const { confirm } = useToast();
  return useCallback(
    async (user?: Pick<User, "role"> | null, opts?: { examInProgress?: boolean }) => {
      if (user && ONE_WAY_ROLES.includes(user.role)) {
        const ok = await confirm({
          title: opts?.examInProgress ? "시험을 그만두고 나갈까요?" : "나갈까요?",
          message: opts?.examInProgress ? (
            <>
              지금 <b>응시 중</b>입니다. 나가면 이 계정으로 다시 들어올 수 없어, 진행 중인 시험도
              여기서 끝납니다.
            </>
          ) : (
            <>이 계정으로는 다시 들어올 수 없습니다. 계속 둘러보려면 창을 열어 두세요.</>
          ),
          confirmLabel: "나가기",
          cancelLabel: "계속하기",
          danger: true,
        });
        if (!ok) return;
      }
      await logout(router);
    },
    [confirm, router],
  );
}

export async function logout(router: { replace: (p: string) => void }) {
  try {
    await api.post("/auth/logout");
  } finally {
    // 서버 세션은 끝났다. 이 브라우저에 남은 신분 상태도 같이 걷는다 — 화면 이동이
    // 클라이언트 라우팅이라 모듈 값은 저절로 사라지지 않는다.
    resetIdentityState();
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

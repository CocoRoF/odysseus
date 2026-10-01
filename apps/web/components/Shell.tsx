"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { User } from "@/lib/types";
import { useLogout } from "./useUser";
import { Badge } from "./ui";

/** 관리자/평가자 공통 상단 내비게이션 셸 */
export function Shell({ user, children, wide = false }: { user: User; children: React.ReactNode; wide?: boolean }) {
  const pathname = usePathname();
  const router = useRouter();
  const leave = useLogout();

  // 둘러보기 계정은 관리자와 같은 메뉴를 본다. 다른 것은 바꿀 수 없다는 것과, 응시자 화면으로
  // 넘어갈 수 없다는 것뿐이다 (서버 demo.py 가 막는다).
  const readOnly = user.role === "demo_admin";
  const adminMenu = user.role === "admin" || readOnly;

  const links = [
    ...(adminMenu
      ? [
          { href: "/admin/scenarios", label: "시나리오" },
          { href: "/admin/assessments", label: "시험" },
          { href: "/admin/office", label: "사무실" },
          { href: "/admin/users", label: "사용자" },
        ]
      : []),
    { href: "/review", label: "응시 리뷰" },
    ...(adminMenu
      ? [
          { href: "/admin/resources", label: "자원 관리" },
          { href: "/admin/settings", label: "설정" },
        ]
      : []),
  ];

  return (
    <div className="min-h-screen">
      <nav className="sticky top-0 z-40 border-b border-slate-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4">
          <div className="flex items-center gap-6">
            <Link href="/" className="font-black">
              {/* eslint-disable-next-line @next/next/no-img-element */}<img src="/brand/odysseus-icon.png" alt="" className="mr-2 inline-block h-7 w-7 rounded-lg align-[-6px]" />Odysseus<span className="text-sky-500">.</span>
            </Link>
            <div className="flex gap-1">
              {links.map((l) => (
                <Link
                  key={l.href}
                  href={l.href}
                  className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                    pathname.startsWith(l.href)
                      ? "bg-slate-900 text-white"
                      : "text-slate-600 hover:bg-slate-100"
                  }`}
                >
                  {l.label}
                </Link>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-4">
            {!readOnly && (
              <Link
                href="/dashboard"
                className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-600 transition hover:border-violet-400 hover:text-violet-600"
              >
                응시자 화면
              </Link>
            )}
            <div className="flex items-center gap-2 border-l border-slate-200 pl-4">
              <span className="text-sm font-medium text-slate-700">{user.name}</span>
              <Badge value={user.role} label={readOnly ? "둘러보기" : undefined} />
            </div>
            <button
              onClick={() => leave(user)}
              className="text-sm text-slate-400 hover:text-slate-600"
            >
              로그아웃
            </button>
          </div>
        </div>
      </nav>
      {readOnly && (
        <div className="border-b border-sky-200 bg-sky-50">
          <p className="mx-auto max-w-6xl px-4 py-2 text-[13px] text-sky-900">
            <b>둘러보기 모드</b>입니다. 관리자가 보는 화면을 그대로 볼 수 있고, 저장·삭제 같은 바꾸는 일은
            할 수 없습니다. 응시자 화면과 사무실도 열리지 않습니다. 나가거나 10분 동안 아무 동작이 없으면
            이 계정은 사라집니다.
          </p>
        </div>
      )}
      {/* 스튜디오처럼 두 칸(편집기 | 대화)을 쓰는 화면은 넓게 — 나머지는 읽기 좋은 폭을 유지 */}
      <main className={`mx-auto px-4 py-8 ${wide ? "max-w-[1720px] px-6" : "max-w-6xl"}`}>{children}</main>
    </div>
  );
}

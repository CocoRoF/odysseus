"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { User } from "@/lib/types";
import { logout } from "./useUser";
import { Badge } from "./ui";

/** 관리자/평가자 공통 상단 내비게이션 셸 */
export function Shell({ user, children }: { user: User; children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();

  const links = [
    ...(user.role === "admin"
      ? [
          { href: "/admin/scenarios", label: "시나리오" },
          { href: "/admin/assessments", label: "시험" },
          { href: "/admin/users", label: "사용자" },
        ]
      : []),
    { href: "/review", label: "응시 리뷰" },
    ...(user.role === "admin"
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
            <Link
              href="/dashboard"
              className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-600 transition hover:border-violet-400 hover:text-violet-600"
            >
              응시자 화면
            </Link>
            <div className="flex items-center gap-2 border-l border-slate-200 pl-4">
              <span className="text-sm font-medium text-slate-700">{user.name}</span>
              <Badge value={user.role} />
            </div>
            <button
              onClick={() => logout(router)}
              className="text-sm text-slate-400 hover:text-slate-600"
            >
              로그아웃
            </button>
          </div>
        </div>
      </nav>
      <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
    </div>
  );
}

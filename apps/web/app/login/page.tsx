"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, ApiError } from "@/lib/api";
import type { User } from "@/lib/types";
import { homeFor } from "@/components/useUser";
import { Button, inputCls } from "@/components/ui";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // null = 아직 확인 전. 게스트 접속이 꺼져 있으면 버튼 자리도 만들지 않는다 —
  // 눌러야 비로소 "비활성화되어 있습니다" 를 보는 버튼은 없느니만 못하다.
  const [guestOn, setGuestOn] = useState<boolean | null>(null);
  const router = useRouter();

  useEffect(() => {
    api
      .get<{ enabled: boolean }>("/auth/guest")
      .then((r) => setGuestOn(r.enabled))
      .catch(() => setGuestOn(false));
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const user = await api.post<User>("/auth/login", { email, password });
      router.replace(homeFor(user.role));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "로그인에 실패했습니다");
      setBusy(false);
    }
  };

  const startGuest = async () => {
    setBusy(true);
    setError("");
    try {
      const user = await api.post<User>("/auth/guest", { name: "" });
      router.replace(homeFor(user.role));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "게스트로 시작할 수 없습니다");
      setBusy(false);
    }
  };

  return (
    <div className="desktop-wallpaper flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-black tracking-tight text-white">
            {/* eslint-disable-next-line @next/next/no-img-element */}<img src="/brand/odysseus-icon.png" alt="" className="mr-2 inline-block h-7 w-7 rounded-lg align-[-6px]" />Odysseus<span className="text-sky-400">.</span>
          </h1>
          <p className="mt-2 text-sm text-slate-400">실무 시뮬레이션 기반 개발자 평가 플랫폼</p>
        </div>
        <form onSubmit={submit} className="space-y-4 rounded-2xl bg-white p-6 shadow-xl">
          <input
            className={inputCls}
            type="email"
            placeholder="이메일"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoFocus
          />
          <input
            className={inputCls}
            type="password"
            placeholder="비밀번호"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          {error && <p className="text-sm text-red-600">{error}</p>}
          <Button type="submit" disabled={busy} className="w-full">
            {busy ? "로그인 중..." : "로그인"}
          </Button>

          {guestOn && (
            <div className="border-t border-slate-100 pt-4">
              <button
                type="button"
                onClick={startGuest}
                disabled={busy}
                className="w-full rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-600 transition hover:border-amber-400 hover:text-amber-700 disabled:opacity-50"
              >
                게스트로 둘러보기
              </button>
              <p className="mt-2 text-center text-xs text-slate-400">
                계정 없이 바로 응시할 수 있어요. 로그아웃하면 다시 들어올 수 없습니다.
              </p>
            </div>
          )}
        </form>
      </div>
    </div>
  );
}

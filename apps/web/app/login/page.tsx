"use client";

import { useState } from "react";
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
  const router = useRouter();

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

  return (
    <div className="desktop-wallpaper flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-black tracking-tight text-white">
            Odysseus<span className="text-sky-400">.</span>
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
        </form>
        <p className="mt-4 text-center text-xs text-slate-500">
          데모: admin@odysseus.dev / admin1234 · candidate@odysseus.dev / cand1234
        </p>
      </div>
    </div>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { api, ApiError, resetIdentityState } from "@/lib/api";
import type { Resume, User } from "@/lib/types";
import { homeFor } from "@/components/useUser";
import { Button, inputCls } from "@/components/ui";
import { PvButton } from "@/components/PvModal";

/** 마감까지 남은 시간을 한 마디로 — 이어할지 정하는 데 필요한 건 이것뿐이다 */
function remainingText(deadline: string): string {
  const left = new Date(deadline).getTime() - Date.now();
  if (!Number.isFinite(left) || left <= 0) return "시간 종료";
  const min = Math.round(left / 60000);
  if (min < 60) return `${min}분 남음`;
  return `${Math.floor(min / 60)}시간 ${min % 60}분 남음`;
}

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  /** 이 브라우저가 이어 할 것 (api: /auth/resume) */
  const [resume, setResume] = useState<Resume | null>(null);
  const router = useRouter();

  useEffect(() => {
    // 로그인 화면은 "아직 아무도 아니다" 는 자리다. 앞서 누구였든 남은 상태를 여기서 걷는다 —
    // 로그아웃을 거치지 않고 들어오는 길(만료 뒤 되돌림·주소 직접 입력)도 있다.
    resetIdentityState();
    // 이어 할 것이 있는지 묻는다. 없으면 빈 값이 오므로 오류가 아니다.
    api
      .get<Resume>("/auth/resume")
      .then((r) => setResume(r.role ? r : null))
      .catch(() => setResume(null));
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    // 비어 있을 때의 안내를 브라우저에 맡기지 않는다. 네이티브 말풍선은 브라우저 언어를 따라
    // "Please fill out this field." 처럼 영어로 뜨고, 이 화면의 다른 오류 표시와 모양도 다르다.
    if (!email.trim() || !password) {
      setError(
        !email.trim() && !password
          ? "이메일과 비밀번호를 입력하세요"
          : !email.trim()
            ? "이메일을 입력하세요"
            : "비밀번호를 입력하세요",
      );
      (!email.trim() ? emailRef : passwordRef).current?.focus();
      return;
    }
    // 형식도 여기서 본다 — required 를 뗀 만큼 브라우저가 걸러 주던 것을 우리 문구로 대신한다.
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setError("이메일 주소를 다시 확인해 주세요");
      emailRef.current?.focus();
      return;
    }
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
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-black tracking-tight text-white">
            {/* eslint-disable-next-line @next/next/no-img-element */}<img src="/brand/odysseus-icon.png" alt="" className="mr-2 inline-block h-7 w-7 rounded-lg align-[-6px]" />Odysseus<span className="text-sky-400">.</span>
          </h1>
          <p className="mt-2 text-sm text-slate-400">실무 시뮬레이션 기반 개발자 평가 플랫폼</p>
          <div className="mt-4">
            <PvButton />
          </div>
        </div>
        <form onSubmit={submit} noValidate className="space-y-4 rounded-2xl bg-white p-6 shadow-xl">
          <input
            ref={emailRef}
            className={inputCls}
            type="email"
            placeholder="이메일"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              if (error) setError("");
            }}
            autoFocus
          />
          <input
            ref={passwordRef}
            className={inputCls}
            type="password"
            placeholder="비밀번호"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              if (error) setError("");
            }}
          />
          {error && <p className="text-sm text-red-600">{error}</p>}
          <Button type="submit" disabled={busy} className="w-full">
            {busy ? "로그인 중..." : "로그인"}
          </Button>

          {resume && (
            <div className="space-y-2 rounded-lg border border-amber-300 bg-amber-50/60 p-3">
              <p className="text-sm font-medium text-amber-900">
                {resume.attempt_id ? "진행 중인 시험이 있습니다" : `${resume.name}님으로 들어와 있습니다`}
              </p>
              {resume.attempt_id && (
                <p className="text-xs text-amber-800">
                  {resume.assessment_title}
                  {resume.deadline_at && ` · ${remainingText(resume.deadline_at)}`}
                </p>
              )}
              <Button
                type="button"
                className="w-full"
                onClick={() => router.replace(resume.attempt_id ? `/exam/${resume.attempt_id}` : resume.home)}
              >
                {resume.attempt_id ? "이어서 응시하기" : "하던 화면으로"}
              </Button>
            </div>
          )}
        </form>
      </div>
    </div>
  );
}

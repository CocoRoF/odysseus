"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { api, ApiError, resetIdentityState } from "@/lib/api";
import type { GuestAvailability, Resume, User } from "@/lib/types";
import { homeFor } from "@/components/useUser";
import { Button, inputCls } from "@/components/ui";
import { useToast } from "@/components/toast";
import { LogoSplash, markArrival } from "@/components/LogoSplash";

/** 로고가 다 떠오른 뒤에 페이지를 바꾼다. 사무실 쪽 막은 이 끝 모습에서 이어받는다. */
const GUEST_ENTER_MS = 900;

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
  // null = 아직 확인 전. 게스트 접속이 꺼져 있으면 버튼 자리도 만들지 않는다 —
  // 눌러야 비로소 "비활성화되어 있습니다" 를 보는 버튼은 없느니만 못하다.
  const [guestOn, setGuestOn] = useState<boolean | null>(null);
  /** 관리 화면 둘러보기(읽기 전용) 를 열어 두었는가 — 게스트 응시와 별개 스위치다 */
  const [demoOn, setDemoOn] = useState(false);
  /** 게스트 로그인이 끝나 로고 막이 떠오르는 중 */
  const [arriving, setArriving] = useState(false);
  /** 이 브라우저가 이어 할 것 — 손님 계정은 나가면 끝이라, 새로 시작보다 먼저 내놓는다 */
  const [resume, setResume] = useState<Resume | null>(null);
  const router = useRouter();
  const { confirm } = useToast();
  /** 진행 중인 시험을 버리고 새로 시작한다고 확인받았는가 — 온보딩 끝의 계정 생성까지 실어 나른다 */
  const replaceRef = useRef(false);

  useEffect(() => {
    // 로그인 화면은 "아직 아무도 아니다" 는 자리다. 앞서 누구였든 남은 상태를 여기서 걷는다 —
    // 로그아웃을 거치지 않고 들어오는 길(만료 뒤 되돌림·주소 직접 입력)도 있다.
    resetIdentityState();
    api
      .get<GuestAvailability>("/auth/guest")
      .then((r) => {
        setGuestOn(r.enabled);
        setDemoOn(Boolean(r.admin_demo));
        if (r.admin_demo) router.prefetch("/admin/scenarios");
        // 게스트는 로고 막 뒤에서 온보딩으로 간다 — 미리 받아 두면 막이 걷힐 때 이미 떠 있다.
        if (r.enabled) {
          router.prefetch("/welcome");
          router.prefetch("/office");
        }
      })
      .catch(() => setGuestOn(false));
    // 이어 할 것이 있는지는 따로 묻는다. 없으면 빈 값이 오므로 오류가 아니다.
    api
      .get<Resume>("/auth/resume")
      .then((r) => setResume(r.role ? r : null))
      .catch(() => setResume(null));
  }, [router]);

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

  /** 게스트 — 계정은 아직 만들지 않는다. 시험을 시작할 때처럼 검은 막에 로고가 떠오르고,
   *  그 뒤에서 온보딩(이름 → 아바타 → 분야)이 준비된다. 계정은 온보딩 끝에 만든다 —
   *  고르다 나간 사람의 빈 계정이 남지 않는다. */
  const startGuest = async () => {
    // 진행 중인 시험이 있으면 버리는 것이 된다 — 게스트는 나가면 그 계정으로 다시 못 들어온다.
    if (resume?.attempt_id) {
      const ok = await confirm({
        title: "지금 시험을 버리고 새로 시작할까요?",
        message: (
          <>
            <b>{resume.assessment_title}</b> 을(를) 치르는 중입니다. 새 게스트로 시작하면 지금 계정으로는
            다시 들어올 수 없어, 지금까지의 응시가 여기서 끝납니다.
          </>
        ),
        confirmLabel: "버리고 새로 시작",
        cancelLabel: "이어서 응시",
        danger: true,
      });
      if (!ok) {
        router.replace(`/exam/${resume.attempt_id}`);
        return;
      }
      replaceRef.current = true;
    }
    setBusy(true);
    setError("");
    // replace = 진행 중인 시험을 버리겠다고 확인받음. fresh = 이미 들어와 있지만(끝난 시험 등) 새 게스트로
    // 시작하려 함. 둘 다 없으면 /welcome 은 들어와 있는 사람을 사무실로 돌려보낸다.
    const q = markArrival("guest") + (replaceRef.current ? "&replace=1" : resume?.role ? "&fresh=1" : "");
    setArriving(true);
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    setTimeout(() => router.replace(`/welcome${q}`), reduced ? 0 : GUEST_ENTER_MS);
  };

  /** 관리 화면 둘러보기 — 계정을 만들고 바로 관리 화면으로. 여기서 만드는 계정은 읽기만 한다.
   *  게스트와 달리 온보딩(이름·아바타·분야)이 없다 — 사무실에 서지 않기 때문이다. */
  const startDemoAdmin = async () => {
    setBusy(true);
    setError("");
    try {
      const user = await api.post<User>("/auth/guest/admin", {});
      router.replace(homeFor(user.role));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "둘러보기를 시작하지 못했습니다");
      setBusy(false);
    }
  };

  return (
    <div className="desktop-wallpaper flex min-h-screen items-center justify-center p-4">
      {arriving && <LogoSplash mode="enter" label="사무실로 이동합니다" />}
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-black tracking-tight text-white">
            {/* eslint-disable-next-line @next/next/no-img-element */}<img src="/brand/odysseus-icon.png" alt="" className="mr-2 inline-block h-7 w-7 rounded-lg align-[-6px]" />Odysseus<span className="text-sky-400">.</span>
          </h1>
          <p className="mt-2 text-sm text-slate-400">실무 시뮬레이션 기반 개발자 평가 플랫폼</p>
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

          {(guestOn || demoOn) && (
            <div className="space-y-3 border-t border-slate-100 pt-4">
              {/* 계정 없이 들어오는 두 길 — 무엇이 다른지 한 줄로 말해 준다 */}
              <p className="text-center text-xs font-medium text-slate-400">
                {resume ? "새로 시작" : "계정 없이 둘러보기"}
              </p>
              {guestOn && (
                <button
                  type="button"
                  onClick={startGuest}
                  disabled={busy}
                  className="flex w-full items-baseline justify-between gap-3 rounded-lg border border-slate-300 px-4 py-2.5 text-left transition hover:border-amber-400 hover:bg-amber-50/40 disabled:opacity-50"
                >
                  <span className="text-sm font-medium text-slate-700">게스트로 응시</span>
                  <span className="text-xs text-slate-400">시험을 직접 풀어 봅니다</span>
                </button>
              )}
              {demoOn && (
                <button
                  type="button"
                  onClick={startDemoAdmin}
                  disabled={busy}
                  className="flex w-full items-baseline justify-between gap-3 rounded-lg border border-slate-300 px-4 py-2.5 text-left transition hover:border-sky-400 hover:bg-sky-50/40 disabled:opacity-50"
                >
                  <span className="text-sm font-medium text-slate-700">관리자 기능 살펴보기</span>
                  <span className="text-xs text-slate-400">관리 화면을 보기만 합니다</span>
                </button>
              )}
              <p className="text-center text-[11px] leading-relaxed text-slate-400">
                로그아웃하면 그 계정으로 다시 들어올 수 없습니다.
              </p>
            </div>
          )}
        </form>
      </div>
    </div>
  );
}

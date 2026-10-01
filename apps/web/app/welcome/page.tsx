"use client";

/** 게스트 온보딩 — 검은 바탕에서 캐릭터를 만들듯이.
 *
 *  로그인에서 로고 막을 두르고 건너오면, 로고가 가라앉은 자리에 세 질문이 차례로 뜬다:
 *   1. 당신의 이름은 무엇인가요?
 *   2. 당신의 아바타를 선택해주세요       (프리셋 중 하나)
 *   3. 수행할 임무를 선택해주세요          (분야별로 묶인 시험 목록에서 **하나**)
 *
 *  계정은 **마지막에** 만든다. 세 답을 한 번에 보내고(POST /auth/guest), 서버가 고른 시험
 *  하나를 배정하므로 게스트의 사무실에는 그 방 하나만 선다 — 화면이 필터하는 게 아니라 서버가
 *  그 밖의 것을 아예 주지 않는다. 고르다 나간 사람의 빈 계정은 남지 않는다.
 *
 *  로그인 전 화면이라 useUser 를 쓰지 않는다. 게스트가 꺼져 있으면 로그인으로 돌려보낸다.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { IconChevronLeft } from "@/components/icons";
import { useRouter } from "next/navigation";
import { api, ApiError } from "@/lib/api";
import type { GuestAvailability, User } from "@/lib/types";
import { PEOPLE } from "@/lib/people";
import { pickAvatarChoices } from "@/lib/avatar-choices";
import { LogoSplash, markArrival, takeArrival } from "@/components/LogoSplash";

const NAME_MAX = 20;
const DIFFICULTY_SHORT: Record<string, string> = { easy: "입문", medium: "중급", hard: "심화" };
/** 로고가 최소한 이만큼은 서 있는다 — 로그인에서 떠오른 로고를 이어받는 시간이다 */
const LOGO_HOLD_MS = 1100;

type Step = 0 | 1 | 2;

export default function WelcomePage() {
  const router = useRouter();
  const [splash, setSplash] = useState<"hold" | "leave" | null>(null);
  const arrivedAt = useRef(0);
  const [avail, setAvail] = useState<GuestAvailability | null>(null);
  const [step, setStep] = useState<Step>(0);
  const [name, setName] = useState("");
  const [preset, setPreset] = useState<string>("");
  /** 선택창의 후보 — 여성 6 · 남성 6 을 들어올 때 **한 번** 무작위로 뽑는다(다시 그릴 때마다 바뀌면 고를 수 없다).
   *  프리셋 전체는 시나리오 속 인물이 쓴다. 이 단계는 첫 화면(이름) 뒤에만 그려지므로 서버 렌더와 어긋날 일이 없다. */
  const [choices] = useState(() => pickAvatarChoices(PEOPLE));
  /** 고른 시험 하나(assessment id). 시험 하나가 시나리오 하나이고 방 하나다. */
  const [exam, setExam] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const nameRef = useRef<HTMLInputElement | null>(null);

  // 로그인에서 로고 막을 두르고 왔으면 그 막을 이어받는다 (첫 페인트 전에).
  /** 로그인 화면이 실어 보낸 뜻 — replace: 진행 중 시험을 버리겠다고 확인함, fresh: 들어와 있지만 새로 시작.
   *  takeArrival 이 주소의 쿼리를 통째로 지우므로, 그 전에 붙잡아 둔다. 예전에는 온보딩 끝(finish)에서
   *  주소를 다시 읽었는데 그때는 이미 지워진 뒤라 replace 가 늘 false 였다 — "버리고 새로 시작" 을
   *  확인한 사람이 온보딩 끝에서 409 로 막혔다. */
  const intent = useRef({ replace: false, fresh: false });
  useLayoutEffect(() => {
    const q = new URLSearchParams(window.location.search);
    intent.current = { replace: q.get("replace") === "1", fresh: q.get("fresh") === "1" };
    if (takeArrival() === "guest") {
      arrivedAt.current = performance.now();
      setSplash("hold");
    }
  }, []);

  useEffect(() => {
    // 이미 들어와 있는 사람에게 온보딩을 다시 보여 주면, 끝까지 가는 순간 **새 게스트 계정**이 생기고
    // 지금 계정은 버려진다. 로그인 화면이 "새로 시작" 이라고 적어 보낸 경우(fresh·replace)만 그것이
    // 뜻한 바다. 주소를 직접 쳐서 온 사람은 자기 자리(사무실)로 돌려보낸다.
    const meantToRestart = intent.current.replace || intent.current.fresh;
    api
      .get<{ name: string; role: string; home: string }>("/auth/resume")
      .then((me) => {
        if (me.role && !meantToRestart) router.replace(me.home || "/office");
      })
      .catch(() => undefined);
    api
      .get<GuestAvailability>("/auth/guest")
      .then((r) => {
        if (!r.enabled) {
          router.replace("/login");
          return;
        }
        setAvail(r);
      })
      .catch(() => router.replace("/login"));
    router.prefetch("/office");
  }, [router]);

  // 분야 목록이 오면(온보딩이 준비되면) 로고가 가라앉는다.
  useEffect(() => {
    if (splash !== "hold" || !avail) return;
    const wait = Math.max(0, LOGO_HOLD_MS - (performance.now() - arrivedAt.current));
    const t = setTimeout(() => setSplash("leave"), wait);
    return () => clearTimeout(t);
  }, [splash, avail]);

  useEffect(() => {
    if (step === 0 && splash === null) nameRef.current?.focus();
  }, [step, splash]);

  const categories = useMemo(() => avail?.categories ?? [], [avail]);
  const canNext = step === 0 ? name.trim().length > 0 : step === 1 ? Boolean(preset) : exam !== null;

  const finish = useCallback(async () => {
    if (exam === null || !preset || !name.trim()) return;
    setBusy(true);
    setError("");
    try {
      // 로그인 화면에서 "지금 시험을 버린다" 를 확인받았을 때만 replace 를 싣는다.
      // 서버는 그 확인 없이는 진행 중인 응시를 가진 브라우저에 새 계정을 내주지 않는다.
      await api.post<User>("/auth/guest", {
        name: name.trim(),
        avatar_preset: preset,
        assessment_id: exam,
        replace: intent.current.replace,
      });
      // 이미 검은 화면이다 — 로고 없이 검은 막만 두르고 사무실이 그 아래에서 준비된다.
      router.replace(`/office${markArrival("welcome")}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "시작할 수 없습니다");
      setBusy(false);
    }
  }, [exam, preset, name, router]);

  const next = useCallback(() => {
    if (!canNext || busy) return;
    if (step < 2) setStep((s) => (s + 1) as Step);
    else void finish();
  }, [canNext, busy, step, finish]);

  // Enter 로 다음 — 이름 칸에서도, 고른 뒤에도
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || e.isComposing) return;
      e.preventDefault();
      next();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [next]);

  const question =
    step === 0 ? "당신의 이름은 무엇인가요?" : step === 1 ? "당신의 아바타를 선택해주세요" : "수행할 임무를 선택해주세요";

  return (
    <div className="welcome" data-step={step}>
      {splash && <LogoSplash mode={splash} label="게스트 시작" onDone={() => setSplash(null)} />}
      <div className="welcome-vignette" />
      <div className="welcome-panel" aria-busy={busy}>
        <p className="welcome-brand">ODYSSEUS</p>
        <div className="welcome-steps" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <i key={i} data-on={i <= step ? "true" : undefined} />
          ))}
        </div>
        <h1 className="welcome-q" key={`q${step}`}>
          {question}
        </h1>
        <div className="welcome-rule" />

        <div className="welcome-body welcome-step" key={`s${step}`}>
          {step === 0 && (
            <label>
              <span className="sr-only">이름</span>
              <input
                ref={nameRef}
                type="text"
                value={name}
                maxLength={NAME_MAX}
                autoComplete="off"
                placeholder="이름을 입력하세요"
                onChange={(e) => setName(e.target.value)}
                data-welcome="name"
              />
            </label>
          )}

          {step === 1 && (
            <div className="welcome-avatar-step">
              {/* 얼굴로 고른다. 사무실에서 걷는 도트 모습은 보여 주지 않는다 — 초상과 그림체가 달라
                  같은 사람으로 읽히지 않고, 고르는 일에 보태 주는 것도 없다. */}
              <div className="welcome-portraits" role="group" aria-label="아바타 고르기">
                {choices.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className="welcome-portrait"
                    aria-pressed={preset === p.id}
                    onClick={() => setPreset(p.id)}
                    data-preset={p.id}
                    title={p.name}
                  >
                    {p.bust ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={p.bust} alt="" draggable={false} />
                    ) : (
                      <span className="welcome-portrait-blank" />
                    )}
                    <span className="welcome-portrait-name">{p.name}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="welcome-list" role="group" aria-label="임무 고르기">
              {/* 분야 이름이 구분선처럼 서고, 그 아래 그 분야의 시험이 가로로 긴 카드로 한 줄씩 선다.
                  카드 하나가 시험 하나 — 고르면 사무실에 그 방 하나만 선다. */}
              {categories.map((c) => (
                <section key={c.key || "__none"} className="welcome-section" data-category={c.key}>
                  <h2>
                    <span>{c.label}</span>
                    <i aria-hidden="true" />
                    <small>{c.count}</small>
                  </h2>
                  {c.exams.map((e) => (
                    <button
                      key={e.assessment_id}
                      type="button"
                      className="welcome-exam"
                      aria-pressed={exam === e.assessment_id}
                      onClick={() => setExam(e.assessment_id)}
                      data-exam={e.assessment_id}
                      data-difficulty={e.difficulty}
                    >
                      <span className="welcome-exam-label">{e.label || "기본"}</span>
                      <span className="welcome-exam-text">
                        <b>{e.title}</b>
                        {e.pitch && <small>{e.pitch}</small>}
                      </span>
                      <span className="welcome-exam-meta">
                        <em>{DIFFICULTY_SHORT[e.difficulty] ?? e.difficulty}</em>
                        {e.duration_min}분
                      </span>
                    </button>
                  ))}
                </section>
              ))}
              {avail && categories.length === 0 && <p className="welcome-empty">열려 있는 시험이 없습니다.</p>}
            </div>
          )}
        </div>

        {error && <p className="welcome-error">{error}</p>}

        <div className="welcome-actions">
          {step > 0 ? (
            <button type="button" className="welcome-back" onClick={() => setStep((s) => (s - 1) as Step)} disabled={busy}>
              <IconChevronLeft size={13} /> 이전
            </button>
          ) : (
            <button type="button" className="welcome-back" onClick={() => router.replace("/login")} disabled={busy}>
              <IconChevronLeft size={13} /> 로그인으로
            </button>
          )}
          <button type="button" className="welcome-next" onClick={next} disabled={!canNext || busy} data-welcome="next">
            {busy ? "준비 중..." : step < 2 ? "다음" : "출근하기"}
          </button>
        </div>
      </div>
    </div>
  );
}

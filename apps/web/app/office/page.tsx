"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api, ApiError } from "@/lib/api";
import type { Attempt, MyAssignment } from "@/lib/types";
import { useUser, useLogout } from "@/components/useUser";
import { useToast } from "@/components/toast";
import { Spinner } from "@/components/ui";
import { LogoSplash, takeArrival, type ArriveKind } from "@/components/LogoSplash";
import { CategoryFilter, readCategoryFilter, writeCategoryFilter } from "@/components/CategoryFilter";
import { categoryLabel } from "@/lib/categories";
import { rowFor } from "@/lib/avatars";
import { OfficeStage } from "@/components/office/OfficeStage";
import { Commute } from "@/components/office/Commute";
import { startLite } from "@/lib/render-power";
import { readBuiltinOverrides, type BuiltinOverrides } from "@/components/office/builtin-scenes";

/** 로고 막이 최소한 이만큼은 서 있는다 — 데이터가 빨리 와도 로고가 스치듯 지나가면
 *  전환이 아니라 깜빡임으로 보인다. */
const ARRIVAL_HOLD_MS = 1100;
/** 출근길은 한 세션에 한 번. 새로고침마다 다시 걷지 않는다. `?arrive=office` 로 다시 본다 */
const COMMUTE_KEY = "odysseus:commuted";
const ARRIVED_TEXT = "사무실에 출근했습니다. 방향키로 움직이고, 노트북이 놓인 스탠딩 데스크 앞에 서면 시험이 시작됩니다.";

export default function OfficePage() {
  const { user, loading } = useUser(["candidate", "admin", "evaluator", "guest"]);
  const [assignments, setAssignments] = useState<MyAssignment[] | null>(null);
  /** 관리자가 고친 템플릿 — 방의 모양만 담긴다 */
  const [builtins, setBuiltins] = useState<BuiltinOverrides>({});
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  /** 로그인에서 로고 막을 두르고 건너온 경우 — 사무실이 준비될 때까지 막을 잡고 있다가 걷는다. */
  const [arrival, setArrival] = useState<"hold" | "leave" | null>(null);
  const arrivalKind = useRef<ArriveKind | null>(null);
  /** 고른 분야. null = 전체. 층은 고른 분야의 방만으로 다시 지어진다. */
  const [category, setCategory] = useState<string | null>(null);
  const arrivedAt = useRef(0);
  /** 출근길. walk = 복도를 걷는 중, enter = 빛이 걷히며 사무실이 켜지는 중 */
  const [commute, setCommute] = useState<"walk" | "enter" | null>(null);
  /** 층이 문 앞의 어둠에서 시작한다. 걸어 나오는 연출이 끝나면 꺼진다 */
  const [entranceMode, setEntranceMode] = useState(false);
  const [entranceGo, setEntranceGo] = useState(false);
  const { toast } = useToast();
  const router = useRouter();
  const leave = useLogout();
  /** 지금 치르는 중인 시험이 있는가 — 나가기 확인창의 말이 달라진다 */
  const hasRunningExam = (assignments ?? []).some((a) => a.attempt_status === "in_progress");

  const isStaff = user?.role === "admin" || user?.role === "evaluator";

  // 첫 페인트 전에 막을 세운다 — useEffect 로 하면 스피너가 한 프레임 비친다.
  // 처음 출근이면 출근길을 걷는다. 움직임을 줄인 사람에게는 예전의 검은 막이다.
  useLayoutEffect(() => {
    const kind = takeArrival();
    // 움직임을 줄인 사람과 그리기 여력이 없는 브라우저(GPU 가속 꺼짐 — 복도 연출은 프레임마다 화면 전부를 CPU 로 칠한다)는 검은 막
    const reduced = Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) || startLite();
    let commuted = false;
    try {
      commuted = sessionStorage.getItem(COMMUTE_KEY) === "1";
    } catch {
      // 저장소를 못 읽어도 출근은 한 번 한다
    }
    if (!reduced && (kind || !commuted)) {
      try {
        sessionStorage.setItem(COMMUTE_KEY, "1");
      } catch {
        // 기억하지 못하면 다음 방문에 또 걷는다
      }
      setCommute("walk");
      setEntranceMode(true);
      return;
    }
    if (!kind) return;
    arrivalKind.current = kind;
    arrivedAt.current = performance.now();
    setArrival("hold");
  }, []);

  useEffect(() => {
    if (!user) return;
    // 방 하나가 시험 하나다 — 목록이 곧 층이다.
    // 관리자가 고친 템플릿도 함께 받아 층을 한 번에 짓는다(방 모양이 바뀌며 깜빡이지 않게). 못 받으면 코드의 기본값으로 선다.
    Promise.all([
      api.get<MyAssignment[]>("/my/assignments"),
      api.get<Record<string, unknown>>("/my/office/builtins").catch(() => ({})),
    ])
      .then(([rows, raw]) => {
        setBuiltins(readBuiltinOverrides(raw));
        setAssignments(rows);
      })
      .catch((e) => setError(String(e.message)));
  }, [user]);

  // 사무실이 준비되면(또는 실패하면 — 검은 막 아래 오류를 가두지 않는다) 막을 걷는다.
  useEffect(() => {
    if (arrival !== "hold") return;
    const ready = assignments || error;
    if (!ready) return;
    // 온보딩에서 건너온 검은 막은 로고가 없으니 오래 잡아 둘 이유가 없다
    const hold = arrivalKind.current === "welcome" ? 350 : ARRIVAL_HOLD_MS;
    const wait = Math.max(0, hold - (performance.now() - arrivedAt.current));
    const t = setTimeout(() => {
      setArrival("leave");
      setAnnouncement("사무실에 출근했습니다. 방향키로 움직이고, 노트북이 놓인 스탠딩 데스크 앞에 서면 시험이 시작됩니다.");
    }, wait);
    return () => clearTimeout(t);
  }, [arrival, assignments, error]);

  const endArrival = useCallback(() => setArrival(null), []);

  /** 빛이 화면을 다 덮었다. 그 아래에서 층이 걸어 나오기 시작한다 */
  const enterOffice = useCallback(() => {
    setEntranceGo(true);
    setCommute("enter");
  }, []);
  const endCommute = useCallback(() => setCommute(null), []);
  const endEntrance = useCallback(() => {
    setEntranceMode(false);
    setEntranceGo(false);
    setAnnouncement(ARRIVED_TEXT);
  }, []);

  useEffect(() => setCategory(readCategoryFilter()), []);
  const pickCategory = useCallback((next: string | null) => {
    setCategory(next);
    writeCategoryFilter(next);
  }, []);
  const visible = useMemo(
    () => (assignments ?? []).filter((a) => category === null || (a.category ?? "") === category),
    [assignments, category],
  );

  // 층이 서지 않으면(시험이 없거나 실패) 이어받을 연출이 없다
  useEffect(() => {
    if (entranceMode && commute === null && (error || (assignments && visible.length === 0))) endEntrance();
  }, [entranceMode, commute, error, assignments, visible, endEntrance]);

  /**
   * 자리에 앉는다 = 응시를 시작한다.
   *
   * `/dashboard` 의 시작 동작과 **같은 요청, 같은 이동**이다. 사무실은 시험을 고르는
   * 또 다른 방법일 뿐이고, 여기서부터 앞은 지금까지의 시험장 그대로다.
   */
  const start = useCallback(
    async (assignment: MyAssignment) => {
      if (assignment.attempt_status === "in_progress" && assignment.attempt_id) {
        router.push(`/exam/${assignment.attempt_id}`);
        return;
      }
      // 끝난 자리는 결과로 간다 — 결과 화면을 벗어난 게스트가 점수를 다시 볼 수 있는 유일한 길이다.
      if (assignment.attempt_status && assignment.attempt_id) {
        router.push(`/result/${assignment.attempt_id}`);
        return;
      }
      setBusyId(assignment.assessment_id);
      try {
        const attempt = await api.post<Attempt>(`/assessments/${assignment.assessment_id}/attempts`);
        router.push(`/exam/${attempt.id}`);
      } catch (e) {
        toast(e instanceof ApiError ? e.message : "시작할 수 없습니다", "error");
        setBusyId(null);
      }
    },
    [router, toast],
  );

  const splash = arrival && (
    <LogoSplash mode={arrival} label="사무실로 이동합니다" onDone={endArrival} logo={arrivalKind.current !== "welcome"} />
  );
  const walk = commute && (
    <Commute
      name={user?.name ?? ""}
      row={user ? rowFor({ key: user.id ?? user.name ?? "odysseus", avatar_preset: user.avatar_preset ?? "" }) : null}
      ready={Boolean(user) && (assignments !== null || Boolean(error))}
      onEnter={enterOffice}
      onGone={endCommute}
    />
  );

  if (loading || !user) {
    return (
      <>
        {walk}
        {splash}
        <Spinner label="불러오는 중..." />
      </>
    );
  }

  return (
    <div className="office-page">
      {walk}
      {splash}

      <header className="office-header">
        <div className="min-w-0">
          <h1 className="text-lg font-black text-slate-100">
            Odysseus<span className="text-sky-400">.</span>
          </h1>
          <p className="mt-0.5 truncate text-xs text-slate-400">
            {user.name}님, 첫 출근입니다. 맡을 방으로 가서 노트북이 놓인 스탠딩 데스크 앞에 서면 그 일이 시작됩니다.
          </p>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2">
          <Link href="/dashboard" className="office-linkbtn">
            기본 화면
          </Link>
          {isStaff && (
            <Link href={user.role === "admin" ? "/admin/scenarios" : "/review"} className="office-linkbtn">
              관리자 콘솔
            </Link>
          )}
          <button type="button" className="office-ghostbtn" onClick={() => leave(user, { examInProgress: hasRunningExam })}>
            로그아웃
          </button>
        </div>
      </header>

      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>

      {assignments && assignments.length > 1 && (
        <div className="office-filterbar">
          <CategoryFilter items={assignments} value={category} onChange={pickCategory} tone="dark" />
        </div>
      )}

      <main id="office-content" className="office-main">
        {error && <p className="office-error">{error}</p>}
        {!assignments ? (
          <Spinner />
        ) : assignments.length === 0 ? (
          <p className="office-empty">
            지금 배정된 시험이 없습니다. 사무실은 열려 있지만, 오늘 당신이 맡을 일은 아직 없습니다.
          </p>
        ) : visible.length === 0 ? (
          <p className="office-empty">{categoryLabel(category)} 분야의 시험이 없습니다. 위에서 다른 분야를 고르세요.</p>
        ) : (
          <OfficeStage
            builtins={builtins}
            assignments={visible}
            seed={user.id ?? user.name ?? "odysseus"}
            avatarPreset={user.avatar_preset ?? ""}
            myName={user.name}
            busyId={busyId}
            onStart={start}
            onAnnounce={setAnnouncement}
            entrance={entranceMode ? { go: entranceGo, onDone: endEntrance } : null}
          />
        )}
      </main>

      <footer className="office-footer">
        <span>
          아바타는 계정에서 자동으로 만들어지며 <b>평가에 쓰이지 않습니다.</b> 걷는 연출도 채점과 무관합니다 —
          기본 화면에서 시작해도 결과는 똑같습니다.
        </span>
      </footer>
    </div>
  );
}

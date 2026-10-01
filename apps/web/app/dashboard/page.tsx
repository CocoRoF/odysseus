"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api, ApiError } from "@/lib/api";
import type { Attempt, MyAssignment } from "@/lib/types";
import { fmtDateTime, STATUS_LABEL } from "@/lib/format";
import { useUser, useLogout } from "@/components/useUser";
import { useToast } from "@/components/toast";
import { Badge, Button, Card, EmptyState, Spinner } from "@/components/ui";
import { CategoryFilter, readCategoryFilter, writeCategoryFilter } from "@/components/CategoryFilter";
import { categoryLabel } from "@/lib/categories";
import { DIFFICULTY_LABEL } from "@/lib/format";

export default function DashboardPage() {
  const { user, loading } = useUser(["candidate", "admin", "evaluator", "guest"]);
  const [assignments, setAssignments] = useState<MyAssignment[] | null>(null);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  /** 고른 분야. null = 전체. 사무실과 같은 저장소를 써서 화면을 오가도 유지된다. */
  const [category, setCategory] = useState<string | null>(null);
  const { toast, confirm } = useToast();
  const router = useRouter();
  const leave = useLogout();

  const isStaff = user?.role === "admin" || user?.role === "evaluator";
  const isGuest = user?.role === "guest";

  const load = useCallback(() => {
    api.get<MyAssignment[]>("/my/assignments").then(setAssignments).catch((e) => setError(String(e.message)));
  }, []);

  useEffect(() => {
    if (user) load();
  }, [user, load]);
  useEffect(() => setCategory(readCategoryFilter()), []);
  const pickCategory = (next: string | null) => {
    setCategory(next);
    writeCategoryFilter(next);
  };
  const visible = useMemo(
    () => (assignments ?? []).filter((a) => category === null || (a.category ?? "") === category),
    [assignments, category],
  );

  /** 응시 시작 — 되돌릴 수 없으므로 한 번 묻는다.
   *
   *  카드가 여럿이고 버튼 이름이 모두 "응시 시작" 이라, 한 번의 오클릭으로 엉뚱한 시험이
   *  시작된다. 시작하면 제한시간이 흐르기 시작하고 도중에 그만둘 수도, 다시 응시할 수도
   *  없다. 사무실 동선에는 이미 확정 단계(자리 앞 Enter)가 있는데 여기만 없었다. */
  const start = async (a: MyAssignment) => {
    const ok = await confirm({
      title: `‘${a.title}’ 응시를 시작할까요?`,
      message: (
        <>
          시작하면 <b className="text-slate-700">제한시간 {a.duration_min}분</b>이 바로 흐르기 시작하고,
          중간에 멈추거나 다시 응시할 수 없습니다. 준비가 되었을 때 시작하세요.
        </>
      ),
      confirmLabel: "응시 시작",
    });
    if (!ok) return;
    setBusyId(a.assessment_id);
    try {
      const attempt = await api.post<Attempt>(`/assessments/${a.assessment_id}/attempts`);
      router.push(`/exam/${attempt.id}`);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "시작할 수 없습니다", "error");
      setBusyId(null);
    }
  };

  const retake = async (a: MyAssignment) => {
    if (!a.attempt_id) return;
    if (!(await confirm({ title: "다시 응시할까요?", message: "스태프 체험용 재응시입니다.", confirmLabel: "다시 응시" }))) return;
    setBusyId(a.assessment_id);
    try {
      const attempt = await api.post<Attempt>(`/attempts/${a.attempt_id}/retake`);
      router.push(`/exam/${attempt.id}`);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "다시 응시할 수 없습니다", "error");
      setBusyId(null);
    }
  };

  if (loading || !user) return <Spinner label="불러오는 중..." />;

  return (
    <div className="mx-auto max-w-5xl px-4 py-10">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-black">
            Odysseus<span className="text-sky-500">.</span>
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            {user.name}님, {isGuest ? "둘러볼 수 있는 시험 목록입니다." : "응시할 시험 목록입니다."}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/office"
            className="rounded-lg border border-sky-200 bg-sky-50 px-4 py-2 text-sm font-medium text-sky-700 transition hover:border-sky-300 hover:bg-sky-100"
          >
            사무실로 출근하기
          </Link>
          {isStaff && (
            <Link
              href={user.role === "admin" ? "/admin/scenarios" : "/review"}
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
            >
              관리자 콘솔로
            </Link>
          )}
          <Button variant="ghost" onClick={() => leave(user)}>
            로그아웃
          </Button>
        </div>
      </div>

      {isGuest && (
        <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <span className="font-semibold">게스트로 접속 중입니다.</span> 이 계정은 비밀번호가 없어
          다시 로그인할 수 없습니다 — 로그아웃하거나 브라우저를 닫으면 진행 중이던 응시로 돌아올 수 없어요.
        </div>
      )}

      {error && <p className="mb-4 text-sm text-red-600">{error}</p>}
      {assignments && assignments.length > 1 && (
        <div className="mb-4">
          <CategoryFilter items={assignments} value={category} onChange={pickCategory} />
        </div>
      )}
      {!assignments ? (
        <Spinner />
      ) : assignments.length === 0 ? (
        <EmptyState message={isGuest ? "지금 응시할 수 있는 시험이 없습니다." : "배정된 시험이 없습니다."} />
      ) : visible.length === 0 ? (
        <EmptyState message={`${categoryLabel(category)} 분야의 시험이 없습니다.`} />
      ) : (
        <div className="space-y-4">
          {visible.map((a) => {
            const busy = busyId === a.assessment_id;
            const finished = a.attempt_status && a.attempt_status !== "in_progress";
            return (
              <Card key={a.assessment_id} className="p-6">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      {/* 시험은 상황 하나 — 분야 안에서 무엇이 다른지는 꼬리표가 말한다: "사무·문서 [초급]" */}
                      <span className="cat-chip">
                        {categoryLabel(a.category)}
                        {a.label && <b className="ml-1 font-bold">[{a.label}]</b>}
                      </span>
                      <h2 className="text-lg font-bold">{a.title}</h2>
                      {a.difficulty && <Badge value={a.difficulty} label={DIFFICULTY_LABEL[a.difficulty]} />}
                      {a.attempt_status && (
                        <Badge value={a.attempt_status} label={STATUS_LABEL[a.attempt_status]} />
                      )}
                      {!a.assigned && isStaff && (
                        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700">
                          미배정 · 체험
                        </span>
                      )}
                    </div>
                    {a.description && <p className="mt-2 text-sm text-slate-600">{a.description}</p>}
                    <p className="mt-2 text-xs text-slate-400">
                      시나리오 {a.scenario_count}개 · 제한시간 {a.duration_min}분
                      {a.starts_at && ` · 시작 가능 ${fmtDateTime(a.starts_at)}`}
                      {a.ends_at && ` · 마감 ${fmtDateTime(a.ends_at)}`}
                    </p>
                  </div>
                  <div className="flex w-32 shrink-0 flex-col items-stretch gap-1.5">
                    {a.attempt_status === "in_progress" ? (
                      <Button onClick={() => router.push(`/exam/${a.attempt_id}`)}>이어서 응시</Button>
                    ) : finished ? (
                      // 끝난 시험은 결과가 있다. "응시 완료" 만 적어 두면 결과 화면을 한 번 벗어난 사람은
                      // 다시 갈 길이 없다 — 게스트에게는 그 화면이 마지막이라 더 그렇다.
                      a.attempt_id ? (
                        <Button variant="secondary" onClick={() => router.push(`/result/${a.attempt_id}`)}>
                          결과 보기
                        </Button>
                      ) : (
                        <Button variant="secondary" disabled>
                          응시 완료
                        </Button>
                      )
                    ) : (
                      <Button onClick={() => start(a)} disabled={busy}>
                        {busy ? "준비 중..." : "응시 시작"}
                      </Button>
                    )}
                    {isStaff && finished && (
                      <button
                        onClick={() => retake(a)}
                        disabled={busy}
                        title="스태프 계정만 보이는 다시 응시 — 기존 기록은 재응시 이전 기록으로 남습니다"
                        className="whitespace-nowrap text-center text-xs font-medium text-amber-700 underline-offset-2 transition hover:underline disabled:opacity-50"
                      >
                        {busy ? "시작 중..." : "다시 응시 (스태프)"}
                      </button>
                    )}
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

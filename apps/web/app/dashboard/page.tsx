"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api, ApiError } from "@/lib/api";
import type { Attempt, MyAssignment } from "@/lib/types";
import { fmtDateTime, STATUS_LABEL } from "@/lib/format";
import { useUser, logout } from "@/components/useUser";
import { useToast } from "@/components/toast";
import { Badge, Button, Card, EmptyState, Spinner } from "@/components/ui";

export default function DashboardPage() {
  const { user, loading } = useUser(["candidate", "admin", "evaluator", "guest"]);
  const [assignments, setAssignments] = useState<MyAssignment[] | null>(null);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const { toast, confirm } = useToast();
  const router = useRouter();

  const isStaff = user?.role === "admin" || user?.role === "evaluator";
  const isGuest = user?.role === "guest";

  const load = useCallback(() => {
    api.get<MyAssignment[]>("/my/assignments").then(setAssignments).catch((e) => setError(String(e.message)));
  }, []);

  useEffect(() => {
    if (user) load();
  }, [user, load]);

  const start = async (assessmentId: string) => {
    setBusyId(assessmentId);
    try {
      const attempt = await api.post<Attempt>(`/assessments/${assessmentId}/attempts`);
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
    <div className="mx-auto max-w-3xl px-4 py-10">
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
          {isStaff && (
            <Link
              href={user.role === "admin" ? "/admin/scenarios" : "/review"}
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
            >
              관리자 콘솔로
            </Link>
          )}
          <Button variant="ghost" onClick={() => logout(router)}>
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
      {!assignments ? (
        <Spinner />
      ) : assignments.length === 0 ? (
        <EmptyState message={isGuest ? "지금 응시할 수 있는 시험이 없습니다." : "배정된 시험이 없습니다."} />
      ) : (
        <div className="space-y-4">
          {assignments.map((a) => {
            const busy = busyId === a.assessment_id;
            const finished = a.attempt_status && a.attempt_status !== "in_progress";
            return (
              <Card key={a.assessment_id} className="p-6">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-lg font-bold">{a.title}</h2>
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
                  <div className="flex shrink-0 flex-col items-end gap-2">
                    {a.attempt_status === "in_progress" ? (
                      <Button onClick={() => router.push(`/exam/${a.attempt_id}`)}>이어서 응시</Button>
                    ) : finished ? (
                      <Button variant="secondary" disabled>
                        응시 완료
                      </Button>
                    ) : (
                      <Button onClick={() => start(a.assessment_id)} disabled={busy}>
                        {busy ? "준비 중..." : "응시 시작"}
                      </Button>
                    )}
                    {isStaff && finished && (
                      <button
                        onClick={() => retake(a)}
                        disabled={busy}
                        className="whitespace-nowrap rounded-lg border border-dashed border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-700 transition hover:bg-amber-100 disabled:opacity-50"
                      >
                        {busy ? "시작 중..." : "스태프: 재응시"}
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

"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { api } from "@/lib/api";
import type { ReviewAttemptRow } from "@/lib/types";
import { fmtDateTime, STATUS_LABEL } from "@/lib/format";
import { useUser } from "@/components/useUser";
import { Shell } from "@/components/Shell";
import { DataTable } from "@/components/DataTable";
import { IconDelete, IconView } from "@/components/icons";
import { Badge, IconButton, SearchInput, Spinner } from "@/components/ui";
import { useToast } from "@/components/toast";

function ReviewList() {
  const { user, loading } = useUser(["admin", "evaluator"]);
  const [rows, setRows] = useState<ReviewAttemptRow[] | null>(null);
  const [q, setQ] = useState("");
  /** 목록은 백 건이 넘는다 — 무엇을 먼저 볼지 고를 수 있어야 한다 */
  const [status, setStatus] = useState<"all" | "submitted" | "expired" | "in_progress">("all");
  const [evalState, setEvalState] = useState<"all" | "todo" | "done">("all");
  const [hideStaff, setHideStaff] = useState(false);
  const [limit, setLimit] = useState(50);
  const { confirm } = useToast();
  const searchParams = useSearchParams();
  const assessmentId = searchParams.get("assessment_id");

  const load = () => api.get<ReviewAttemptRow[]>("/review/attempts").then(setRows);

  useEffect(() => {
    if (user) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  const filtered = useMemo(() => {
    let list = rows ?? [];
    if (assessmentId) list = list.filter((r) => r.assessment_id === assessmentId);
    if (status !== "all") list = list.filter((r) => r.status === status);
    if (evalState === "todo") list = list.filter((r) => !r.has_auto_eval && !r.has_human_eval);
    if (evalState === "done") list = list.filter((r) => r.has_auto_eval || r.has_human_eval);
    if (hideStaff) list = list.filter((r) => !r.is_staff);
    const query = q.trim().toLowerCase();
    if (!query) return list;
    return list.filter(
      (r) =>
        r.user.name.toLowerCase().includes(query) ||
        r.user.email.toLowerCase().includes(query) ||
        r.assessment_title.toLowerCase().includes(query),
    );
  }, [rows, q, assessmentId, status, evalState, hideStaff]);

  // 한 번에 다 그리면 스크롤만 길어진다 — 눈에 보이는 만큼만 그리고 더 보기로 늘린다
  const shown = filtered.slice(0, limit);

  const remove = async (r: ReviewAttemptRow) => {
    if (!(await confirm({ title: "응시 기록을 삭제할까요?", message: `${r.user.name} — ${r.assessment_title}. 되돌릴 수 없습니다.`, danger: true, confirmLabel: "삭제" }))) return;
    await api.del(`/attempts/${r.id}`);
    load();
  };

  if (loading || !user) return <Spinner />;

  return (
    <Shell user={user}>
      <div className="mb-4 flex items-center justify-between gap-4">
        <h1 className="text-xl font-bold">응시 리뷰</h1>
        <SearchInput value={q} onChange={setQ} placeholder="응시자/시험 검색..." />
      </div>
      <div className="mb-5 flex flex-wrap items-center gap-2 text-xs">
        <FilterTabs
          value={status}
          onChange={setStatus}
          options={[
            ["all", "전체"],
            ["submitted", "제출 완료"],
            ["expired", "시간 만료"],
            ["in_progress", "진행 중"],
          ]}
        />
        <span className="h-5 w-px bg-slate-200" aria-hidden="true" />
        <FilterTabs
          value={evalState}
          onChange={setEvalState}
          options={[
            ["all", "평가 전체"],
            ["todo", "미평가"],
            ["done", "평가함"],
          ]}
        />
        <label className="ml-1 flex cursor-pointer items-center gap-1.5 text-slate-500">
          <input type="checkbox" checked={hideStaff} onChange={(e) => setHideStaff(e.target.checked)} />
          체험 기록 숨기기
        </label>
        <span className="ml-auto text-slate-400">
          {filtered.length}건{filtered.length > shown.length && ` 중 ${shown.length}건 표시`}
        </span>
      </div>
      {!rows ? (
        <Spinner />
      ) : (
        <DataTable
          rows={shown}
          rowKey={(r) => r.id}
          empty={q ? "검색 결과가 없습니다." : "응시 기록이 없습니다."}
          columns={[
            {
              key: "candidate",
              header: "응시자",
              render: (r) => (
                <div>
                  <div className="flex items-center gap-1.5 font-medium">
                    {r.user.name}
                    {r.is_staff && (
                      <span className="rounded-full bg-violet-100 px-1.5 py-0.5 text-[10px] font-semibold text-violet-600">
                        체험
                      </span>
                    )}
                    {r.superseded && (
                      <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-500">
                        재응시 이전 기록
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-slate-400">{r.user.email}</div>
                </div>
              ),
            },
            { key: "assessment", header: "시험", render: (r) => r.assessment_title },
            {
              key: "score",
              header: "점수",
              className: "whitespace-nowrap text-right tabular-nums",
              render: (r) =>
                r.score === null ? <span className="text-slate-300">—</span> : <b>{r.score}</b>,
            },
            {
              key: "status",
              header: "상태",
              render: (r) => <Badge value={r.status} label={STATUS_LABEL[r.status] ?? r.status} />,
            },
            {
              key: "eval",
              header: "평가",
              className: "text-slate-500",
              render: (r) =>
                [r.has_auto_eval ? "자동" : null, r.has_human_eval ? "수동" : null].filter(Boolean).join(" · ") ||
                "미평가",
            },
            {
              key: "started",
              header: "시작",
              className: "whitespace-nowrap text-slate-500",
              render: (r) => fmtDateTime(r.started_at),
            },
          ]}
          actions={(r) => (
            <>
              <IconButton title="상세 보기" href={`/review/attempts/${r.id}`}>
                <IconView />
              </IconButton>
              {user.role === "admin" && (
                <IconButton title="삭제" tone="danger" write onClick={() => remove(r)}>
                  <IconDelete />
                </IconButton>
              )}
            </>
          )}
        />
      )}
      {filtered.length > shown.length && (
        <div className="mt-4 flex justify-center">
          <button
            onClick={() => setLimit((n) => n + 50)}
            className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-600 transition hover:bg-slate-50"
          >
            더 보기 ({filtered.length - shown.length}건 남음)
          </button>
        </div>
      )}
    </Shell>
  );
}

/** 목록 위의 작은 탭 — 값 하나를 고르는 필터 */
function FilterTabs<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (next: T) => void;
  options: [T, string][];
}) {
  return (
    <div className="flex gap-1">
      {options.map(([key, label]) => (
        <button
          key={key}
          onClick={() => onChange(key)}
          className={`rounded-full px-3 py-1 font-medium transition ${
            value === key ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-500 hover:bg-slate-200"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export default function ReviewPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <ReviewList />
    </Suspense>
  );
}

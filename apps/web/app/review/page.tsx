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
    const query = q.trim().toLowerCase();
    if (!query) return list;
    return list.filter(
      (r) =>
        r.user.name.toLowerCase().includes(query) ||
        r.user.email.toLowerCase().includes(query) ||
        r.assessment_title.toLowerCase().includes(query),
    );
  }, [rows, q, assessmentId]);

  const remove = async (r: ReviewAttemptRow) => {
    if (!(await confirm({ title: "응시 기록을 삭제할까요?", message: `${r.user.name} — ${r.assessment_title}. 되돌릴 수 없습니다.`, danger: true, confirmLabel: "삭제" }))) return;
    await api.del(`/attempts/${r.id}`);
    load();
  };

  if (loading || !user) return <Spinner />;

  return (
    <Shell user={user}>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-bold">응시 리뷰</h1>
        <SearchInput value={q} onChange={setQ} placeholder="응시자/시험 검색..." />
      </div>
      {!rows ? (
        <Spinner />
      ) : (
        <DataTable
          rows={filtered}
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
              className: "text-slate-500",
              render: (r) => fmtDateTime(r.started_at),
            },
          ]}
          actions={(r) => (
            <>
              <IconButton title="상세 보기" href={`/review/attempts/${r.id}`}>
                <IconView />
              </IconButton>
              {user.role === "admin" && (
                <IconButton title="삭제" tone="danger" onClick={() => remove(r)}>
                  <IconDelete />
                </IconButton>
              )}
            </>
          )}
        />
      )}
    </Shell>
  );
}

export default function ReviewPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <ReviewList />
    </Suspense>
  );
}

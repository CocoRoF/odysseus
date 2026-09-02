"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import type { AssessmentSummary } from "@/lib/types";
import { fmtDateTime } from "@/lib/format";
import { useUser } from "@/components/useUser";
import { Shell } from "@/components/Shell";
import { DataTable } from "@/components/DataTable";
import { IconDelete, IconEdit, IconResults } from "@/components/icons";
import { Button, IconButton, SearchInput, Spinner } from "@/components/ui";
import { useToast } from "@/components/toast";

export default function AssessmentsPage() {
  const { user, loading } = useUser(["admin"]);
  const [rows, setRows] = useState<AssessmentSummary[] | null>(null);
  const [q, setQ] = useState("");
  const { confirm } = useToast();

  const load = () => api.get<AssessmentSummary[]>("/assessments").then(setRows);

  useEffect(() => {
    if (user) load();
  }, [user]);

  const filtered = useMemo(() => {
    const query = q.trim().toLowerCase();
    if (!query) return rows ?? [];
    return (rows ?? []).filter((a) => a.title.toLowerCase().includes(query));
  }, [rows, q]);

  const remove = async (a: AssessmentSummary) => {
    if (!(await confirm({ title: "시험을 삭제할까요?", message: `${a.title} — 응시 기록도 함께 삭제됩니다.`, danger: true, confirmLabel: "삭제" }))) return;
    await api.del(`/assessments/${a.id}`);
    load();
  };

  if (loading || !user) return <Spinner />;

  return (
    <Shell user={user}>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-bold">시험 관리</h1>
        <div className="flex items-center gap-2">
          <SearchInput value={q} onChange={setQ} placeholder="시험 제목 검색..." />
          <Link href="/admin/assessments/new">
            <Button>+ 새 시험</Button>
          </Link>
        </div>
      </div>

      {!rows ? (
        <Spinner />
      ) : (
        <DataTable
          rows={filtered}
          rowKey={(a) => a.id}
          empty={q ? "검색 결과가 없습니다." : "등록된 시험이 없습니다."}
          columns={[
            {
              key: "title",
              header: "시험",
              render: (a) => (
                <Link href={`/admin/assessments/${a.id}`} className="truncate font-medium hover:underline">
                  {a.title}
                </Link>
              ),
            },
            {
              key: "scenarios",
              header: "시나리오",
              className: "text-slate-500",
              render: (a) => `${a.scenario_count}개`,
            },
            {
              key: "duration",
              header: "제한시간",
              className: "text-slate-500",
              render: (a) => `${a.duration_min}분`,
            },
            {
              key: "assigned",
              header: "배정 / 응시",
              className: "text-slate-500",
              render: (a) => `${a.assignee_count}명 / ${a.attempt_count}건`,
            },
            {
              key: "created",
              header: "생성",
              className: "text-slate-500",
              render: (a) => fmtDateTime(a.created_at),
            },
          ]}
          actions={(a) => (
            <>
              <IconButton title="편집" href={`/admin/assessments/${a.id}`}>
                <IconEdit />
              </IconButton>
              <IconButton title="결과 보기" href={`/review?assessment_id=${a.id}`}>
                <IconResults />
              </IconButton>
              <IconButton title="삭제" tone="danger" onClick={() => remove(a)}>
                <IconDelete />
              </IconButton>
            </>
          )}
        />
      )}
    </Shell>
  );
}

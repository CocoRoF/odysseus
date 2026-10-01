"use client";

import { useMemo } from "react";
import { fmtDateTime } from "@/lib/format";
import { describeEvent } from "@/lib/timeline";
import type { ReviewEvent } from "@/lib/types";
import { EmptyState } from "@/components/ui";

/** 채점 화면의 [참고자료] — 모르는 것을 어떻게 찾았는가.
 *
 *  무엇을 만들었는지는 파일에 남지만, **무엇을 찾아보고 판단했는지**는 타임라인 속에 흩어져 있었다.
 *  창 전환·화면 이탈과 뒤섞인 수백 줄에서 검색어를 골라내는 일은 채점자가 할 일이 아니다.
 *
 *  전부 서버가 직접 기록한 사실이다(reference.py) — 브라우저가 보고한 값이 아니라, 서버가 받은
 *  요청 그 자체다. 다만 검색어는 응시자가 쓴 글이므로 지시가 아니라 자료로 읽어야 한다.
 */
export function ReferenceReview({ scenarioId, events }: { scenarioId: string; events: ReviewEvent[] | null }) {
  const rows = useMemo(
    () =>
      (events ?? [])
        .filter(
          (e) =>
            e.scenario_id === scenarioId &&
            (e.type.startsWith("reference_") || e.type === "github_clone"),
        )
        .sort((a, b) => a.created_at.localeCompare(b.created_at)),
    [events, scenarioId],
  );

  if (rows.length === 0) return <EmptyState message="참고자료를 찾아본 기록이 없습니다." />;

  const searches = rows.filter((r) => r.type === "reference_search").length;
  const failed = rows.filter((r) => r.type === "reference_failed").length;

  return (
    <div className="thin-scroll h-full overflow-y-auto">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-slate-200 bg-slate-50 px-4 py-2 text-xs text-slate-500">
        <span>
          전부 <b className="text-slate-700">{rows.length}</b>번
        </span>
        <span>검색 {searches}번</span>
        {failed > 0 && <span className="text-amber-600">실패 {failed}번</span>}
        <span className="text-slate-400">서버가 직접 기록한 사실입니다</span>
      </div>
      <ol className="divide-y divide-slate-100">
        {rows.map((e) => {
          const detail = describeEvent(e.type, e.payload);
          return (
            <li key={e.id} className="flex items-start gap-3 px-4 py-2 text-sm">
              <span className="w-28 shrink-0 text-xs text-slate-400">{fmtDateTime(e.created_at)}</span>
              <span
                className={`w-20 shrink-0 text-xs font-medium ${
                  e.type === "reference_failed" ? "text-amber-600" : "text-slate-500"
                }`}
              >
                {LABEL[e.type] ?? e.type}
              </span>
              <span className="min-w-0 flex-1 break-words text-slate-700">{detail || "-"}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

const LABEL: Record<string, string> = {
  reference_search: "검색",
  reference_open: "열람",
  reference_request: "요청",
  reference_failed: "실패",
  github_clone: "내려받기",
};

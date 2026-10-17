"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import type { ScenarioSummary } from "@/lib/types";
import { DIFFICULTY_LABEL } from "@/lib/format";
import { useUser } from "@/components/useUser";
import { Shell } from "@/components/Shell";
import { DataTable } from "@/components/DataTable";
import { IconDelete, IconEdit } from "@/components/icons";
import { Badge, Button, IconButton, SearchInput, Spinner } from "@/components/ui";
import { useToast } from "@/components/toast";

export default function ScenariosPage() {
  const { user, loading } = useUser(["admin"]);
  const [rows, setRows] = useState<ScenarioSummary[] | null>(null);
  const [q, setQ] = useState("");
  const { confirm } = useToast();

  const load = () => api.get<ScenarioSummary[]>("/scenarios").then(setRows);

  useEffect(() => {
    if (user) load();
  }, [user]);

  const filtered = useMemo(() => {
    const query = q.trim().toLowerCase();
    if (!query) return rows ?? [];
    return (rows ?? []).filter(
      (s) => s.title.toLowerCase().includes(query) || s.summary.toLowerCase().includes(query),
    );
  }, [rows, q]);

  const remove = async (s: ScenarioSummary) => {
    if (!(await confirm({ title: "시나리오를 삭제할까요?", message: `${s.title} — 시험에 연결된 경우 보관 처리됩니다.`, danger: true, confirmLabel: "삭제" }))) return;
    await api.del(`/scenarios/${s.id}`);
    load();
  };

  if (loading || !user) return <Spinner />;

  return (
    <Shell user={user}>
      <div className="mb-2 flex items-center justify-between">
        <h1 className="text-xl font-bold">시나리오 관리</h1>
        <div className="flex items-center gap-2">
          <SearchInput value={q} onChange={setQ} placeholder="제목/요약 검색..." />
          <Link href="/admin/scenarios/new">
            <Button>+ 새 시나리오</Button>
          </Link>
        </div>
      </div>
      <p className="mb-6 text-sm text-slate-500">
        시나리오는 하나의 가상 업무 상황입니다 — 등장인물·정보 분포·초기 워크스페이스·정답 기준을 스튜디오에서 설계합니다.
      </p>

      {!rows ? (
        <Spinner />
      ) : (
        <DataTable
          rows={filtered}
          rowKey={(s) => s.id}
          empty={q ? "검색 결과가 없습니다." : "시나리오가 없습니다. '새 시나리오'로 시작하세요."}
          columns={[
            {
              key: "title",
              header: "시나리오",
              render: (s) => (
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <Link href={`/admin/scenarios/${s.id}`} className="truncate font-medium hover:underline">
                      {s.title}
                    </Link>
                    {s.is_archived && (
                      <span className="rounded-full bg-slate-200 px-2 py-0.5 text-xs text-slate-500">보관됨</span>
                    )}
                  </div>
                  {s.summary && <p className="mt-0.5 truncate text-xs text-slate-400">{s.summary}</p>}
                </div>
              ),
            },
            {
              key: "difficulty",
              header: "난이도",
              render: (s) => <Badge value={s.difficulty} label={DIFFICULTY_LABEL[s.difficulty]} />,
            },
            { key: "chars", header: "등장인물", className: "text-slate-500", render: (s) => `${s.character_count}명` },
            { key: "checks", header: "자동 체크", className: "text-slate-500", render: (s) => `${s.check_count}개` },
            {
              key: "agent",
              header: "에이전트",
              className: "text-slate-500",
              render: (s) => (s.agent_enabled ? "허용" : "차단"),
            },
          ]}
          actions={(s) => (
            <>
              <IconButton title="편집" href={`/admin/scenarios/${s.id}`}>
                <IconEdit />
              </IconButton>
              <IconButton title="삭제" tone="danger" onClick={() => remove(s)}>
                <IconDelete />
              </IconButton>
            </>
          )}
        />
      )}
    </Shell>
  );
}

"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { api, ApiError } from "@/lib/api";
import type { Role, User } from "@/lib/types";
import { fmtDateTime } from "@/lib/format";
import { useUser } from "@/components/useUser";
import { Shell } from "@/components/Shell";
import { DataTable } from "@/components/DataTable";
import { IconDelete, IconEdit } from "@/components/icons";
import { Badge, Button, Field, IconButton, inputCls, Modal, SearchInput, Spinner } from "@/components/ui";
import { useToast } from "@/components/toast";

interface UserForm {
  email: string;
  name: string;
  password: string;
  role: Role;
}

const ROLES: Role[] = ["candidate", "evaluator", "admin"];

/** 역할 이름. 없앤 게스트 기능의 옛 계정은 기록을 남기려고 정지된 채 남아 있다(api 마이그레이션 21). */
const ROLE_LABEL: Record<string, string> = {
  admin: "관리자",
  evaluator: "평가자",
  candidate: "응시자",
  guest: "게스트(종료)",
};

const ROLE_TABS: { key: "all" | Role; label: string }[] = [
  { key: "all", label: "전체" },
  { key: "candidate", label: "응시자" },
  { key: "evaluator", label: "평가자" },
  { key: "admin", label: "관리자" },
];

export default function UsersPage() {
  const { user, loading } = useUser(["admin"]);
  /** 한 화면에 다 그리지 않고 늘려 가며 본다 */
  const [limit, setLimit] = useState(50);
  const [rows, setRows] = useState<User[] | null>(null);
  const [editing, setEditing] = useState<{ target: User | null } | null>(null);
  const [q, setQ] = useState("");
  const [roleTab, setRoleTab] = useState<"all" | Role>("all");
  const { confirm, toast } = useToast();

  const load = () => api.get<User[]>("/admin/users").then(setRows);

  useEffect(() => {
    if (user) load();
  }, [user]);

  const filtered = useMemo(() => {
    const query = q.trim().toLowerCase();
    return (rows ?? []).filter((u) => {
      if (roleTab !== "all" && u.role !== roleTab) return false;
      if (!query) return true;
      return u.name.toLowerCase().includes(query) || u.email.toLowerCase().includes(query);
    });
  }, [rows, q, roleTab]);

  const shown = useMemo(() => filtered.slice(0, limit), [filtered, limit]);

  const counts = useMemo(() => {
    const by: Record<string, number> = { all: (rows ?? []).length };
    for (const u of rows ?? []) by[u.role] = (by[u.role] ?? 0) + 1;
    return by;
  }, [rows]);

  const setActive = async (target: User, active: boolean) => {
    if (
      !active &&
      !(await confirm({
        title: "계정을 정지할까요?",
        message: `${target.name} — 열려 있는 세션이 즉시 끊기고 다시 로그인할 수 없습니다.`,
        danger: true,
        confirmLabel: "정지",
      }))
    )
      return;
    try {
      await api.patch(`/admin/users/${target.id}`, { is_active: active });
      load();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "변경 실패", "error");
    }
  };

  const remove = async (target: User) => {
    if (!(await confirm({ title: "계정을 삭제할까요?", message: `${target.email} — 응시 기록도 함께 삭제됩니다.`, danger: true, confirmLabel: "삭제" }))) return;
    await api.del(`/admin/users/${target.id}`);
    load();
  };

  if (loading || !user) return <Spinner />;

  return (
    <Shell user={user}>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-bold">사용자 관리</h1>
        <div className="flex items-center gap-2">
          <SearchInput value={q} onChange={setQ} placeholder="이름/이메일 검색..." />
          <Link href="/admin/users/new">
            <Button>+ 사용자 추가</Button>
          </Link>
        </div>
      </div>

      <div className="mb-4 flex flex-wrap gap-1">
        {ROLE_TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setRoleTab(t.key)}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${
              roleTab === t.key ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"
            }`}
          >
            {t.label}
            <span className={`ml-1.5 text-xs ${roleTab === t.key ? "text-slate-300" : "text-slate-400"}`}>
              {counts[t.key] ?? 0}
            </span>
          </button>
        ))}
      </div>

      {!rows ? (
        <Spinner />
      ) : (
        <DataTable
          rows={shown}
          rowKey={(u) => u.id}
          empty={q ? "검색 결과가 없습니다." : "등록된 사용자가 없습니다."}
          columns={[
            { key: "name", header: "이름", render: (u) => <span className="font-medium">{u.name}</span> },
            {
              key: "email",
              header: "이메일",
              className: "text-slate-500",
              render: (u) => <span className="block max-w-72 truncate" title={u.email}>{u.email}</span>,
            },
            {
              key: "role",
              header: "역할",
              render: (u) => <Badge value={u.role} label={ROLE_LABEL[u.role] ?? u.role} />,
            },
            {
              key: "status",
              header: "상태",
              render: (u) =>
                u.is_active ? (
                  <span className="text-xs font-medium text-slate-400">활성</span>
                ) : (
                  <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-700">
                    정지
                  </span>
                ),
            },
            {
              key: "created",
              header: "생성일",
              className: "whitespace-nowrap text-slate-500",
              render: (u) => fmtDateTime(u.created_at),
            },
          ]}
          actions={(u) => (
            <>
              {u.id !== user.id &&
                (u.is_active ? (
                  <button
                    onClick={() => setActive(u, false)}
                    className="rounded-lg border border-slate-200 px-2 py-1 text-xs font-medium text-slate-500 transition hover:border-red-300 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-slate-200 disabled:hover:text-slate-500"
                  >
                    정지
                  </button>
                ) : (
                  <button
                    onClick={() => setActive(u, true)}
                    className="rounded-lg border border-emerald-300 bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-700 transition hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    정지 해제
                  </button>
                ))}
              <IconButton title="편집" onClick={() => setEditing({ target: u })}>
                <IconEdit />
              </IconButton>
              {u.id !== user.id && (
                <IconButton title="삭제" tone="danger" onClick={() => remove(u)}>
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
            더 보기 ({filtered.length - shown.length}명 남음)
          </button>
        </div>
      )}
      {editing && (
        <UserModal
          target={editing.target}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}
    </Shell>
  );
}

function UserModal({
  target,
  onClose,
  onSaved,
}: {
  target: User | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [form, setForm] = useState<UserForm>({
    email: target?.email ?? "",
    name: target?.name ?? "",
    password: "",
    // 고를 수 없는 역할(옛 게스트 계정)이면 응시자로 둔다. 선택 상자에 없는 값을 그대로 보내면 서버가 거절한다
    role: target && ROLES.includes(target.role) ? target.role : "candidate",
  });
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      if (target) {
        await api.patch(`/admin/users/${target.id}`, {
          name: form.name,
          role: form.role,
          ...(form.password ? { password: form.password } : {}),
        });
      } else {
        await api.post("/admin/users", form);
      }
      onSaved();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "저장 실패", "error");
      setBusy(false);
    }
  };

  return (
    <Modal title={target ? "사용자 편집" : "사용자 추가"} onClose={onClose}>
      <div className="space-y-3">
        <Field label="이름">
          <input className={inputCls} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label="이메일" hint={target ? "이메일은 변경할 수 없습니다" : undefined}>
          <input
            className={inputCls}
            type="email"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
            disabled={!!target}
          />
        </Field>
        <Field label={target ? "비밀번호 (변경할 때만 입력)" : "비밀번호"} hint="6자 이상">
          <input
            className={inputCls}
            type="password"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
          />
        </Field>
        <Field label="역할">
          <select
            className={inputCls}
            value={form.role}
            onChange={(e) => setForm({ ...form, role: e.target.value as Role })}
          >
            <option value="candidate">응시자</option>
            <option value="evaluator">평가자</option>
            <option value="admin">관리자</option>
          </select>
        </Field>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose}>
            취소
          </Button>
          <Button onClick={save} disabled={busy}>
            {busy ? "저장 중..." : "저장"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

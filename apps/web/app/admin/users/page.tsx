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

export default function UsersPage() {
  const { user, loading } = useUser(["admin"]);
  const [rows, setRows] = useState<User[] | null>(null);
  const [editing, setEditing] = useState<{ target: User | null } | null>(null);
  const [q, setQ] = useState("");
  const { confirm } = useToast();

  const load = () => api.get<User[]>("/admin/users").then(setRows);

  useEffect(() => {
    if (user) load();
  }, [user]);

  const filtered = useMemo(() => {
    const query = q.trim().toLowerCase();
    if (!query) return rows ?? [];
    return (rows ?? []).filter(
      (u) => u.name.toLowerCase().includes(query) || u.email.toLowerCase().includes(query),
    );
  }, [rows, q]);

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

      {!rows ? (
        <Spinner />
      ) : (
        <DataTable
          rows={filtered}
          rowKey={(u) => u.id}
          empty={q ? "검색 결과가 없습니다." : "등록된 사용자가 없습니다."}
          columns={[
            { key: "name", header: "이름", render: (u) => <span className="font-medium">{u.name}</span> },
            { key: "email", header: "이메일", className: "text-slate-500", render: (u) => u.email },
            { key: "role", header: "역할", render: (u) => <Badge value={u.role} /> },
            {
              key: "created",
              header: "생성일",
              className: "text-slate-500",
              render: (u) => fmtDateTime(u.created_at),
            },
          ]}
          actions={(u) => (
            <>
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
    role: target?.role ?? "candidate",
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

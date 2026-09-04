"use client";

import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import type { BlockedIp, GuestPolicy, GuestStats } from "@/lib/types";
import { fmtDateTime } from "@/lib/format";
import { useUser } from "@/components/useUser";
import { Shell } from "@/components/Shell";
import { DataTable } from "@/components/DataTable";
import { IconDelete } from "@/components/icons";
import { Button, Card, Field, IconButton, inputCls, Spinner } from "@/components/ui";
import { useToast } from "@/components/toast";

export default function AccessPage() {
  const { user, loading } = useUser(["admin"]);
  const [policy, setPolicy] = useState<GuestPolicy | null>(null);
  const [stats, setStats] = useState<GuestStats | null>(null);
  const [blocks, setBlocks] = useState<BlockedIp[] | null>(null);
  const [saving, setSaving] = useState(false);
  const { toast, confirm } = useToast();

  const loadAll = () => {
    api.get<GuestPolicy>("/admin/access/guest").then(setPolicy);
    api.get<GuestStats>("/admin/access/guest/stats").then(setStats);
    api.get<BlockedIp[]>("/admin/access/ip-blocks").then(setBlocks);
  };

  useEffect(() => {
    if (user) loadAll();
  }, [user]);

  const savePolicy = async () => {
    if (!policy) return;
    setSaving(true);
    try {
      setPolicy(await api.put<GuestPolicy>("/admin/access/guest", policy));
      toast("게스트 정책을 저장했습니다", "success");
      api.get<GuestStats>("/admin/access/guest/stats").then(setStats);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "저장 실패", "error");
    } finally {
      setSaving(false);
    }
  };

  if (loading || !user) return <Spinner />;

  return (
    <Shell user={user}>
      <h1 className="mb-6 text-xl font-bold">접속 관리</h1>

      <Card className="mb-6 p-6">
        <div className="mb-1 flex items-center justify-between gap-4">
          <h2 className="font-bold">게스트 접속</h2>
          {stats && (
            <p className="text-xs text-slate-400">
              전체 {stats.total}명 · 활성 {stats.active}명 · 최근 24시간 {stats.last_24h}명
            </p>
          )}
        </div>
        <p className="mb-5 text-sm text-slate-500">
          계정 없이 로그인 화면에서 바로 응시할 수 있게 합니다. 게스트는 관리자 메뉴에 들어올 수 없고,
          열려 있는 모든 시험에 응시할 수 있습니다.
        </p>

        {!policy ? (
          <Spinner />
        ) : (
          <div className="space-y-4">
            <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-slate-200 p-4 transition hover:border-slate-300">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4"
                checked={policy.enabled}
                onChange={(e) => setPolicy({ ...policy, enabled: e.target.checked })}
              />
              <span>
                <span className="text-sm font-medium">게스트 로그인 허용</span>
                <span className="mt-0.5 block text-xs text-slate-500">
                  끄면 로그인 화면의 게스트 버튼이 사라지고, 이미 들어온 게스트 세션은 그대로 유지됩니다
                  (즉시 끊으려면 해당 계정을 정지하세요).
                </span>
              </span>
            </label>

            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="주소당 시간당 생성" hint="0 이면 새 게스트를 받지 않습니다">
                <input
                  className={inputCls}
                  type="number"
                  min={0}
                  max={1000}
                  value={policy.max_new_per_hour_per_ip}
                  onChange={(e) =>
                    setPolicy({ ...policy, max_new_per_hour_per_ip: Number(e.target.value) })
                  }
                />
              </Field>
              <Field label="분당 대화 수" hint="순간적인 폭주를 막습니다">
                <input
                  className={inputCls}
                  type="number"
                  min={1}
                  max={120}
                  value={policy.chat_per_min}
                  onChange={(e) => setPolicy({ ...policy, chat_per_min: Number(e.target.value) })}
                />
              </Field>
              <Field label="응시당 대화 총량" hint="0 이면 총량 제한 없음">
                <input
                  className={inputCls}
                  type="number"
                  min={0}
                  max={100000}
                  value={policy.chat_total_per_attempt}
                  onChange={(e) =>
                    setPolicy({ ...policy, chat_total_per_attempt: Number(e.target.value) })
                  }
                />
              </Field>
            </div>

            <p className="text-xs text-slate-400">
              대화 한도는 메신저(NPC)와 AI 에이전트를 합쳐서 셉니다 — 한쪽만 막으면 다른 쪽으로 흘러갑니다.
            </p>

            <div className="flex justify-end">
              <Button onClick={savePolicy} disabled={saving}>
                {saving ? "저장 중..." : "저장"}
              </Button>
            </div>
          </div>
        )}
      </Card>

      <Card className="p-6">
        <h2 className="mb-1 font-bold">주소 차단</h2>
        <p className="mb-5 text-sm text-slate-500">
          차단된 주소에서는 로그인도 게스트 접속도 되지 않고, 그 주소에서 열려 있던 세션은 차단하는 즉시
          끊깁니다. 관리자 계정은 차단의 영향을 받지 않습니다 — 자기 대역을 잘못 넣어도 들어와서 풀 수 있게.
        </p>
        <BlockForm onAdded={loadAll} />
        {!blocks ? (
          <Spinner />
        ) : (
          <div className="mt-4">
            <DataTable
              rows={blocks}
              rowKey={(b) => b.id}
              empty="차단된 주소가 없습니다."
              columns={[
                {
                  key: "cidr",
                  header: "주소 / 대역",
                  render: (b) => <span className="font-mono text-sm font-medium">{b.cidr}</span>,
                },
                { key: "reason", header: "사유", className: "text-slate-500", render: (b) => b.reason || "—" },
                {
                  key: "created",
                  header: "차단일",
                  className: "text-slate-500",
                  render: (b) => fmtDateTime(b.created_at),
                },
              ]}
              actions={(b) => (
                <IconButton
                  title="차단 해제"
                  tone="danger"
                  onClick={async () => {
                    if (
                      !(await confirm({
                        title: "차단을 해제할까요?",
                        message: b.cidr,
                        confirmLabel: "해제",
                      }))
                    )
                      return;
                    await api.del(`/admin/access/ip-blocks/${b.id}`);
                    loadAll();
                  }}
                >
                  <IconDelete />
                </IconButton>
              )}
            />
          </div>
        )}
      </Card>
    </Shell>
  );
}

function BlockForm({ onAdded }: { onAdded: () => void }) {
  const [cidr, setCidr] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const { toast } = useToast();

  const add = async () => {
    if (!cidr.trim()) return;
    setBusy(true);
    try {
      await api.post("/admin/access/ip-blocks", { cidr: cidr.trim(), reason: reason.trim() });
      setCidr("");
      setReason("");
      onAdded();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "차단 실패", "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="w-56">
        <Field label="주소 또는 대역" hint="예: 203.0.113.7 또는 203.0.113.0/24">
          <input
            className={inputCls}
            value={cidr}
            onChange={(e) => setCidr(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && add()}
            placeholder="203.0.113.0/24"
          />
        </Field>
      </div>
      <div className="min-w-48 flex-1">
        <Field label="사유">
          <input
            className={inputCls}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && add()}
            placeholder="선택 사항"
          />
        </Field>
      </div>
      <Button onClick={add} disabled={busy || !cidr.trim()}>
        {busy ? "차단 중..." : "차단"}
      </Button>
    </div>
  );
}

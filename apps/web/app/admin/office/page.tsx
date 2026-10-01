"use client";

/** 관리자 — 사무실 커스텀.
 *
 *  왼쪽은 장면 목록(템플릿 아홉 + 내 프리셋)과 분야별 기본 장면, 오른쪽은 편집기다.
 *
 *  **템플릿**은 코드(scenes.ts)에 있는 기본 장면이다. 관리자가 고쳐 저장하면 DB(office_builtin_overrides)에 남아 코드의
 *  기본값을 덮는다 — 배포는 코드를 새로 깔 뿐 이 표를 건드리지 않으므로 고친 모양이 유지된다. [기본값으로 되돌리기]는 그
 *  행을 지워 그 배포의 코드 기본값으로 돌아간다. 고친 모양이 기본값과 똑같아지면 저장할 때 행을 지운다 — "수정됨" 태그가
 *  거짓말하지 않게.
 *
 *  시험은 [시험 편집]에서 장면을 직접 고를 수 있고, 고르지 않은 시험은 분야별 기본 장면을, 그것도 없으면 자동(층 안에서
 *  겹치지 않게 템플릿 중에서)을 쓴다. 어느 길이든 템플릿은 고친 모양으로 선다.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError } from "@/lib/api";
import type { OfficeBuiltin, OfficePreset, OfficeSettings } from "@/lib/types";
import { CATEGORIES, UNCATEGORIZED_LABEL } from "@/lib/categories";
import { useUser } from "@/components/useUser";
import { Shell } from "@/components/Shell";
import { Button, Spinner } from "@/components/ui";
import { useReadOnly, writeProps } from "@/components/readonly";
import { useToast } from "@/components/toast";
import { OfficeEditor } from "@/components/office/editor/OfficeEditor";
import { blankScene, compact, normalize, sameDesign } from "@/components/office/editor/state";
import { safeScene } from "@/components/office/scene-check";
import { SCENES, SCENE_IDS, type BuiltinSceneId, type SceneSpec } from "@/components/office/scenes";

type Pick = { kind: "builtin"; id: BuiltinSceneId } | { kind: "custom"; id: string } | { kind: "new" };

export default function OfficeAdminPage() {
  const readOnly = useReadOnly();
  const { user, loading } = useUser(["admin"]);
  const [presets, setPresets] = useState<OfficePreset[] | null>(null);
  /** 고친 템플릿 — 여기 없는 템플릿은 코드의 기본값 */
  const [builtins, setBuiltins] = useState<OfficeBuiltin[] | null>(null);
  const [settings, setSettings] = useState<OfficeSettings | null>(null);
  const [pick, setPick] = useState<Pick>({ kind: "builtin", id: SCENE_IDS[0] });
  const [draft, setDraft] = useState<SceneSpec | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  /** 같은 장면을 편집기에 다시 싣는다 — 고친 적 없는 템플릿에서 저장 안 한 변경을 버릴 때(장면 객체가 그대로라 편집기가 모른다) */
  const [reloadNonce, setReloadNonce] = useState(0);
  const { toast, confirm } = useToast();

  const load = useCallback(async () => {
    const [p, s, b] = await Promise.all([
      api.get<OfficePreset[]>("/admin/office/presets"),
      api.get<OfficeSettings>("/admin/office/settings"),
      api.get<OfficeBuiltin[]>("/admin/office/builtins"),
    ]);
    setPresets(p);
    setSettings(s);
    setBuiltins(b);
  }, []);
  useEffect(() => {
    if (user) load();
  }, [user, load]);

  // 저장하지 않고 페이지를 떠나면 브라우저가 한 번 묻는다
  useEffect(() => {
    if (!dirty) return;
    const onUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [dirty]);

  const overrideOf = useMemo(() => new Map((builtins ?? []).map((b) => [b.id, b])), [builtins]);
  /** 템플릿의 지금 이름 — 고쳤으면 고친 이름 */
  const templateLabel = useCallback((id: BuiltinSceneId) => overrideOf.get(id)?.name || SCENES[id].label, [overrideOf]);

  /** 편집기에 넣을 장면 — 고른 것에서 만든다. 템플릿은 고친 모양이 있으면 그것, 없으면 코드의 기본값. */
  const current: SceneSpec | null = useMemo(() => {
    void reloadNonce;
    if (pick.kind === "new") return draft;
    if (pick.kind === "builtin") {
      if (!builtins) return null; // 고친 모양을 받기 전에 기본값을 싣지 않는다(곧바로 바뀌며 편집기가 튄다)
      const row = overrideOf.get(pick.id);
      return normalize(row ? { ...(row.spec as unknown as SceneSpec), id: pick.id, label: row.name } : SCENES[pick.id]);
    }
    const row = presets?.find((r) => r.id === pick.id);
    if (!row) return null;
    const spec = row.spec as unknown as SceneSpec;
    return normalize({ ...spec, id: row.id, label: row.name });
  }, [pick, presets, builtins, overrideOf, draft, reloadNonce]);

  const choose = useCallback(async (next: Pick) => {
    if (dirty && !(await confirm({ title: "저장하지 않은 변경이 있습니다", message: "버리고 다른 장면으로 갈까요?", danger: true, confirmLabel: "버리기" }))) return;
    setDirty(false);
    setPick(next);
  }, [dirty, confirm]);

  const startNew = useCallback(async (from?: SceneSpec, name?: string) => {
    if (dirty && !(await confirm({ title: "저장하지 않은 변경이 있습니다", message: "버리고 새로 시작할까요?", danger: true, confirmLabel: "버리기" }))) return;
    const base = from ? normalize({ ...from, id: "new", label: name ?? `${from.label} 사본` }) : blankScene("new", "새 사무실");
    setDraft(base);
    setDirty(false);
    setPick({ kind: "new" });
  }, [dirty, confirm]);

  const save = useCallback(async (spec: SceneSpec) => {
    setSaving(true);
    try {
      const name = spec.label.trim() || "이름 없는 사무실";
      const body = { name, spec: { ...compact(spec), id: "", label: "" } };
      if (pick.kind === "builtin") {
        const id = pick.id;
        const def = SCENES[id];
        if (sameDesign(spec, def) && name === def.label) {
          // 기본값과 똑같다 — 덮을 것이 없으니 고친 행을 지운다
          if (overrideOf.has(id)) await api.del(`/admin/office/builtins/${id}`);
          setBuiltins((rows) => (rows ?? []).filter((r) => r.id !== id));
          toast("기본값과 같아 템플릿을 기본값으로 두었습니다", "success");
        } else {
          const row = await api.put<OfficeBuiltin>(`/admin/office/builtins/${id}`, body);
          setBuiltins((rows) => [...(rows ?? []).filter((r) => r.id !== row.id), row]);
          toast("템플릿을 저장했습니다 — 이 템플릿을 쓰는 방에 곧바로 반영됩니다", "success");
        }
      } else if (pick.kind === "custom") {
        const row = await api.put<OfficePreset>(`/admin/office/presets/${pick.id}`, body);
        setPresets((rows) => (rows ?? []).map((r) => (r.id === row.id ? row : r)));
        toast("저장했습니다", "success");
      } else {
        const row = await api.post<OfficePreset>("/admin/office/presets", body);
        setPresets((rows) => [...(rows ?? []), row]);
        setPick({ kind: "custom", id: row.id });
        toast("저장했습니다", "success");
      }
      setDirty(false);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "저장 실패", "error");
    } finally {
      setSaving(false);
    }
  }, [pick, toast, overrideOf]);

  /** 템플릿을 코드의 처음 모양으로 — 고친 행을 지운다. 고친 적이 없으면 저장 안 한 변경만 버린다. */
  const resetTemplate = useCallback(async () => {
    if (pick.kind !== "builtin") return;
    const id = pick.id;
    const row = overrideOf.get(id);
    const ok = await confirm({
      title: "템플릿을 기본값으로 되돌릴까요?",
      message: row
        ? `${row.name} — 저장해 둔 수정을 지우고 처음 모양(${SCENES[id].label})으로 돌아갑니다. 이 템플릿을 쓰는 방에도 곧바로 반영됩니다.`
        : "저장하지 않은 변경을 버리고 처음 모양으로 돌아갑니다.",
      danger: true,
      confirmLabel: "기본값으로",
    });
    if (!ok) return;
    try {
      if (row) await api.del(`/admin/office/builtins/${id}`);
      setBuiltins((rows) => (rows ?? []).filter((r) => r.id !== id));
      setDirty(false);
      setReloadNonce((n) => n + 1);
      toast(row ? "템플릿을 기본값으로 되돌렸습니다" : "변경을 버렸습니다", "success");
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "되돌리기 실패", "error");
    }
  }, [pick, overrideOf, confirm, toast]);

  const remove = useCallback(async (row: OfficePreset) => {
    if (!(await confirm({ title: "프리셋을 삭제할까요?", message: `${row.name} — 이 프리셋을 쓰던 시험과 분야 기본값은 자동으로 돌아갑니다.`, danger: true, confirmLabel: "삭제" }))) return;
    await api.del(`/admin/office/presets/${row.id}`);
    if (pick.kind === "custom" && pick.id === row.id) { setPick({ kind: "builtin", id: SCENE_IDS[0] }); setDirty(false); }
    await load();
  }, [confirm, load, pick]);

  const saveDefaults = useCallback(async (defaults: Record<string, string>) => {
    try {
      const s = await api.put<OfficeSettings>("/admin/office/settings", { defaults });
      setSettings(s);
      toast("분야별 기본 장면을 저장했습니다", "success");
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "저장 실패", "error");
    }
  }, [toast]);

  if (loading || !user) return <Spinner />;

  const options = [
    { value: "", label: "자동" },
    ...SCENE_IDS.map((id) => ({ value: `builtin:${id}`, label: `템플릿 · ${templateLabel(id)}` })),
    ...(presets ?? []).map((p) => ({ value: p.id, label: `내 프리셋 · ${p.name}` })),
  ];

  return (
    <Shell user={user} wide>
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold">사무실 커스텀</h1>
          <p className="mt-1 text-sm text-slate-500">방 하나의 설계도를 타일과 에셋으로 만듭니다. 응시자의 시작 지점과 NPC 자리를 정할 수 있습니다.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => startNew()} write>빈 방에서 새로 만들기</Button>
          {current && pick.kind !== "new" && <Button onClick={() => startNew(current)} write>이 장면 복제</Button>}
        </div>
      </div>

      <div className="oe-layout">
        <aside className="oe-sidebar">
          <h3>템플릿 <small>{SCENE_IDS.length}</small></h3>
          <p className="oe-side-hint">모든 시험이 함께 쓰는 기본 방입니다. 고친 모양은 배포해도 유지되고, 언제든 기본값으로 되돌릴 수 있습니다.</p>
          <ul className="oe-list">
            {SCENE_IDS.map((id) => {
              const row = overrideOf.get(id);
              const size = row ? (row.spec as { cols?: number; rows?: number }) : SCENES[id];
              const on = pick.kind === "builtin" && pick.id === id;
              return (
                <li key={id}>
                  <button type="button" data-on={on ? "true" : undefined} data-template={id} onClick={() => choose({ kind: "builtin", id })}>
                    <span>{templateLabel(id)}</span>
                    <span className="oe-chips">
                      {row && <em className="oe-chip" data-kind="modified">{safeScene(row.spec) ? "수정됨" : "오류"}</em>}
                      <em className="oe-chip" data-kind="template">템플릿</em>
                      <small>{size.cols}×{size.rows}{on && dirty ? " · 편집 중" : ""}</small>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          <h3>내 프리셋 {presets ? <small>{presets.length}</small> : null}</h3>
          <ul className="oe-list">
            {presets?.length === 0 && pick.kind !== "new" && <li className="oe-empty">아직 없습니다. 템플릿을 복제하거나 빈 방에서 시작하세요.</li>}
            {presets?.map((p) => {
              const spec = safeScene(p.spec);
              return (
                <li key={p.id}>
                  <button type="button" data-on={pick.kind === "custom" && pick.id === p.id ? "true" : undefined} onClick={() => choose({ kind: "custom", id: p.id })}>
                    <span>{p.name}</span>
                    <small>{(p.spec as { cols?: number }).cols}×{(p.spec as { rows?: number }).rows}{spec ? "" : " · 오류"}{dirty && pick.kind === "custom" && pick.id === p.id ? " · 수정됨" : ""}</small>
                  </button>
                  <button type="button" className="oe-list-del" onClick={() => remove(p)} {...writeProps(readOnly)} title="삭제">×</button>
                </li>
              );
            })}
            {pick.kind === "new" && <li><button type="button" data-on="true"><span>{draft?.label || "새 사무실"}</span><small>{dirty ? "수정됨 · " : ""}저장 전</small></button></li>}
          </ul>

          <h3>분야별 기본 장면</h3>
          <p className="oe-side-hint">장면을 고르지 않은 시험이 쓰는 장면입니다.</p>
          {settings && (
            <DefaultsTable defaults={settings.defaults} options={options} onSave={saveDefaults} />
          )}
        </aside>

        <section className="oe-main">
          {current ? (
            <OfficeEditor
              spec={current}
              onSave={save}
              onDirty={setDirty}
              saving={saving}
              template={pick.kind === "builtin" ? { modified: overrideOf.has(pick.id), onReset: resetTemplate } : undefined}
            />
          ) : (
            <Spinner />
          )}
        </section>
      </div>
    </Shell>
  );
}

function DefaultsTable({ defaults, options, onSave }: { defaults: Record<string, string>; options: { value: string; label: string }[]; onSave: (d: Record<string, string>) => void }) {
  const [draft, setDraft] = useState<Record<string, string>>(defaults);
  useEffect(() => setDraft(defaults), [defaults]);
  const rows = [...CATEGORIES.map((c) => ({ key: c.key, label: c.label })), { key: "", label: UNCATEGORIZED_LABEL }];
  const changed = JSON.stringify(draft) !== JSON.stringify(defaults);
  return (
    <div className="oe-defaults">
      {rows.map((r) => (
        <label key={r.key || "__none"}>
          <span>{r.label}</span>
          <select value={draft[r.key] ?? ""} onChange={(e) => setDraft((d) => ({ ...d, [r.key]: e.target.value }))}>
            {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
      ))}
      <Button disabled={!changed} write onClick={() => onSave(Object.fromEntries(Object.entries(draft).filter(([, v]) => v)))}>기본 장면 저장</Button>
    </div>
  );
}

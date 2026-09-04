"use client";

import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api, ApiError } from "@/lib/api";
import type { Role } from "@/lib/types";
import { useUser } from "@/components/useUser";
import { Shell } from "@/components/Shell";
import { IconAdd, IconDelete } from "@/components/icons";
import { Button, Card, Field, IconButton, inputCls, Spinner } from "@/components/ui";
import { useToast } from "@/components/toast";

interface DraftUser {
  name: string;
  email: string;
  role: Role;
  password: string; // 빈 값 = 공통/자동 비밀번호
}

interface BulkResult {
  created: number;
  failed: number;
  results: { email: string; name: string; ok: boolean; error?: string; generated_password?: string | null }[];
}

type ColField = "" | "name" | "email" | "role" | "password";

const FIELD_LABEL: Record<Exclude<ColField, "">, string> = {
  name: "이름",
  email: "이메일",
  role: "역할",
  password: "비밀번호",
};

const ROLE_ALIASES: Record<string, Role> = {
  admin: "admin",
  관리자: "admin",
  evaluator: "evaluator",
  평가자: "evaluator",
  candidate: "candidate",
  응시자: "candidate",
  지원자: "candidate",
};

const emptyRow = (): DraftUser => ({ name: "", email: "", role: "candidate", password: "" });

/** 헤더 텍스트/값 패턴으로 컬럼 필드 자동 인식 */
function guessColumns(grid: string[][]): { headerRow: boolean; map: ColField[] } {
  const cols = Math.max(...grid.map((r) => r.length));
  const map: ColField[] = Array(cols).fill("");
  const header = grid[0] ?? [];

  const headerGuess = (h: string): ColField => {
    const s = h.trim().toLowerCase();
    if (/이름|성명|name/.test(s)) return "name";
    if (/이메일|메일|email|e-mail/.test(s)) return "email";
    if (/역할|권한|role/.test(s)) return "role";
    if (/비밀번호|암호|password|pw/.test(s)) return "password";
    return "";
  };
  const headerHits = header.map(headerGuess);
  const headerRow = headerHits.some((h) => h !== "");

  const samples = (headerRow ? grid.slice(1) : grid).slice(0, 20);
  for (let c = 0; c < cols; c++) {
    if (headerRow && headerHits[c]) {
      map[c] = headerHits[c];
      continue;
    }
    const values = samples.map((r) => (r[c] ?? "").trim()).filter(Boolean);
    if (values.length === 0) continue;
    if (values.every((v) => v.includes("@"))) map[c] = "email";
    else if (values.every((v) => ROLE_ALIASES[v.toLowerCase()])) map[c] = "role";
  }
  // 이메일도 역할도 아닌 첫 미지정 컬럼을 이름으로 추정
  if (!map.includes("name")) {
    const idx = map.findIndex((f) => f === "");
    if (idx >= 0) map[idx] = "name";
  }
  return { headerRow, map };
}

export default function BulkAddUsersPage() {
  const { user, loading } = useUser(["admin"]);
  const { toast } = useToast();
  const router = useRouter();

  const [rows, setRows] = useState<DraftUser[]>([emptyRow()]);
  const [defaultPassword, setDefaultPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<BulkResult | null>(null);

  // 가져오기(파일/붙여넣기) 상태
  const [grid, setGrid] = useState<string[][] | null>(null);
  const [colMap, setColMap] = useState<ColField[]>([]);
  const [hasHeader, setHasHeader] = useState(true);
  const fileRef = useRef<HTMLInputElement>(null);

  const validRows = useMemo(
    () => rows.filter((r) => r.email.trim().includes("@") && r.name.trim()),
    [rows],
  );

  const setRow = (i: number, patch: Partial<DraftUser>) =>
    setRows((prev) => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  /** 따옴표·줄바꿈을 처리하는 작은 CSV 파서 — 명단 CSV 는 라이브러리 없이 읽는다. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else q = false;
      } else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

// ── 가져오기 ─────────────────────────────────────────────
  const loadGrid = (g: string[][]) => {
    const cleaned = g.map((r) => r.map((c) => String(c ?? "").trim())).filter((r) => r.some(Boolean));
    if (cleaned.length === 0) return toast("데이터가 없습니다", "info");
    const guess = guessColumns(cleaned);
    setGrid(cleaned);
    setColMap(guess.map);
    setHasHeader(guess.headerRow);
  };

  // 업로드 상한 (ODY-012) — 명단 파일은 작다. 큰 파일·큰 시트는 파싱 전에 거른다.
  const MAX_FILE_BYTES = 2 * 1024 * 1024;
  const MAX_ROWS = 5000;
  const MAX_COLS = 40;

  const onFile = async (file: File) => {
    if (file.size > MAX_FILE_BYTES) return toast("파일이 너무 큽니다 (2MB 이하)", "error");
    const buf = await file.arrayBuffer();
    let g: string[][];
    if (/\.csv$/i.test(file.name) || file.type === "text/csv") {
      g = parseCsv(new TextDecoder("utf-8").decode(buf));
    } else {
      // SheetJS 0.20.x (CVE-2023-30533 · CVE-2024-22363 수정판). 첫 시트만, 범위를 잘라 읽는다.
      const XLSX = await import("xlsx");
      let wb;
      try {
        wb = XLSX.read(buf, { dense: true, sheetRows: MAX_ROWS + 1, cellHTML: false, cellStyles: false });
      } catch {
        return toast("읽을 수 없는 스프레드시트입니다", "error");
      }
      const sheet = wb.Sheets[wb.SheetNames[0]];
      if (!sheet) return toast("시트가 없습니다", "info");
      g = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, raw: false, defval: "" }) as unknown as string[][];
    }
    if (g.length > MAX_ROWS) {
      toast(`행이 너무 많아 앞 ${MAX_ROWS}행만 읽었습니다`, "info");
      g = g.slice(0, MAX_ROWS);
    }
    loadGrid(g.map((r) => r.slice(0, MAX_COLS)));
  };

  const importGrid = () => {
    if (!grid) return;
    if (!colMap.includes("email")) return toast("이메일 컬럼을 지정하세요", "info");
    const dataRows = hasHeader ? grid.slice(1) : grid;
    const imported: DraftUser[] = [];
    let skipped = 0;
    for (const r of dataRows) {
      const draft = emptyRow();
      colMap.forEach((field, c) => {
        const v = (r[c] ?? "").trim();
        if (!field || !v) return;
        if (field === "role") draft.role = ROLE_ALIASES[v.toLowerCase()] ?? "candidate";
        else draft[field] = v;
      });
      if (!draft.email.includes("@")) {
        skipped++;
        continue;
      }
      if (!draft.name) draft.name = draft.email.split("@")[0];
      imported.push(draft);
    }
    if (imported.length === 0) return toast("가져올 유효한 행이 없습니다", "info");
    setRows((prev) => [...prev.filter((r) => r.email.trim() || r.name.trim()), ...imported]);
    setGrid(null);
    if (fileRef.current) fileRef.current.value = "";
    if (skipped > 0) toast(`이메일이 없는 ${skipped}개 행은 건너뛰었습니다`, "info");
  };

  // ── 등록 ─────────────────────────────────────────────────
  const submit = async () => {
    if (validRows.length === 0) return toast("등록할 사용자가 없습니다 (이름과 이메일 필수)", "info");
    if (defaultPassword && defaultPassword.length < 6) return toast("공통 비밀번호는 6자 이상이어야 합니다", "info");
    setBusy(true);
    try {
      const res = await api.post<BulkResult>("/admin/users/bulk", {
        users: validRows.map((r) => ({
          name: r.name.trim(),
          email: r.email.trim(),
          role: r.role,
          password: r.password.trim() || null,
        })),
        default_password: defaultPassword.trim() || null,
      });
      setResult(res);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "등록 실패", "error");
    } finally {
      setBusy(false);
    }
  };

  const downloadCredentials = () => {
    if (!result) return;
    const withPw = result.results.filter((r) => r.ok);
    const csv = ["이름,이메일,비밀번호"]
      .concat(withPw.map((r) => `${r.name},${r.email},${r.generated_password ?? (defaultPassword || "(직접 지정)")}`))
      .join("\n");
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "odysseus-users.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  if (loading || !user) return <Spinner />;

  // ── 등록 결과 화면 ────────────────────────────────────────
  if (result) {
    return (
      <Shell user={user}>
        <div className="mb-6 flex items-center justify-between">
          <h1 className="text-xl font-bold">등록 결과</h1>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={downloadCredentials}>
              계정 목록 CSV 다운로드
            </Button>
            <Button onClick={() => router.push("/admin/users")}>사용자 관리로</Button>
          </div>
        </div>
        <div className="mb-4 flex gap-3 text-sm">
          <span className="rounded-lg bg-emerald-50 px-3 py-2 font-semibold text-emerald-700">
            성공 {result.created}명
          </span>
          {result.failed > 0 && (
            <span className="rounded-lg bg-red-50 px-3 py-2 font-semibold text-red-600">
              실패 {result.failed}명
            </span>
          )}
        </div>
        <Card>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs text-slate-400">
                <th className="px-4 py-3 font-medium">이름</th>
                <th className="px-4 py-3 font-medium">이메일</th>
                <th className="px-4 py-3 font-medium">결과</th>
                <th className="px-4 py-3 font-medium">비밀번호</th>
              </tr>
            </thead>
            <tbody>
              {result.results.map((r, i) => (
                <tr key={i} className="border-b border-slate-100 last:border-0">
                  <td className="px-4 py-2.5">{r.name}</td>
                  <td className="px-4 py-2.5 text-slate-500">{r.email}</td>
                  <td className="px-4 py-2.5">
                    {r.ok ? (
                      <span className="text-emerald-600">등록됨</span>
                    ) : (
                      <span className="text-red-500">{r.error}</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 font-mono text-xs">
                    {r.ok ? (r.generated_password ?? (defaultPassword ? "(공통 비밀번호)" : "(직접 지정)")) : "-"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        {result.results.some((r) => r.generated_password) && (
          <p className="mt-3 text-xs text-amber-600">
            자동 생성된 비밀번호는 이 화면을 벗어나면 다시 볼 수 없습니다. CSV로 내려받아 응시자에게 전달하세요.
          </p>
        )}
      </Shell>
    );
  }

  return (
    <Shell user={user}>
      {/* 헤더 */}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <Link
            href="/admin/users"
            className="shrink-0 whitespace-nowrap rounded-lg px-2 py-1.5 text-sm text-slate-500 hover:bg-slate-100 hover:text-slate-800"
          >
            ← 사용자 관리
          </Link>
          <span className="h-5 w-px shrink-0 bg-slate-200" />
          <h1 className="text-xl font-bold">사용자 추가</h1>
        </div>
        <Button onClick={submit} disabled={busy || validRows.length === 0}>
          {busy ? "등록 중..." : `${validRows.length}명 등록`}
        </Button>
      </div>

      {/* 파일/붙여넣기 가져오기 */}
      <Card className="mb-6 p-6">
        <h2 className="text-sm font-bold text-slate-800">파일에서 가져오기</h2>
        <p className="mt-0.5 text-xs text-slate-400">
          Excel(.xlsx)·CSV 파일을 올리면 이름/이메일/역할 컬럼을 자동 인식합니다. 인식 결과는 아래에서 직접
          지정할 수도 있습니다.
        </p>
        <label
          className="mt-4 flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border-2 border-dashed border-slate-300 px-6 py-8 text-center transition hover:border-violet-400 hover:bg-violet-50/30"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const f = e.dataTransfer.files?.[0];
            if (f) onFile(f);
          }}
        >
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx,.xls,.csv"
            className="hidden"
            onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
          />
          <span className="text-sm font-medium text-slate-600">파일을 끌어다 놓거나 클릭해서 선택</span>
          <span className="text-xs text-slate-400">.xlsx · .xls · .csv (예상 컬럼: 이름, 이메일, 역할, 비밀번호)</span>
        </label>

        {/* 컬럼 매핑 + 미리보기 */}
        {grid && (
          <div className="mt-5 rounded-xl border border-violet-200 bg-violet-50/40 p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm font-semibold text-slate-700">
                {grid.length - (hasHeader ? 1 : 0)}개 행 감지 — 각 컬럼이 어떤 값인지 지정하세요
              </span>
              <label className="flex items-center gap-1.5 text-xs text-slate-500">
                <input type="checkbox" checked={hasHeader} onChange={(e) => setHasHeader(e.target.checked)} />
                첫 행은 제목 행
              </label>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr>
                    {colMap.map((field, c) => (
                      <th key={c} className="px-2 pb-2">
                        <select
                          className="w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs"
                          value={field}
                          onChange={(e) =>
                            setColMap((prev) => prev.map((f, j) => (j === c ? (e.target.value as ColField) : f)))
                          }
                        >
                          <option value="">사용 안 함</option>
                          {Object.entries(FIELD_LABEL).map(([k, label]) => (
                            <option key={k} value={k}>
                              {label}
                            </option>
                          ))}
                        </select>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {grid.slice(0, hasHeader ? 6 : 5).map((r, i) => (
                    <tr key={i} className={hasHeader && i === 0 ? "text-slate-400 line-through" : ""}>
                      {colMap.map((_, c) => (
                        <td key={c} className="max-w-48 truncate border-t border-violet-100 px-2 py-1.5">
                          {r[c] ?? ""}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              {grid.length > 6 && <p className="mt-1 text-xs text-slate-400">… 외 {grid.length - 6}행</p>}
            </div>
            <div className="mt-3 flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setGrid(null)}>
                취소
              </Button>
              <Button onClick={importGrid}>목록에 추가</Button>
            </div>
          </div>
        )}
      </Card>

      {/* 등록할 사용자 편집 표 */}
      <Card className="p-6">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-bold text-slate-800">등록할 사용자 ({validRows.length}명 유효)</h2>
            <p className="mt-0.5 text-xs text-slate-400">이름과 이메일은 필수입니다.</p>
          </div>
          <Field label="공통 비밀번호 (선택)" hint="비워두면 행별 비밀번호 또는 자동 생성">
            <input
              className={`${inputCls} max-w-56`}
              type="text"
              value={defaultPassword}
              onChange={(e) => setDefaultPassword(e.target.value)}
              placeholder="6자 이상"
            />
          </Field>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs text-slate-400">
              <th className="w-8 px-2 py-2 font-medium">#</th>
              <th className="px-2 py-2 font-medium">이름</th>
              <th className="px-2 py-2 font-medium">이메일</th>
              <th className="w-32 px-2 py-2 font-medium">역할</th>
              <th className="w-40 px-2 py-2 font-medium">비밀번호 (선택)</th>
              <th className="w-10 px-2 py-2" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-b border-slate-100 last:border-0">
                <td className="px-2 py-1.5 text-xs text-slate-400">{i + 1}</td>
                <td className="px-2 py-1.5">
                  <input
                    className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-sm focus:border-slate-500 focus:outline-none"
                    value={r.name}
                    onChange={(e) => setRow(i, { name: e.target.value })}
                    placeholder="홍길동"
                  />
                </td>
                <td className="px-2 py-1.5">
                  <input
                    className={`w-full rounded-lg border px-2 py-1.5 text-sm focus:outline-none ${
                      r.email && !r.email.includes("@")
                        ? "border-red-300 focus:border-red-400"
                        : "border-slate-200 focus:border-slate-500"
                    }`}
                    value={r.email}
                    onChange={(e) => setRow(i, { email: e.target.value })}
                    placeholder="user@example.com"
                  />
                </td>
                <td className="px-2 py-1.5">
                  <select
                    className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-sm focus:border-slate-500 focus:outline-none"
                    value={r.role}
                    onChange={(e) => setRow(i, { role: e.target.value as Role })}
                  >
                    <option value="candidate">응시자</option>
                    <option value="evaluator">평가자</option>
                    <option value="admin">관리자</option>
                  </select>
                </td>
                <td className="px-2 py-1.5">
                  <input
                    className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-sm focus:border-slate-500 focus:outline-none"
                    value={r.password}
                    onChange={(e) => setRow(i, { password: e.target.value })}
                    placeholder="(공통/자동)"
                  />
                </td>
                <td className="px-2 py-1.5 text-right">
                  <IconButton
                    title="행 삭제"
                    tone="danger"
                    onClick={() => setRows((prev) => (prev.length > 1 ? prev.filter((_, j) => j !== i) : [emptyRow()]))}
                  >
                    <IconDelete />
                  </IconButton>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <button
          onClick={() => setRows((prev) => [...prev, emptyRow()])}
          className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-dashed border-slate-300 px-3 py-1.5 text-sm text-slate-500 hover:border-slate-400 hover:text-slate-700"
        >
          <IconAdd /> 행 추가
        </button>
      </Card>
    </Shell>
  );
}

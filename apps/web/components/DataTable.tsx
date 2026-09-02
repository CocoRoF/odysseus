"use client";

import { ReactNode } from "react";
import { Card } from "./ui";

export interface Column<T> {
  key: string;
  header: ReactNode;
  className?: string;
  render: (row: T) => ReactNode;
}

/** 관리 화면 공용 표 — 가장 우측은 아이콘 액션 컬럼. */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  actions,
  empty = "데이터가 없습니다.",
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  actions?: (row: T) => ReactNode;
  empty?: string;
}) {
  return (
    <Card>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-left text-xs text-slate-400">
            {columns.map((c) => (
              <th key={c.key} className={`whitespace-nowrap px-4 py-3 font-medium ${c.className ?? ""}`}>
                {c.header}
              </th>
            ))}
            {actions && <th className="w-0 px-4 py-3" />}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
              {columns.map((c) => (
                <td key={c.key} className={`px-4 py-3 ${c.className ?? ""}`}>
                  {c.render(row)}
                </td>
              ))}
              {actions && (
                <td className="whitespace-nowrap px-3 py-3">
                  <div className="flex items-center justify-end gap-1">{actions(row)}</div>
                </td>
              )}
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td
                colSpan={columns.length + (actions ? 1 : 0)}
                className="py-12 text-center text-sm text-slate-400"
              >
                {empty}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </Card>
  );
}

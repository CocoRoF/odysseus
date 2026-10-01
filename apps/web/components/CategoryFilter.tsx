"use client";

import { useMemo } from "react";
import { categoryLabel, categoryOrder } from "@/lib/categories";

/** 분야 버튼 필터 — 응시자 화면 상단에서 시험을 분야별로 추린다.
 *
 *  버튼은 **지금 목록에 실제로 있는 분야**만 만든다. 아홉 개를 전부 늘어놓으면 눌러도
 *  아무것도 안 나오는 버튼이 생기고, 그건 없느니만 못하다. 개수를 함께 보여 주는 이유도
 *  같다 — 누르기 전에 무엇이 나올지 알 수 있어야 필터다.
 *
 *  분야가 하나뿐이면 아무것도 그리지 않는다. 고를 것이 없는 필터는 장식이다.
 */
export function CategoryFilter({
  items,
  value,
  onChange,
  tone = "light",
}: {
  items: { category: string }[];
  /** 고른 분야 키. null 은 전체. "" 는 미분류. */
  value: string | null;
  onChange: (next: string | null) => void;
  tone?: "light" | "dark";
}) {
  const groups = useMemo(() => {
    const counts = new Map<string, number>();
    for (const it of items) counts.set(it.category ?? "", (counts.get(it.category ?? "") ?? 0) + 1);
    return [...counts.entries()]
      .map(([key, count]) => ({ key, count, label: categoryLabel(key) }))
      .sort((a, b) => categoryOrder(a.key) - categoryOrder(b.key));
  }, [items]);

  if (groups.length < 2) return null;

  return (
    <div className={`cat-filter cat-filter-${tone}`} role="group" aria-label="분야로 추리기">
      <button type="button" aria-pressed={value === null} onClick={() => onChange(null)}>
        전체 <b>{items.length}</b>
      </button>
      {groups.map((g) => (
        <button
          key={g.key || "__none"}
          type="button"
          aria-pressed={value === g.key}
          onClick={() => onChange(value === g.key ? null : g.key)}
          data-category={g.key}
        >
          {g.label} <b>{g.count}</b>
        </button>
      ))}
    </div>
  );
}

/** 페이지끼리 고른 분야를 이어 준다 — 기본 화면에서 고르고 사무실로 출근해도 그대로다. */
export const CATEGORY_FILTER_KEY = "odysseus:category-filter";

export function readCategoryFilter(): string | null {
  try {
    const v = sessionStorage.getItem(CATEGORY_FILTER_KEY);
    return v === null ? null : v;
  } catch {
    return null;
  }
}

export function writeCategoryFilter(value: string | null): void {
  try {
    if (value === null) sessionStorage.removeItem(CATEGORY_FILTER_KEY);
    else sessionStorage.setItem(CATEGORY_FILTER_KEY, value);
  } catch {
    // 기억하지 못해도 이번 화면에는 적용된다
  }
}

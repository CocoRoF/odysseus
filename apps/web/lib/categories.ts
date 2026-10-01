/** 시험의 분야 — API 의 `categories.ASSESSMENT_CATEGORIES` 와 **같은 순서, 같은 키, 같은 라벨**.
 *
 *  두 벌을 두는 이유는 응시자 화면(게스트 포함)이 목록을 받으러 한 번 더 오가지 않게
 *  하기 위해서다. 어긋나면 `tests/unit/test_assessment_categories.py` 가 멈춘다.
 */
export const CATEGORIES = [
  { key: "infra", label: "인프라", accent: "#62A8C8" },
  { key: "dev", label: "개발", accent: "#6FBDB4" },
  { key: "ai", label: "AI", accent: "#8496D6" },
  { key: "data", label: "데이터·분석", accent: "#7FB8D8" },
  { key: "office", label: "사무·문서", accent: "#9B8FD1" },
  { key: "communication", label: "커뮤니케이션", accent: "#C58FC9" },
  { key: "planning", label: "기획·의사결정", accent: "#C9A96A" },
  { key: "problem", label: "문제 해결", accent: "#6DBBA0" },
  { key: "compliance", label: "규정·판정", accent: "#D28FA0" },
] as const;

/** 미분류 시험의 방 색 */
export const DEFAULT_ACCENT = "#62A8C8";

/** 사무실에서 이 분야의 방에 쓰는 색 — 문패·문턱·불 켜진 화면. 바닥을 이 색으로 칠하지 않는다. */
export function categoryAccent(key: string | null | undefined): string {
  return CATEGORIES.find((c) => c.key === key)?.accent ?? DEFAULT_ACCENT;
}

export type CategoryKey = (typeof CATEGORIES)[number]["key"] | "";

export const UNCATEGORIZED_LABEL = "미분류";

export function categoryLabel(key: string | null | undefined): string {
  return CATEGORIES.find((c) => c.key === key)?.label ?? UNCATEGORIZED_LABEL;
}

/** 목록 순서대로 정렬하기 위한 색인. 미분류는 맨 뒤. */
export function categoryOrder(key: string): number {
  const i = CATEGORIES.findIndex((c) => c.key === key);
  return i < 0 ? CATEGORIES.length : i;
}

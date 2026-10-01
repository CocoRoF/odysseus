"""시험의 분야(category) — 응시자가 시험을 고를 때 쓰는 첫 번째 축.

고정 목록이다. 관리자가 자유롭게 적게 두면 "인프라" · "infra" · "인프라 운영" 이 따로
생겨 필터가 셋으로 갈라진다. 분야는 시험을 **묶기 위한** 것이므로 키가 적고 고정되어야
한다. 새 분야가 필요하면 여기에 한 줄 더하고, 웹의 `lib/categories.ts` 를 같이 고친다 —
둘이 어긋나면 `tests/unit/test_assessment_categories.py` 가 멈춘다.

키는 저장되는 값이고 라벨은 화면에 보이는 말이다. 빈 문자열은 "미분류" 로, 필터에서는
그 이름으로 뜬다.
"""

from __future__ import annotations

ASSESSMENT_CATEGORIES: tuple[tuple[str, str], ...] = (
    ("infra", "인프라"),
    ("dev", "개발"),
    ("ai", "AI"),
    ("data", "데이터·분석"),
    ("office", "사무·문서"),
    ("communication", "커뮤니케이션"),
    ("planning", "기획·의사결정"),
    ("problem", "문제 해결"),
    ("compliance", "규정·판정"),
)

CATEGORY_KEYS: frozenset[str] = frozenset(key for key, _ in ASSESSMENT_CATEGORIES)
CATEGORY_LABELS: dict[str, str] = dict(ASSESSMENT_CATEGORIES)

UNCATEGORIZED_LABEL = "미분류"


def normalize_category(value: str | None) -> str:
    """입력을 저장 형태로. 빈 값은 미분류(""), 그 밖은 목록에 있는 키여야 한다."""
    key = (value or "").strip().lower()
    if not key:
        return ""
    if key not in CATEGORY_KEYS:
        raise ValueError(f"알 수 없는 분야입니다: {value!r} (가능: {', '.join(sorted(CATEGORY_KEYS))})")
    return key


def category_label(key: str) -> str:
    return CATEGORY_LABELS.get(key, UNCATEGORIZED_LABEL)

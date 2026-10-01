"""파일 기반 자동 체크 — 실행(러너) 없이 산출물만 보고 판정하는 부분.

코딩 과제는 "명령을 돌려서 통과하는가"로 채점할 수 있지만, 보고서·회의록·중재안
같은 사무 과제에는 돌릴 것이 없다. 그렇다고 전부 LLM 판단에 맡기면 채점이 흔들린다.
그래서 실행 없이도 객관적으로 확인 가능한 것들 — 파일이 있는가, 금칙어를 피했는가,
분량이 요구 범위 안인가, 표의 특정 칸이 정확한가, 행 수·합계가 맞는가, 같은 값을
두 번 넣지 않았는가 — 을 결정적인 규칙으로 둔다.

이 모듈은 DB·러너·네트워크에 의존하지 않는다 (순수 함수). 그래서 자동평가 경로와
오프라인 테스트가 **같은 코드**로 같은 판정을 낸다.
"""

from __future__ import annotations

import csv
import io
import re

#: 표 비교에서 무시할 장식 — 천 단위 콤마, 통화 기호, 퍼센트, 공백
_NUMERIC_NOISE = re.compile(r"[,\s₩$%원]")
_NUMBER_RE = re.compile(r"^[+-]?\d+(?:\.\d+)?$")

FILE_CHECK_TYPES = (
    "file_exists",
    "file_contains",
    "file_not_contains",
    "file_min_words",
    "file_max_words",
    "csv_cell",
    "csv_row_count",
    "csv_column_sum",
    "csv_column_unique",
)


def normalize_newlines(text: str) -> str:
    """CRLF 정규화 — csv.writer/윈도우 편집기가 남기는 `\\r` 때문에 `$` 앵커가 빗나가지 않게."""
    return text.replace("\r\n", "\n").replace("\r", "\n")


def count_words(text: str) -> int:
    """공백 기준 단어 수.

    한국어 문서에서 '단어'의 엄밀한 정의는 논쟁적이지만, 채점의 목적은 문체 분석이
    아니라 '빈 파일/한 줄짜리 껍데기를 제출했는가'를 가리는 것이다. 그래서 공백
    토큰을 세되, 마크다운 표식(`#`, `-`, `|`)만으로 이루어진 토큰은 세지 않는다.
    """
    tokens = [t for t in re.split(r"\s+", normalize_newlines(text)) if t]
    return sum(1 for t in tokens if re.search(r"[0-9A-Za-z가-힣]", t))


def as_number(value: str) -> float | None:
    """'1,234,000원' → 1234000.0. 숫자로 볼 수 없으면 None."""
    cleaned = _NUMERIC_NOISE.sub("", str(value or "")).strip()
    if not cleaned or not _NUMBER_RE.match(cleaned):
        return None
    return float(cleaned)


def _normalize_text(value: str) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip().casefold()


def parse_csv(text: str) -> list[list[str]]:
    """따옴표·escape 를 지키는 CSV 파싱 (응시자가 만든 파일은 무엇이든 올 수 있다)."""
    rows = list(csv.reader(io.StringIO(normalize_newlines(text))))
    return [[cell.strip() for cell in row] for row in rows if any(cell.strip() for cell in row)]


def column_index(header: list[str], name: str) -> int | None:
    """헤더에서 열 위치를 찾는다 — 공백·대소문자·밑줄 표기를 무시하고 맞춘다.

    응시자가 `Total Amount` 로 쓰든 `total_amount` 로 쓰든 같은 열로 본다.
    채점이 표기 습관을 벌하면 안 된다.
    """
    normalized = [_normalize_text(h) for h in header]
    target = _normalize_text(name)
    alt = target.replace("_", " ")
    for i, h in enumerate(normalized):
        if h == target or h.replace("_", " ") == alt:
            return i
    return None


def _cell_matches(cell: str, want: str) -> bool:
    """한 칸이 조건 값과 같은가 — 숫자면 수치로, 아니면 공백을 무시한 문자열로."""
    if _normalize_text(cell) == _normalize_text(want):
        return True
    want_num = as_number(want)
    if want_num is None:
        return False
    cell_num = as_number(cell)
    return cell_num is not None and abs(cell_num - want_num) < 1e-9


def select_rows(text: str, row_match: str | None) -> tuple[list[list[str]] | None, str]:
    """`열이름=값` 조건에 맞는 데이터 행들을 고른다 → (행 목록, 설명).

    조건이 비어 있으면 모든 데이터 행. 조건에 맞는 행이 하나도 없어도 오류가
    아니다 — "그런 행이 0개" 자체가 채점의 답이 될 수 있기 때문이다(빈 목록 반환).
    """
    rows = parse_csv(text)
    if not rows:
        return None, "표가 비어 있음"
    header = rows[0]
    body = rows[1:]
    if not (row_match or "").strip():
        return body, ""
    key, sep, want = str(row_match).partition("=")
    if not sep:
        return None, "행 조건은 '열이름=값' 형식이어야 함"
    key_idx = column_index(header, key)
    if key_idx is None:
        return None, f"행 조건의 열 '{key.strip()}' 없음 (헤더: {', '.join(header)[:120]})"
    return [row for row in body if key_idx < len(row) and _cell_matches(row[key_idx], want)], ""


def csv_lookup(text: str, *, column: str, row_match: str | None) -> tuple[str | None, str]:
    """표에서 (row_match 로 특정한 행의) column 값을 찾는다 → (값, 설명)."""
    rows = parse_csv(text)
    if not rows:
        return None, "표가 비어 있음"
    header = rows[0]

    col_idx = column_index(header, column)
    if col_idx is None:
        return None, f"열 '{column}' 없음 (헤더: {', '.join(header)[:120]})"

    body = rows[1:]
    if not body:
        return None, "데이터 행이 없음"

    if not (row_match or "").strip():
        target_row = body[0]
    else:
        matched, why = select_rows(text, row_match)
        if matched is None:
            return None, why
        if not matched:
            return None, f"'{row_match}' 인 행을 찾을 수 없음"
        target_row = matched[0]

    if col_idx >= len(target_row):
        return None, f"행에 '{column}' 칸이 없음"
    return target_row[col_idx], ""


def csv_column_values(text: str, *, column: str, row_match: str | None) -> tuple[list[str] | None, str]:
    """한 열의 값들을 (행 조건에 맞는 행만) 순서대로 모은다 → (값 목록, 설명)."""
    rows = parse_csv(text)
    if not rows:
        return None, "표가 비어 있음"
    col_idx = column_index(rows[0], column)
    if col_idx is None:
        return None, f"열 '{column}' 없음 (헤더: {', '.join(rows[0])[:120]})"
    body, why = select_rows(text, row_match)
    if body is None:
        return None, why
    return [row[col_idx] if col_idx < len(row) else "" for row in body], ""


def evaluate_file_check(check: dict, files: dict[str, str]) -> tuple[bool, str]:
    """파일 기반 체크 하나를 판정한다 → (통과 여부, 사람이 읽을 설명).

    `files` 는 {경로: 내용}. 러너가 필요한 `command` 체크는 여기서 다루지 않는다.
    """
    ctype = str(check.get("type") or "")
    path = str(check.get("path") or "")

    if ctype == "file_exists":
        return (path in files), (path if path in files else f"{path} 없음")

    if path not in files:
        return False, f"{path} 없음"
    text = normalize_newlines(files[path])

    if ctype == "file_contains":
        pattern = str(check.get("pattern") or "")
        hit = bool(re.search(pattern, text, re.MULTILINE))
        return hit, f"{path} 에서 /{pattern}/ " + ("일치" if hit else "불일치")

    if ctype == "file_not_contains":
        pattern = str(check.get("pattern") or "")
        hit = re.search(pattern, text, re.MULTILINE | re.IGNORECASE)
        if hit:
            return False, f"{path} 에 금지 표현 발견: '{hit.group(0)[:60]}'"
        return True, f"{path} 에 /{pattern}/ 없음"

    if ctype == "file_min_words":
        need = int(check.get("min_count") or 0)
        have = count_words(text)
        return have >= need, f"{path} 단어 {have}개 (최소 {need})"

    if ctype == "file_max_words":
        # 짧게 쓰는 것이 요구사항인 산출물이 있다 — 보도자료, 한 장짜리 공지, 요약.
        # 분량 하한만 있으면 "길게 쓰면 유리하다"는 잘못된 신호를 준다.
        limit = int(check.get("max_count") or 0)
        have = count_words(text)
        return have <= limit, f"{path} 단어 {have}개 (최대 {limit})"

    if ctype == "csv_row_count":
        expected = as_number(str(check.get("expected") or ""))
        row_match = check.get("row_match")
        body, why = select_rows(text, row_match)
        if body is None:
            return False, f"{path}: {why}"
        have = len(body)
        cond = f" ({row_match})" if (row_match or "").strip() else ""
        if expected is None:
            return False, f"{path}: 기대 행 수(expected)가 숫자가 아님"
        return have == int(expected), f"{path} 행 수{cond} = {have} (기대 {int(expected)})"

    if ctype == "csv_column_sum":
        column = str(check.get("column") or "")
        values, why = csv_column_values(text, column=column, row_match=check.get("row_match"))
        if values is None:
            return False, f"{path}: {why}"
        numbers: list[float] = []
        for raw in values:
            if not str(raw).strip():
                continue  # 빈 칸은 0으로 본다 — 표의 여백까지 벌하지는 않는다
            num = as_number(raw)
            if num is None:
                return False, f"{path} [{column}] 에 숫자가 아닌 값: '{str(raw)[:40]}'"
            numbers.append(num)
        total = sum(numbers)
        want = as_number(str(check.get("expected") or ""))
        if want is None:
            return False, f"{path}: 기대 합계(expected)가 숫자가 아님"
        tolerance = float(check.get("tolerance") or 0)
        ok = abs(total - want) <= tolerance + 1e-9
        return ok, f"{path} [{column}] 합계 = {total:g} (기대 {want:g})"

    if ctype == "csv_column_unique":
        # 일정표·배정표에서 "같은 사람을 두 번 넣지 않았는가" 처럼, 값 자체보다
        # 중복 여부가 정답인 과제가 있다.
        column = str(check.get("column") or "")
        values, why = csv_column_values(text, column=column, row_match=check.get("row_match"))
        if values is None:
            return False, f"{path}: {why}"
        seen: set[str] = set()
        dupes: list[str] = []
        for raw in values:
            key = _normalize_text(raw)
            if not key:
                continue
            if key in seen and raw not in dupes:
                dupes.append(raw)
            seen.add(key)
        if dupes:
            return False, f"{path} [{column}] 중복 값: {', '.join(dupes[:5])}"
        return True, f"{path} [{column}] 값 {len(seen)}개 모두 고유"

    if ctype == "csv_cell":
        column = str(check.get("column") or "")
        value, why = csv_lookup(text, column=column, row_match=check.get("row_match"))
        if value is None:
            return False, f"{path}: {why}"
        expected = str(check.get("expected") or "")
        want_num = as_number(expected)
        got_num = as_number(value)
        if want_num is not None and got_num is not None:
            tolerance = float(check.get("tolerance") or 0)
            ok = abs(got_num - want_num) <= tolerance + 1e-9
            return ok, f"{path} [{column}] = {value} (기대 {expected})"
        ok = _normalize_text(value) == _normalize_text(expected)
        return ok, f"{path} [{column}] = '{value}' (기대 '{expected}')"

    return False, f"알 수 없는 체크: {ctype}"

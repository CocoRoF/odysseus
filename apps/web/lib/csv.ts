/** CSV 파싱·직렬화 — 표 편집기와 미리보기가 공유한다.
 *
 * 쉼표로 split 하는 구현은 `"서울, 강남"` 한 칸에서 바로 깨진다. 응시자가 만든
 * 파일은 무엇이든 올 수 있으므로 따옴표와 이스케이프를 지키는 최소 구현을 둔다.
 */

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const src = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += ch;
    }
  }
  row.push(cell);
  rows.push(row);

  // 마지막 줄바꿈이 만든 빈 행은 버린다 (파일 끝의 개행은 내용이 아니다)
  while (rows.length > 1 && rows[rows.length - 1].every((c) => c === "")) rows.pop();
  return rows;
}

function escapeCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function toCsv(rows: string[][]): string {
  return rows.map((r) => r.map((c) => escapeCell(c ?? "")).join(",")).join("\n") + "\n";
}

/** 표 편집기 상태바용 — 숫자로 읽히는 칸만 모아 합계/평균을 낸다. */
export function numericStats(values: string[]): { count: number; sum: number; avg: number } | null {
  const nums: number[] = [];
  for (const raw of values) {
    const cleaned = String(raw ?? "").replace(/[,\s₩$%원]/g, "");
    if (!cleaned) continue;
    const n = Number(cleaned);
    if (Number.isFinite(n)) nums.push(n);
  }
  if (nums.length === 0) return null;
  const sum = nums.reduce((a, b) => a + b, 0);
  return { count: nums.length, sum, avg: sum / nums.length };
}

export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return "-";
  const rounded = Math.round(n * 100) / 100;
  return rounded.toLocaleString("ko-KR");
}

/** A, B, … Z, AA … — 스프레드시트 열 이름 */
export function columnLabel(index: number): string {
  let label = "";
  let n = index;
  while (n >= 0) {
    label = String.fromCharCode(65 + (n % 26)) + label;
    n = Math.floor(n / 26) - 1;
  }
  return label;
}

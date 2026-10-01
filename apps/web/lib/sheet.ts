/** OdyCell 의 격자 모델 — 화면 없이 혼자 성립하는 부분.
 *
 *  표를 다루는 규칙은 대부분 "어느 칸이 골라졌는가" 와 "그 칸들을 어떻게 바꾸는가" 다. 그 둘을
 *  리액트 밖으로 꺼내 두면 규칙을 눈이 아니라 테스트로 지킬 수 있다 — 붙여넣기가 표 밖으로 넘칠 때,
 *  열을 지운 뒤 선택이 어디로 가는가, 정렬이 머리글을 건드리지 않는가 같은 것들이다.
 *
 *  함수(수식)는 없다. 여기서 셀은 언제나 **글자 그대로**이고, 숫자처럼 읽히는지는 합계·정렬 같은
 *  도구가 그때그때 판단한다. 표를 CSV 로 저장했을 때 사람이 연 것과 같은 파일이어야 하기 때문이다.
 */

export interface Cell {
  r: number;
  c: number;
}

/** 고른 영역. anchor 는 처음 누른 칸, focus 는 지금 끌고 있는 칸 — 둘 다 기억해야 Shift+방향키가 맞는다. */
export interface Range {
  anchor: Cell;
  focus: Cell;
}

export interface Bounds {
  r1: number;
  c1: number;
  r2: number;
  c2: number;
}

export type Grid = string[][];

export const cellAt = (r: number, c: number): Cell => ({ r, c });
export const rangeOf = (cell: Cell): Range => ({ anchor: cell, focus: cell });

/** 방향과 무관하게 좌상단→우하단으로 정리한 경계 */
export function bounds(range: Range): Bounds {
  return {
    r1: Math.min(range.anchor.r, range.focus.r),
    c1: Math.min(range.anchor.c, range.focus.c),
    r2: Math.max(range.anchor.r, range.focus.r),
    c2: Math.max(range.anchor.c, range.focus.c),
  };
}

export function inRange(range: Range, r: number, c: number): boolean {
  const b = bounds(range);
  return r >= b.r1 && r <= b.r2 && c >= b.c1 && c <= b.c2;
}

export function rangeSize(range: Range): { rows: number; cols: number } {
  const b = bounds(range);
  return { rows: b.r2 - b.r1 + 1, cols: b.c2 - b.c1 + 1 };
}

/** 표의 열 수 — 줄마다 길이가 다를 수 있다(CSV 는 그래도 된다). */
export function gridWidth(grid: Grid): number {
  return grid.reduce((m, row) => Math.max(m, row.length), 1);
}

export function cellValue(grid: Grid, r: number, c: number): string {
  return grid[r]?.[c] ?? "";
}

/** 모든 줄의 길이를 맞춘다 — 격자를 그리기 전에 한 번. */
export function rectangular(grid: Grid, minRows = 1, minCols = 1): Grid {
  const cols = Math.max(gridWidth(grid), minCols);
  const rows = Math.max(grid.length, minRows);
  const out: Grid = [];
  for (let r = 0; r < rows; r++) {
    const row = grid[r] ?? [];
    const next = new Array<string>(cols);
    for (let c = 0; c < cols; c++) next[c] = row[c] ?? "";
    out.push(next);
  }
  return out;
}

/** 뒤쪽의 빈 줄·빈 열을 걷어낸다 — 화면에서 늘려 둔 빈칸이 파일에 남지 않게. */
export function trimGrid(grid: Grid): Grid {
  let lastRow = -1;
  let lastCol = -1;
  for (let r = 0; r < grid.length; r++) {
    for (let c = 0; c < (grid[r]?.length ?? 0); c++) {
      if ((grid[r][c] ?? "") !== "") {
        lastRow = Math.max(lastRow, r);
        lastCol = Math.max(lastCol, c);
      }
    }
  }
  if (lastRow < 0) return [[""]];
  return grid.slice(0, lastRow + 1).map((row) => {
    const next = row.slice(0, lastCol + 1);
    while (next.length < lastCol + 1) next.push("");
    return next;
  });
}

// ── 바꾸기 ────────────────────────────────────────────────────────
// 전부 새 격자를 돌려준다. 되돌리기가 스냅샷을 쌓는 방식이라, 제자리에서 고치면 이력이 망가진다.

export function withCell(grid: Grid, r: number, c: number, value: string): Grid {
  const out = rectangular(grid, r + 1, c + 1);
  out[r][c] = value;
  return out;
}

export function clearRange(grid: Grid, range: Range): Grid {
  const b = bounds(range);
  const out = rectangular(grid, b.r2 + 1, b.c2 + 1);
  for (let r = b.r1; r <= b.r2; r++) for (let c = b.c1; c <= b.c2; c++) out[r][c] = "";
  return out;
}

export function insertRows(grid: Grid, at: number, count = 1): Grid {
  const out = rectangular(grid);
  const cols = gridWidth(out);
  const blanks = Array.from({ length: count }, () => new Array<string>(cols).fill(""));
  out.splice(Math.max(0, Math.min(at, out.length)), 0, ...blanks);
  return out;
}

export function deleteRows(grid: Grid, at: number, count = 1): Grid {
  const out = rectangular(grid);
  out.splice(at, count);
  return out.length ? out : [new Array<string>(gridWidth(grid)).fill("")];
}

export function insertCols(grid: Grid, at: number, count = 1): Grid {
  const out = rectangular(grid);
  const where = Math.max(0, Math.min(at, gridWidth(out)));
  return out.map((row) => {
    const next = [...row];
    next.splice(where, 0, ...new Array<string>(count).fill(""));
    return next;
  });
}

export function deleteCols(grid: Grid, at: number, count = 1): Grid {
  const out = rectangular(grid);
  if (gridWidth(out) - count < 1) return out.map((row) => row.map(() => ""));
  return out.map((row) => {
    const next = [...row];
    next.splice(at, count);
    return next;
  });
}

/** 위 칸의 값을 아래로 채운다 (Ctrl+D). 한 칸만 골랐으면 아무 일도 없다. */
export function fillDown(grid: Grid, range: Range): Grid {
  const b = bounds(range);
  if (b.r2 === b.r1) return grid;
  const out = rectangular(grid, b.r2 + 1, b.c2 + 1);
  for (let c = b.c1; c <= b.c2; c++) {
    const source = out[b.r1][c];
    for (let r = b.r1 + 1; r <= b.r2; r++) out[r][c] = source;
  }
  return out;
}

/** 머리글 한 줄을 고정하고 본문만 정렬한다. 숫자로 읽히는 칸끼리는 수치로 비교한다. */
export function sortRows(grid: Grid, col: number, dir: "asc" | "desc", hasHeader = true): Grid {
  const out = rectangular(grid);
  const start = hasHeader ? 1 : 0;
  if (out.length - start < 2) return out;
  const head = out.slice(0, start);
  const body = out.slice(start);
  body.sort((a, b) => {
    const av = a[col] ?? "";
    const bv = b[col] ?? "";
    const an = asNumber(av);
    const bn = asNumber(bv);
    const cmp =
      an !== null && bn !== null ? an - bn : String(av).localeCompare(String(bv), "ko-KR", { numeric: true });
    return dir === "asc" ? cmp : -cmp;
  });
  return [...head, ...body];
}

// ── 클립보드 ──────────────────────────────────────────────────────

/** 고른 영역을 탭으로 구분한 글로. 엑셀·구글 시트가 그대로 받는 형식이다. */
export function rangeToClipboard(grid: Grid, range: Range): string {
  const b = bounds(range);
  const lines: string[] = [];
  for (let r = b.r1; r <= b.r2; r++) {
    const cells: string[] = [];
    for (let c = b.c1; c <= b.c2; c++) {
      const v = cellValue(grid, r, c);
      // 값 안에 탭·줄바꿈이 있으면 따옴표로 감싼다 — 엑셀이 쓰는 규칙과 같다.
      cells.push(/[\t\n"]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    }
    lines.push(cells.join("\t"));
  }
  return lines.join("\n");
}

/** 붙여넣기 글 → 격자.
 *
 *  엑셀에서 복사하면 탭으로 나뉜 글이 온다. 메모장에서 CSV 한 토막을 복사해 오는 사람도 있으므로,
 *  탭이 하나도 없고 쉼표가 있으면 쉼표로 읽는다. 따옴표 안의 구분자와 줄바꿈은 값으로 지킨다.
 */
export function clipboardToGrid(text: string): Grid {
  const src = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n$/, "");
  if (src === "") return [[""]];
  const sep = src.includes("\t") || !src.includes(",") ? "\t" : ",";
  const rows: Grid = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"' && cell === "") quoted = true;
    else if (ch === sep) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  row.push(cell);
  rows.push(row);
  return rows;
}

/** 붙여넣기 — 모자라면 표를 넓힌다. 엑셀처럼, 고른 칸을 왼쪽 위로 삼는다. */
export function pasteAt(grid: Grid, at: Cell, patch: Grid): { grid: Grid; range: Range } {
  const rows = patch.length;
  const cols = patch.reduce((m, r) => Math.max(m, r.length), 1);
  const out = rectangular(grid, at.r + rows, at.c + cols);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) out[at.r + r][at.c + c] = patch[r]?.[c] ?? "";
  }
  return {
    grid: out,
    range: { anchor: at, focus: { r: at.r + rows - 1, c: at.c + cols - 1 } },
  };
}

// ── 이동 ──────────────────────────────────────────────────────────

/** Ctrl+방향키 — 값이 있는 구간의 끝으로 뛴다 (엑셀과 같은 규칙). */
export function jumpEdge(grid: Grid, from: Cell, dr: number, dc: number, rows: number, cols: number): Cell {
  const has = (r: number, c: number) => cellValue(grid, r, c) !== "";
  let { r, c } = from;
  const step = () => {
    const nr = r + dr;
    const nc = c + dc;
    if (nr < 0 || nc < 0 || nr >= rows || nc >= cols) return false;
    r = nr;
    c = nc;
    return true;
  };
  if (!has(r + dr, c + dc)) {
    // 빈 곳을 향하고 있다 — 다음에 값이 나오는 칸까지.
    while (step()) if (has(r, c)) break;
    return { r, c };
  }
  // 값 위를 달리고 있다 — 값이 끊기기 직전까지.
  while (has(r + dr, c + dc)) if (!step()) break;
  return { r, c };
}

/** 숫자로 읽히면 숫자를, 아니면 null. 통화·천단위 쉼표·퍼센트 표시는 걷어낸다. */
export function asNumber(raw: string): number | null {
  const cleaned = String(raw ?? "").replace(/[,\s₩$%원]/g, "");
  if (cleaned === "") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** 고른 영역의 요약 — 상태 표시줄이 쓴다. 엑셀도 여기에 개수·합계·평균을 낸다. */
export function summarize(grid: Grid, range: Range): { cells: number; numbers: number; sum: number; avg: number } {
  const b = bounds(range);
  let cells = 0;
  const nums: number[] = [];
  for (let r = b.r1; r <= b.r2; r++) {
    for (let c = b.c1; c <= b.c2; c++) {
      const v = cellValue(grid, r, c);
      if (v !== "") cells += 1;
      const n = asNumber(v);
      if (n !== null) nums.push(n);
    }
  }
  const sum = nums.reduce((a, b2) => a + b2, 0);
  return { cells, numbers: nums.length, sum, avg: nums.length ? sum / nums.length : 0 };
}

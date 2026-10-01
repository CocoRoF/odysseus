"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { columnLabel } from "@/lib/csv";
import {
  bounds,
  cellValue,
  inRange,
  type Cell,
  type Grid as GridData,
  type Range,
} from "@/lib/sheet";

/** OdyCell 의 격자.
 *
 *  엑셀과 근본이 다른 한 가지: **칸은 고르는 것이고 편집은 따로다.** 예전 표는 칸마다 늘 입력칸이
 *  떠 있어서, 방향키가 글자 사이를 움직이고 범위라는 개념 자체가 없었다. 여기서는 고르기가 기본이고
 *  편집은 F2·두 번 클릭·글자 입력으로만 시작한다. 그래야 방향키·Shift·Ctrl 이 표의 언어가 된다.
 *
 *  그리기는 평범한 표(table)로 한다. 응시 화면의 표는 수천 줄이 아니라 수십 줄이고, 가상 스크롤을
 *  넣으면 열 고정·선택 사각형·머리글 끌기가 전부 어려워진다. 대신 늘 몇 줄·몇 칸을 여분으로 그려
 *  "표 바깥"이 있는 느낌을 준다 — 엑셀이 늘 빈 격자를 보여 주는 것과 같다.
 */

export const ROW_H = 24;
export const HEAD_W = 44;
export const DEFAULT_COL_W = 128;

export interface GridProps {
  data: GridData;
  /** 보이는 넓이·높이가 바뀌면 알린다 — 부모가 몇 줄·몇 칸을 그릴지 정한다 */
  onViewport: (size: { w: number; h: number }) => void;
  rows: number;
  cols: number;
  range: Range;
  editing: { cell: Cell; value: string; /** 글자를 쳐서 시작했는가 — 그러면 기존 값을 덮는다 */ replace: boolean } | null;
  colWidths: Record<number, number>;
  frozenHeader: boolean;
  onSelect: (cell: Cell, extend: boolean) => void;
  onDragTo: (cell: Cell) => void;
  onSelectRow: (r: number, extend: boolean) => void;
  onSelectCol: (c: number, extend: boolean) => void;
  onSelectAll: () => void;
  onBeginEdit: (cell: Cell, seed?: string) => void;
  onEditChange: (value: string) => void;
  onCommitEdit: (move: "down" | "right" | "up" | "left" | "none") => void;
  onCancelEdit: () => void;
  onResizeCol: (c: number, width: number) => void;
  onHeaderMenu: (e: React.MouseEvent, kind: "row" | "col", index: number) => void;
  onCellMenu: (e: React.MouseEvent, cell: Cell) => void;
}

export function Grid(props: GridProps) {
  const { data, rows, cols, range, editing, colWidths, frozenHeader } = props;
  const b = bounds(range);
  const dragging = useRef(false);
  const editRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [resizing, setResizing] = useState<{ c: number; startX: number; startW: number } | null>(null);

  const widthOf = (c: number) => colWidths[c] ?? DEFAULT_COL_W;

  // 편집을 시작하면 그 칸의 입력으로 들어간다. 글자를 쳐서 시작했으면 커서는 끝에 둔다.
  useEffect(() => {
    if (!editing) return;
    const el = editRef.current;
    if (!el) return;
    el.focus();
    const at = el.value.length;
    el.setSelectionRange(at, at);
  }, [editing?.cell.r, editing?.cell.c]); // eslint-disable-line react-hooks/exhaustive-deps

  // 고른 칸이 화면 밖으로 나가면 따라간다 — 방향키로 계속 움직일 수 있어야 한다.
  useLayoutEffect(() => {
    const box = scrollRef.current;
    if (!box) return;
    const top = range.focus.r * ROW_H;
    const left = Array.from({ length: range.focus.c }, (_, i) => widthOf(i)).reduce((a, w) => a + w, 0);
    const right = left + widthOf(range.focus.c);
    const headH = ROW_H + (frozenHeader ? ROW_H : 0);
    if (top < box.scrollTop + headH) box.scrollTop = Math.max(0, top - headH);
    else if (top + ROW_H > box.scrollTop + box.clientHeight) box.scrollTop = top + ROW_H - box.clientHeight;
    if (left < box.scrollLeft + HEAD_W) box.scrollLeft = Math.max(0, left - HEAD_W);
    else if (right > box.scrollLeft + box.clientWidth) box.scrollLeft = right - box.clientWidth;
  }, [range.focus.r, range.focus.c]); // eslint-disable-line react-hooks/exhaustive-deps

  // 열 너비 끌기 — 문서 전체에서 받아야 창 밖으로 나가도 이어진다.
  useEffect(() => {
    if (!resizing) return;
    const move = (e: MouseEvent) => {
      const next = Math.max(48, Math.min(600, resizing.startW + (e.clientX - resizing.startX)));
      props.onResizeCol(resizing.c, next);
    };
    const up = () => setResizing(null);
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
    return () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
    };
  }, [resizing, props]);

  useEffect(() => {
    const up = () => {
      dragging.current = false;
    };
    document.addEventListener("mouseup", up);
    return () => document.removeEventListener("mouseup", up);
  }, []);

  // 창 크기를 부모에게 알린다. 엑셀은 화면 끝까지 격자다 — 자료가 끝난 자리부터 빈 칸이 이어져야
  // "표 바깥" 이 아니라 "아직 안 쓴 자리" 로 보인다.
  const report = props.onViewport;
  useEffect(() => {
    const box = scrollRef.current;
    if (!box) return;
    const send = () => report({ w: box.clientWidth, h: box.clientHeight });
    send();
    const ro = new ResizeObserver(send);
    ro.observe(box);
    return () => ro.disconnect();
  }, [report]);

  const headerSelected = (c: number) => c >= b.c1 && c <= b.c2;
  const rowSelected = (r: number) => r >= b.r1 && r <= b.r2;

  return (
    <div ref={scrollRef} className="odycell-scroll min-h-0 flex-1 overflow-auto bg-white">
      <table className="odycell-table" style={{ width: "max-content" }}>
        <colgroup>
          <col style={{ width: HEAD_W }} />
          {Array.from({ length: cols }, (_, c) => (
            <col key={c} style={{ width: widthOf(c) }} />
          ))}
        </colgroup>
        <thead>
          <tr>
            <th
              className="odycell-corner"
              onClick={props.onSelectAll}
              title="전체 선택 (Ctrl+A)"
              style={{ width: HEAD_W, height: ROW_H }}
            />
            {Array.from({ length: cols }, (_, c) => (
              <th
                key={c}
                data-selected={headerSelected(c) ? "true" : undefined}
                className="odycell-colhead"
                style={{ height: ROW_H }}
                onMouseDown={(e) => {
                  if (e.button !== 0) return;
                  props.onSelectCol(c, e.shiftKey);
                }}
                onContextMenu={(e) => props.onHeaderMenu(e, "col", c)}
              >
                {columnLabel(c)}
                <span
                  className="odycell-grip"
                  title="너비 조절 (두 번 누르면 기본값)"
                  onMouseDown={(e) => {
                    e.stopPropagation();
                    setResizing({ c, startX: e.clientX, startW: widthOf(c) });
                  }}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    props.onResizeCol(c, DEFAULT_COL_W);
                  }}
                />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: rows }, (_, r) => (
            <tr key={r} style={{ height: ROW_H }}>
              <th
                data-selected={rowSelected(r) ? "true" : undefined}
                className="odycell-rowhead"
                style={frozenHeader && r === 0 ? { top: ROW_H, zIndex: 22 } : undefined}
                onMouseDown={(e) => {
                  if (e.button !== 0) return;
                  props.onSelectRow(r, e.shiftKey);
                }}
                onContextMenu={(e) => props.onHeaderMenu(e, "row", r)}
              >
                {r + 1}
              </th>
              {Array.from({ length: cols }, (_, c) => {
                const value = cellValue(data, r, c);
                const isFocus = range.focus.r === r && range.focus.c === c;
                const picked = inRange(range, r, c);
                const isEditing = editing?.cell.r === r && editing?.cell.c === c;
                const num = !isEditing && value !== "" && isNumeric(value);
                return (
                  <td
                    key={c}
                    data-picked={picked && !isFocus ? "true" : undefined}
                    data-focus={isFocus ? "true" : undefined}
                    data-head={frozenHeader && r === 0 ? "true" : undefined}
                    style={frozenHeader && r === 0 ? { position: "sticky", top: ROW_H, zIndex: 12 } : undefined}
                    className="odycell-cell"
                    onMouseDown={(e) => {
                      if (e.button === 2) {
                        if (!picked) props.onSelect({ r, c }, false);
                        return;
                      }
                      dragging.current = true;
                      props.onSelect({ r, c }, e.shiftKey);
                    }}
                    onMouseEnter={() => {
                      if (dragging.current) props.onDragTo({ r, c });
                    }}
                    onDoubleClick={() => props.onBeginEdit({ r, c })}
                    onContextMenu={(e) => props.onCellMenu(e, { r, c })}
                  >
                    {isEditing ? (
                      <input
                        ref={editRef}
                        className="odycell-input"
                        value={editing.value}
                        onChange={(e) => props.onEditChange(e.target.value)}
                        onKeyDown={(e) => onEditKey(e, props)}
                        onBlur={() => props.onCommitEdit("none")}
                      />
                    ) : (
                      <span className={`odycell-text${num ? " odycell-num" : ""}`}>{value}</span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 편집 중의 키 — 여기서 처리한 것은 격자로 올라가지 않는다. */
function onEditKey(e: React.KeyboardEvent<HTMLInputElement>, props: GridProps) {
  // 한글은 마지막 글자를 확정할 때도 Enter 를 쓴다. 조합 중에는 이동으로 받지 않는다.
  const composing = e.nativeEvent.isComposing;
  if (e.key === "Escape") {
    e.preventDefault();
    props.onCancelEdit();
    return;
  }
  if (e.key === "Enter" && !composing) {
    e.preventDefault();
    props.onCommitEdit(e.shiftKey ? "up" : "down");
    return;
  }
  if (e.key === "Tab") {
    e.preventDefault();
    props.onCommitEdit(e.shiftKey ? "left" : "right");
    return;
  }
  // 편집 중의 Ctrl+Z 는 입력칸의 기본 되돌리기에 맡긴다 — 글자 단위로 되돌아가는 편이 자연스럽다.
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
    e.stopPropagation();
    return;
  }
  e.stopPropagation();
}

function isNumeric(v: string): boolean {
  const cleaned = v.replace(/[,\s₩$%원]/g, "");
  return cleaned !== "" && Number.isFinite(Number(cleaned));
}

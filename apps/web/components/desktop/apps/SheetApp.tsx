"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError } from "@/lib/api";
import { useToast } from "@/components/toast";
import { announceCopy, copyText } from "@/lib/clipboard";
import { columnLabel, formatNumber, parseCsv, toCsv } from "@/lib/csv";
import { History, undoRedoIntent } from "@/lib/history";
import {
  bounds,
  cellValue,
  clearRange,
  clipboardToGrid,
  deleteCols,
  deleteRows,
  fillDown,
  gridWidth,
  insertCols,
  insertRows,
  jumpEdge,
  pasteAt,
  rangeToClipboard,
  rectangular,
  sortRows,
  summarize,
  trimGrid,
  withCell,
  type Cell,
  type Grid as GridData,
  type Range,
} from "@/lib/sheet";
import {
  IconAdd,
  IconChevronLeft,
  IconChevronRight,
  IconRefresh,
  IconReply,
  IconSave,
  IconFileText,
} from "@/components/icons";
import { saveStatusText } from "@/lib/autosave";
import { ContextMenuView, MenuEntry, useContextMenu } from "../ContextMenu";
import { checkNewPath, isKeepPath, selectFileStem, useWorkspaceAs } from "../workspace";
import { useFileSaver } from "../useFileSaver";
import { ConflictBar } from "./ConflictBar";
import { DEFAULT_COL_W, Grid, HEAD_W, ROW_H } from "./sheet/Grid";

function isSheet(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return ext === "csv" || ext === "tsv";
}

/** 자료가 끝난 뒤에도 최소한 이만큼은 빈 줄·빈 칸을 둔다. 화면이 크면 화면을 채울 만큼 늘어난다. */
const PAD_ROWS = 6;
const PAD_COLS = 2;

interface EditState {
  cell: Cell;
  value: string;
  replace: boolean;
}

/** OdyCell — 워크스페이스의 CSV 를 스프레드시트로 다룬다.
 *
 *  사무 과제의 산출물은 문서와 **표**다. 표를 만들라고 해 놓고 텍스트 편집기만 주면 쉼표를 손으로
 *  맞추는 것이 과제가 되어 버린다. 그렇다고 칸마다 입력칸을 띄워 두면 그것대로 표가 아니다 — 방향키가
 *  글자 사이를 기어다니고, 여러 칸을 한 번에 다루는 방법이 없다.
 *
 *  그래서 엑셀의 문법을 그대로 가져왔다: **고르기와 편집을 나눈다.** 클릭은 고르고, 끌면 범위가 되고,
 *  글자를 치면 그때 편집이 시작된다. 방향키·Tab·Enter·Ctrl+방향키·Shift 조합이 전부 표의 언어로
 *  움직이고, 복사는 엑셀이 읽는 탭 구분 글로 나가고 엑셀에서 복사한 것이 그대로 들어온다.
 *
 *  함수(수식)는 없다. 저장하면 사람이 연 것과 같은 CSV 여야 하고, 채점(csv_cell)이 그 파일을 그대로
 *  읽기 때문이다. 대신 합계·평균은 고른 영역에 대해 상태 표시줄이 늘 알려 준다.
 *
 *  AI 에이전트나 터미널이 같은 파일을 고치면 워크스페이스가 새 버전을 알려 주고, 편집하지 않은 표는
 *  그 내용으로 맞춘다 — 에이전트에게 시킨 일이 화면에 그대로 나타나야 한 대의 컴퓨터로 느껴진다.
 */
export function SheetApp({ winId }: { winId: string }) {
  const ws = useWorkspaceAs("sheet");
  const { toast, confirm } = useToast();
  const { menu, open: openMenu, close: closeMenu } = useContextMenu();

  const saver = useFileSaver(ws);
  const [path, setPath] = useState<string | null>(null);
  const [data, setData] = useState<GridData>([[""]]);
  const [range, setRange] = useState<Range>({ anchor: { r: 0, c: 0 }, focus: { r: 0, c: 0 } });
  const [editing, setEditing] = useState<EditState | null>(null);
  const [colWidths, setColWidths] = useState<Record<number, number>>({});
  const [reloaded, setReloaded] = useState(false);
  /** 격자가 실제로 차지하는 크기 — 몇 줄·몇 칸을 그릴지 여기서 정한다 */
  const [viewport, setViewport] = useState({ w: 900, h: 480 });
  /** 파일 목록을 접었는가 — 표 하나만 다루는 동안에는 격자가 넓을수록 좋다 */
  const [railOpen, setRailOpen] = useState(true);

  const pathRef = useRef(path);
  pathRef.current = path;
  const dataRef = useRef(data);
  dataRef.current = data;
  const rangeRef = useRef(range);
  rangeRef.current = range;
  const editingRef = useRef(editing);
  editingRef.current = editing;
  const rootRef = useRef<HTMLDivElement>(null);
  /** 격자의 포커스를 대신 드는 보이지 않는 입력 — 키와 클립보드 이벤트가 여기로 온다. */
  const proxyRef = useRef<HTMLTextAreaElement>(null);
  const focusGrid = useCallback(() => proxyRef.current?.focus({ preventScroll: true }), []);
  const history = useRef(new History<GridData>([[""]]));
  const openingRef = useRef(false);

  const [nameError, setNameError] = useState("");
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("output/summary.csv");
  const [newHeader, setNewHeader] = useState("항목,값");

  const sheets = useMemo(
    () => ws.files.filter((f) => isSheet(f.path) && !isKeepPath(f.path)).map((f) => f.path).sort(),
    [ws.files],
  );

  const status = path ? saver.status(path) : null;
  const dirty = path ? saver.isDirty(path) : false;
  const saving = status?.kind === "saving";

  /** 화면에 그리는 크기.
   *
   *  엑셀은 창 끝까지 격자다. 자료가 끝난 자리에서 격자도 끝나면 그 아래가 빈 종이처럼 보이고, 표가
   *  "창 안에 놓인 작은 덩어리" 가 되어 버린다. 그래서 자료 너머로 **적어도 창을 채울 만큼** 그린다.
   */
  const rows = useMemo(() => {
    const fit = Math.ceil((viewport.h - ROW_H) / ROW_H) + 1;
    return Math.max(data.length + PAD_ROWS, fit);
  }, [data.length, viewport.h]);
  const cols = useMemo(() => {
    const used = gridWidth(data);
    let x = 0;
    for (let c = 0; c < used; c++) x += colWidths[c] ?? DEFAULT_COL_W;
    let n = used;
    while (x < viewport.w - HEAD_W && n < used + 40) {
      x += colWidths[n] ?? DEFAULT_COL_W;
      n += 1;
    }
    return Math.max(used + PAD_COLS, n);
  }, [data, colWidths, viewport.w]);

  /** 표를 바꾼다. 이력에 한 걸음 쌓고, 저장기에는 여분을 걷어낸 CSV 를 준다. */
  const apply = useCallback((next: GridData, label = "") => {
    history.current.push(next, label);
    setData(next);
  }, []);

  /** 서버의 CSV 를 표로 — 저장기의 기준은 **표를 다시 CSV 로 만든 모양**이다. 원문과 줄바꿈 따위만
   *  다를 때 열자마자 "편집됨" 이 되어 저장이 나가지 않게 한다. */
  const adopt = useCallback(
    (target: string, content: string, sha: string) => {
      const parsed = parseCsv(content);
      const table = rectangular(parsed.length ? parsed : [[""]]);
      saver.open(target, toCsv(trimGrid(table)), sha);
      history.current.reset(table);
      return table;
    },
    [saver],
  );

  const leaveCurrent = useCallback(async () => {
    const cur = pathRef.current;
    if (!cur) return true;
    if (!(await saver.flushOne(cur))) {
      const ok = await confirm({
        title: "저장하지 못한 편집이 있습니다",
        message: (
          <>
            <b>{cur}</b> — 다른 표를 열면 이 편집은 사라집니다.
          </>
        ),
        danger: true,
        confirmLabel: "편집 버리고 열기",
      });
      if (!ok) return false;
    }
    saver.close(cur);
    return true;
  }, [saver, confirm]);

  const openSheet = useCallback(
    async (target: string) => {
      if (target === pathRef.current) return;
      const owner = ws.fileOwner(target, winId);
      if (owner) {
        ws.focusWindow(owner);
        toast("이 표는 이미 다른 표 창에 열려 있습니다", "info");
        return;
      }
      ws.claimFile(winId, target);
      if (!(await leaveCurrent())) {
        ws.claimFile(winId, pathRef.current);
        return;
      }
      try {
        const fc = await ws.loadContent(target);
        const table = adopt(target, fc.content, fc.sha256);
        setPath(target);
        setData(table);
        setRange({ anchor: { r: 0, c: 0 }, focus: { r: 0, c: 0 } });
        setEditing(null);
        setColWidths({});
      } catch {
        ws.claimFile(winId, null);
        setPath(null);
        setData([[""]]);
        toast("표를 열 수 없습니다", "error");
      }
    },
    [ws, toast, adopt, leaveCurrent, winId],
  );

  useEffect(() => {
    if (!ws.pendingSheetOpen) return;
    const wanted = ws.takeSheetOpen();
    if (!wanted) return;
    openingRef.current = true;
    openSheet(wanted).finally(() => {
      openingRef.current = false;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws.pendingSheetOpen]);

  useEffect(() => {
    if (path !== null || openingRef.current || ws.pendingSheetOpen) return;
    const free = sheets.find((sheet) => !ws.fileOwner(sheet, winId));
    if (free) openSheet(free);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheets.length]);

  useEffect(() => {
    ws.claimFile(winId, path);
    return () => ws.claimFile(winId, null);
  }, [ws.claimFile, winId, path]);

  const save = useCallback(async () => {
    if (!path) return;
    if (!(await saver.save(path))) toast(saveStatusText(saver.status(path)) || "저장에 실패했습니다", "error");
  }, [path, saver, toast]);

  // 표가 바뀌면 저장기에 알린다. 파일에는 여분 빈칸을 뺀 모양이 들어간다.
  useEffect(() => {
    if (path) saver.edit(path, toCsv(trimGrid(data)));
  }, [path, data, saver]);

  // 밖에서 바뀐 표 — 편집하지 않았으면 새 내용으로 맞춘다 (에이전트·터미널이 고친 경우)
  useEffect(() => {
    const cur = pathRef.current;
    const entry = cur ? ws.files.find((f) => f.path === cur) : undefined;
    if (!cur || !entry?.sha256 || saver.noteServerVersion(cur, entry.sha256) !== "reload") return;
    ws.loadContent(cur)
      .then((fc) => {
        if (pathRef.current !== cur || saver.isDirty(cur)) return;
        setData(adopt(cur, fc.content, fc.sha256));
        setEditing(null);
        setReloaded(true);
      })
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws.files]);

  // "새로 읽었습니다" 는 잠깐만 — 계속 떠 있으면 그 자체가 소음이 된다
  useEffect(() => {
    if (!reloaded) return;
    const t = setTimeout(() => setReloaded(false), 4000);
    return () => clearTimeout(t);
  }, [reloaded]);

  const keepMine = async () => {
    if (path && !(await saver.keepMine(path))) {
      toast(saveStatusText(saver.status(path)) || "저장에 실패했습니다", "error");
    }
  };

  const loadServer = async () => {
    const cur = path;
    if (!cur) return;
    try {
      const fc = await ws.loadContent(cur);
      setData(adopt(cur, fc.content, fc.sha256));
      setEditing(null);
    } catch {
      saver.close(cur);
      setPath(null);
      setData([[""]]);
    }
  };

  const resetSheet = async () => {
    if (!path || !ws.isInitial(path)) return;
    const ok = await confirm({
      title: "초기 내용으로 되돌릴까요?",
      message: (
        <>
          <b>{path}</b> 를 시나리오가 처음 제공한 내용으로 되돌립니다. 지금까지 이 표에 한 수정은
          사라집니다.
        </>
      ),
      danger: true,
      confirmLabel: "되돌리기",
    });
    if (!ok) return;
    saver.discard(path);
    try {
      await ws.resetFile(path);
      const fc = await ws.loadContent(path);
      setData(adopt(path, fc.content, fc.sha256));
      setEditing(null);
      toast("초기 내용으로 되돌렸습니다", "success");
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "되돌리기에 실패했습니다", "error");
    }
  };

  useEffect(
    () =>
      ws.subscribeChanges(({ scope, paths }) => {
        const cur = pathRef.current;
        if (!cur) return;
        if (scope !== "all" && !paths.includes(cur)) return;
        saver.discard(cur);
        ws.loadContent(cur)
          .then((fc) => {
            setData(adopt(cur, fc.content, fc.sha256));
            setEditing(null);
          })
          .catch(() => {
            saver.close(cur);
            setPath(null);
            setData([[""]]);
          });
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ws.subscribeChanges, ws.loadContent],
  );

  // ── 고르기 ────────────────────────────────────────────────────

  const select = useCallback((cell: Cell, extend: boolean) => {
    setEditing(null);
    setRange((prev) => (extend ? { anchor: prev.anchor, focus: cell } : { anchor: cell, focus: cell }));
  }, []);

  const dragTo = useCallback((cell: Cell) => {
    setRange((prev) => ({ anchor: prev.anchor, focus: cell }));
  }, []);

  const selectRow = useCallback(
    (r: number, extend: boolean) => {
      setEditing(null);
      setRange((prev) =>
        extend
          ? { anchor: { r: prev.anchor.r, c: 0 }, focus: { r, c: cols - 1 } }
          : { anchor: { r, c: 0 }, focus: { r, c: cols - 1 } },
      );
    },
    [cols],
  );

  const selectCol = useCallback(
    (c: number, extend: boolean) => {
      setEditing(null);
      setRange((prev) =>
        extend
          ? { anchor: { r: 0, c: prev.anchor.c }, focus: { r: rows - 1, c } }
          : { anchor: { r: 0, c }, focus: { r: rows - 1, c } },
      );
    },
    [rows],
  );

  const selectAll = useCallback(() => {
    setEditing(null);
    setRange({ anchor: { r: 0, c: 0 }, focus: { r: rows - 1, c: cols - 1 } });
  }, [rows, cols]);

  // ── 편집 ──────────────────────────────────────────────────────

  const beginEdit = useCallback((cell: Cell, seed?: string) => {
    const current = cellValue(dataRef.current, cell.r, cell.c);
    setRange({ anchor: cell, focus: cell });
    setEditing({ cell, value: seed ?? current, replace: seed !== undefined });
  }, []);

  const commitEdit = useCallback(
    (move: "down" | "right" | "up" | "left" | "none") => {
      const ed = editingRef.current;
      if (!ed) return;
      setEditing(null);
      const before = cellValue(dataRef.current, ed.cell.r, ed.cell.c);
      if (before !== ed.value) {
        apply(withCell(dataRef.current, ed.cell.r, ed.cell.c, ed.value), `cell:${ed.cell.r},${ed.cell.c}`);
      }
      if (move === "none") return;
      const dr = move === "down" ? 1 : move === "up" ? -1 : 0;
      const dc = move === "right" ? 1 : move === "left" ? -1 : 0;
      const next = {
        r: Math.max(0, Math.min(rows - 1, ed.cell.r + dr)),
        c: Math.max(0, Math.min(cols - 1, ed.cell.c + dc)),
      };
      setRange({ anchor: next, focus: next });
      focusGrid();
    },
    [apply, rows, cols],
  );

  const cancelEdit = useCallback(() => setEditing(null), []);

  // ── 도구 ──────────────────────────────────────────────────────

  /** 복사·잘라내기·붙여넣기는 **브라우저의 클립보드 이벤트**로 주고받는다.
   *
   *  navigator.clipboard.readText 는 권한을 묻고 거절될 수 있다. 격자에서 붙여넣기가 가끔 안 되는
   *  것만큼 나쁜 것이 없으므로, 실제 웹 스프레드시트가 쓰는 방법을 쓴다 — 보이지 않는 입력칸이 격자의
   *  포커스를 대신 들고, 그 칸이 copy/cut/paste 이벤트를 받는다. 권한도 필요 없고 Ctrl+V 가 늘 온다.
   */
  const onCopy = useCallback((e: React.ClipboardEvent) => {
    const text = rangeToClipboard(dataRef.current, rangeRef.current);
    e.clipboardData.setData("text/plain", text);
    e.preventDefault();
    announceCopy(text);
  }, []);

  const onCut = useCallback(
    (e: React.ClipboardEvent) => {
      const text = rangeToClipboard(dataRef.current, rangeRef.current);
      e.clipboardData.setData("text/plain", text);
      e.preventDefault();
      announceCopy(text);
      apply(clearRange(dataRef.current, rangeRef.current), "");
    },
    [apply],
  );

  const onPaste = useCallback(
    (e: React.ClipboardEvent) => {
      const text = e.clipboardData.getData("text/plain");
      if (!text) return;
      e.preventDefault();
      const patch = clipboardToGrid(text);
      const bb = bounds(rangeRef.current);
      const { grid, range: next } = pasteAt(dataRef.current, { r: bb.r1, c: bb.c1 }, patch);
      apply(grid, "");
      setRange(next);
    },
    [apply],
  );

  const undo = useCallback(() => {
    history.current.seal();
    setData(history.current.undo());
    setEditing(null);
  }, []);

  const redo = useCallback(() => {
    setData(history.current.redo());
    setEditing(null);
  }, []);

  const insertRowAt = (at: number, count = 1) => apply(insertRows(dataRef.current, at, count), "");
  const removeRowAt = (at: number, count = 1) => apply(deleteRows(dataRef.current, at, count), "");
  const insertColAt = (at: number, count = 1) => apply(insertCols(dataRef.current, at, count), "");
  const removeColAt = (at: number, count = 1) => apply(deleteCols(dataRef.current, at, count), "");
  const sortBy = (c: number, dir: "asc" | "desc") => apply(sortRows(dataRef.current, c, dir), "");

  // ── 키보드 ────────────────────────────────────────────────────

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (editingRef.current) return; // 편집 중의 키는 입력칸이 처리한다
    const cur = rangeRef.current;
    const focus = cur.focus;
    const mod = e.ctrlKey || e.metaKey;

    const moveTo = (cell: Cell, extend: boolean) => {
      e.preventDefault();
      setRange((prev) => (extend ? { anchor: prev.anchor, focus: cell } : { anchor: cell, focus: cell }));
    };
    const clamp = (r: number, c: number): Cell => ({
      r: Math.max(0, Math.min(rows - 1, r)),
      c: Math.max(0, Math.min(cols - 1, c)),
    });

    const undoRedo = undoRedoIntent(e);
    if (undoRedo) {
      e.preventDefault();
      if (undoRedo === "undo") undo();
      else redo();
      return;
    }
    if (mod && e.key.toLowerCase() === "s") {
      e.preventDefault();
      void save();
      return;
    }
    // Ctrl+C·X·V 는 막지 않는다 — 브라우저가 클립보드 이벤트를 띄우고 onCopy/onCut/onPaste 가 받는다.
    if (mod && "cxv".includes(e.key.toLowerCase())) return;
    if (mod && e.key.toLowerCase() === "a") {
      e.preventDefault();
      selectAll();
      return;
    }
    if (mod && e.key.toLowerCase() === "d") {
      e.preventDefault();
      apply(fillDown(dataRef.current, cur), "");
      return;
    }

    switch (e.key) {
      case "ArrowUp":
      case "ArrowDown":
      case "ArrowLeft":
      case "ArrowRight": {
        const dr = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
        const dc = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
        const next = mod
          ? jumpEdge(dataRef.current, focus, dr, dc, rows, cols)
          : clamp(focus.r + dr, focus.c + dc);
        moveTo(next, e.shiftKey);
        return;
      }
      case "Tab":
        moveTo(clamp(focus.r, focus.c + (e.shiftKey ? -1 : 1)), false);
        return;
      case "Enter":
        if (e.nativeEvent.isComposing) return;
        e.preventDefault();
        beginEdit(focus);
        return;
      case "F2":
        e.preventDefault();
        beginEdit(focus);
        return;
      case "Home":
        moveTo(mod ? { r: 0, c: 0 } : { r: focus.r, c: 0 }, e.shiftKey);
        return;
      case "End": {
        const lastCol = Math.max(0, gridWidth(dataRef.current) - 1);
        const lastRow = Math.max(0, dataRef.current.length - 1);
        moveTo(mod ? { r: lastRow, c: lastCol } : { r: focus.r, c: lastCol }, e.shiftKey);
        return;
      }
      case "PageDown":
        moveTo(clamp(focus.r + 15, focus.c), e.shiftKey);
        return;
      case "PageUp":
        moveTo(clamp(focus.r - 15, focus.c), e.shiftKey);
        return;
      case "Delete":
      case "Backspace":
        e.preventDefault();
        apply(clearRange(dataRef.current, cur), "");
        return;
      case "Escape":
        e.preventDefault();
        setRange({ anchor: focus, focus });
        return;
      default:
        break;
    }

    // 글자를 치면 그 자리에서 편집이 시작되고 기존 값은 덮인다 — 엑셀과 같다.
    if (!mod && !e.altKey && e.key.length === 1) {
      e.preventDefault();
      beginEdit(focus, e.key);
    }
  };

  // ── 만들기·지우기 ─────────────────────────────────────────────

  const createSheet = async () => {
    const checked = checkNewPath(newName, ["csv", "tsv"]);
    if ("error" in checked) {
      setNameError(checked.error);
      return;
    }
    const target = checked.path;
    if (ws.files.some((f) => f.path === target)) {
      setNameError("같은 이름의 파일이 이미 있습니다");
      return;
    }
    const header = newHeader.split(",").map((h) => h.trim());
    const body = toCsv([header, header.map(() => "")]);
    if (!(await leaveCurrent())) return;
    try {
      const created = await ws.saveContent(target, body);
      ws.claimFile(winId, target);
      setCreating(false);
      setNameError("");
      setPath(target);
      setData(adopt(target, body, created.sha256));
      setRange({ anchor: { r: 1, c: 0 }, focus: { r: 1, c: 0 } });
      toast("새 표를 만들었습니다", "success");
    } catch {
      toast("표를 만들 수 없습니다", "error");
    }
  };

  const removeSheet = async (target: string) => {
    const ok = await confirm({
      title: "표를 삭제할까요?",
      message: `${target} 파일이 워크스페이스에서 삭제됩니다.`,
      danger: true,
      confirmLabel: "삭제",
    });
    if (!ok) return;
    try {
      await ws.deleteFile(target);
      if (path === target) {
        saver.close(target);
        setPath(null);
        setData([[""]]);
      }
    } catch {
      toast("삭제에 실패했습니다", "error");
    }
  };

  const b = bounds(range);
  const stats = useMemo(() => summarize(data, range), [data, range]);
  /** 여러 칸을 골랐는가 — 상태 표시줄의 셈은 그때만 뜻이 있다 */
  const multi = b.r1 !== b.r2 || b.c1 !== b.c2;
  const selectionLabel =
    b.r1 === b.r2 && b.c1 === b.c2
      ? `${columnLabel(b.c1)}${b.r1 + 1}`
      : `${columnLabel(b.c1)}${b.r1 + 1}:${columnLabel(b.c2)}${b.r2 + 1}`;
  const focusValue = cellValue(data, range.focus.r, range.focus.c);

  const cellMenu = (e: React.MouseEvent, cell: Cell) =>
    openMenu(e, [
      { label: "복사", onClick: () => void copyText(rangeToClipboard(dataRef.current, rangeRef.current)) },
      {
        label: "잘라내기",
        onClick: () => {
          void copyText(rangeToClipboard(dataRef.current, rangeRef.current));
          apply(clearRange(dataRef.current, rangeRef.current), "");
        },
      },
      // 붙여넣기는 메뉴에서 할 수 없다 — 브라우저가 클립보드 읽기를 사용자의 키 입력에만 허락한다.
      { label: "붙여넣기 (Ctrl+V)", disabled: true, onClick: () => undefined },
      "separator",
      { label: "내용 지우기", onClick: () => apply(clearRange(dataRef.current, rangeRef.current), "") },
      { label: "아래로 채우기", onClick: () => apply(fillDown(dataRef.current, rangeRef.current), "") },
      "separator",
      { label: "행 삽입", onClick: () => insertRowAt(cell.r) },
      { label: "열 삽입", onClick: () => insertColAt(cell.c) },
    ] as MenuEntry[]);

  const headerMenu = (e: React.MouseEvent, kind: "row" | "col", index: number) => {
    const span = kind === "row" ? b.r2 - b.r1 + 1 : b.c2 - b.c1 + 1;
    const start = kind === "row" ? b.r1 : b.c1;
    const within = kind === "row" ? index >= b.r1 && index <= b.r2 : index >= b.c1 && index <= b.c2;
    const at = within ? start : index;
    const count = within ? span : 1;
    openMenu(
      e,
      kind === "row"
        ? ([
            { label: count > 1 ? `위에 ${count}행 삽입` : "위에 행 삽입", onClick: () => insertRowAt(at, count) },
            { label: count > 1 ? `아래에 ${count}행 삽입` : "아래에 행 삽입", onClick: () => insertRowAt(at + count, count) },
            "separator",
            { label: count > 1 ? `${count}행 삭제` : "행 삭제", danger: true, onClick: () => removeRowAt(at, count) },
          ] as MenuEntry[])
        : ([
            { label: count > 1 ? `왼쪽에 ${count}열 삽입` : "왼쪽에 열 삽입", onClick: () => insertColAt(at, count) },
            { label: count > 1 ? `오른쪽에 ${count}열 삽입` : "오른쪽에 열 삽입", onClick: () => insertColAt(at + count, count) },
            "separator",
            { label: "오름차순 정렬", onClick: () => sortBy(index, "asc") },
            { label: "내림차순 정렬", onClick: () => sortBy(index, "desc") },
            "separator",
            { label: count > 1 ? `${count}열 삭제` : "열 삭제", danger: true, onClick: () => removeColAt(at, count) },
          ] as MenuEntry[]),
    );
  };

  return (
    <div ref={rootRef} className="flex h-full bg-white">
      {/* 접힌 자리 — 다시 여는 단추는 **맨 위**, 도구 막대와 같은 높이에 둔다.
          세로 가운데에 두면 어느 줄에도 속하지 않은 단추처럼 떠 보인다. */}
      {!railOpen && (
        <div className="flex w-7 shrink-0 flex-col border-r border-slate-200 bg-slate-50">
          <button
            title="파일 목록 열기"
            onClick={() => setRailOpen(true)}
            className="flex h-9 w-full shrink-0 items-center justify-center border-b border-slate-200 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          >
            <IconChevronRight size={14} />
          </button>
        </div>
      )}
      <div className={`${railOpen ? "flex w-52" : "hidden"} shrink-0 flex-col border-r border-slate-200 bg-slate-50/70`}>
        <div className="flex h-9 shrink-0 items-center gap-1 border-b border-slate-200 px-2">
          <span className="flex-1 truncate text-[11px] font-bold uppercase tracking-wide text-slate-400">통합 문서</span>
          <button
            title="새 표"
            onClick={() => {
              setNameError("");
              setCreating((v) => !v);
            }}
            className="rounded p-1 text-slate-400 hover:bg-slate-200 hover:text-slate-600"
          >
            <IconAdd size={14} />
          </button>
          <button
            title="새로고침"
            onClick={() => ws.refresh()}
            className="rounded p-1 text-slate-400 hover:bg-slate-200 hover:text-slate-600"
          >
            <IconRefresh size={13} />
          </button>
          <button
            title="파일 목록 접기"
            onClick={() => setRailOpen(false)}
            className="rounded p-1 text-slate-400 hover:bg-slate-200 hover:text-slate-600"
          >
            <IconChevronLeft size={14} />
          </button>
        </div>
        {creating && (
          <div className="space-y-1.5 border-b border-slate-200 bg-white p-2">
            <input
              autoFocus
              className={`w-full rounded border px-2 py-1 text-xs ${nameError ? "border-red-400" : "border-slate-300"}`}
              value={newName}
              onFocus={(e) => selectFileStem(e.currentTarget)}
              onChange={(e) => {
                setNewName(e.target.value);
                setNameError("");
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) createSheet();
                if (e.key === "Escape") setCreating(false);
              }}
              placeholder="output/summary.csv"
            />
            {nameError && <p className="px-0.5 text-[11px] text-red-500">{nameError}</p>}
            <input
              className="w-full rounded border border-slate-300 px-2 py-1 text-xs"
              value={newHeader}
              onChange={(e) => setNewHeader(e.target.value)}
              placeholder="머리글 (쉼표로 구분)"
            />
            <div className="flex gap-1">
              <button
                onClick={createSheet}
                className="flex-1 rounded bg-emerald-700 px-2 py-1 text-xs font-semibold text-white hover:bg-emerald-600"
              >
                만들기
              </button>
              <button onClick={() => setCreating(false)} className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-500">
                취소
              </button>
            </div>
          </div>
        )}
        <div className="thin-scroll min-h-0 flex-1 overflow-y-auto py-1">
          {sheets.length === 0 && <p className="px-3 py-4 text-xs text-slate-400">표 파일이 없습니다. [+] 로 새로 만드세요.</p>}
          {sheets.map((p) => (
            <button
              key={p}
              onClick={() => openSheet(p)}
              onContextMenu={(e) =>
                openMenu(e, [
                  { label: "열기", onClick: () => openSheet(p) },
                  { label: "경로 복사", onClick: () => copyText(p) },
                  "separator",
                  { label: "삭제", danger: true, onClick: () => removeSheet(p) },
                ] as MenuEntry[])
              }
              className={`flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-xs ${
                p === path ? "bg-emerald-100 font-semibold text-emerald-900" : "text-slate-600 hover:bg-slate-200/60"
              }`}
            >
              <IconFileText size={12} />
              <span className="truncate">{p}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* 도구 막대 — 엑셀의 리본 자리. 함수는 없고, 표를 다루는 손만 있다. */}
        {/* 도구 막대 — 창을 줄여도 한 줄을 지킨다. 가운데만 가로로 밀리고 [저장] 은 늘 제자리다. */}
        <div className="flex h-9 shrink-0 items-center gap-1 border-b border-slate-200 bg-slate-50 px-2">
          <span className="mr-1 max-w-[200px] shrink-0 truncate text-xs font-semibold text-slate-700">
            {path ?? "표를 선택하세요"}
            {dirty && <span className="ml-1 text-amber-500">•</span>}
          </span>
          <div className="app-bar min-w-0 flex-1 gap-1">
          <ToolButton disabled={!path} title="되돌리기 (Ctrl+Z)" onClick={undo}>
            <IconReply size={13} />
          </ToolButton>
          <ToolButton disabled={!path} title="다시하기 (Ctrl+Shift+Z)" onClick={redo}>
            <span className="inline-block scale-x-[-1]">
              <IconReply size={13} />
            </span>
          </ToolButton>
          <span className="mx-1 h-4 w-px bg-slate-300" />
          <ToolButton disabled={!path} title="위에 행 삽입" onClick={() => insertRowAt(b.r1, b.r2 - b.r1 + 1)}>
            행 삽입
          </ToolButton>
          <ToolButton disabled={!path} title="왼쪽에 열 삽입" onClick={() => insertColAt(b.c1, b.c2 - b.c1 + 1)}>
            열 삽입
          </ToolButton>
          <ToolButton disabled={!path} title="고른 행 삭제" onClick={() => removeRowAt(b.r1, b.r2 - b.r1 + 1)}>
            행 삭제
          </ToolButton>
          <ToolButton disabled={!path} title="고른 열 삭제" onClick={() => removeColAt(b.c1, b.c2 - b.c1 + 1)}>
            열 삭제
          </ToolButton>
          <span className="mx-1 h-4 w-px bg-slate-300" />
          <ToolButton disabled={!path} title="이 열 오름차순" onClick={() => sortBy(range.focus.c, "asc")}>
            오름차순
          </ToolButton>
          <ToolButton disabled={!path} title="이 열 내림차순" onClick={() => sortBy(range.focus.c, "desc")}>
            내림차순
          </ToolButton>
          <ToolButton disabled={!path} title="아래로 채우기 (Ctrl+D)" onClick={() => apply(fillDown(dataRef.current, range), "")}>
            채우기
          </ToolButton>

          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {path && ws.isInitial(path) && (
              <button
                title="시나리오가 처음 제공한 내용으로 되돌립니다"
                disabled={saving}
                onClick={resetSheet}
                className="flex h-7 items-center gap-1 rounded-md border border-slate-300 bg-white px-2.5 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-40"
              >
                초기 내용
              </button>
            )}
            <button
              disabled={!path || saving}
              onClick={save}
              className="flex h-7 items-center gap-1 rounded-md bg-emerald-700 px-2.5 text-xs font-semibold text-white hover:bg-emerald-600 disabled:opacity-40"
            >
              <IconSave size={12} /> 저장
            </button>
          </div>
        </div>

        {/* 이름 상자 + 내용 줄 — 엑셀의 수식 입력줄 자리다. 함수는 없고 칸의 글자를 고친다. */}
        {path && (
          <div className="app-bar h-8 shrink-0 gap-0 border-b border-slate-200 bg-white px-2">
            <span className="flex h-6 w-24 shrink-0 items-center justify-center rounded border border-slate-300 bg-slate-50 text-[11px] font-semibold text-slate-600">
              {selectionLabel}
            </span>
            <span className="mx-2 select-none text-xs text-slate-300">|</span>
            <input
              className="h-6 min-w-0 flex-1 bg-transparent text-xs text-slate-700 outline-none"
              value={editing ? editing.value : focusValue}
              onChange={(e) => {
                if (editing) props_setEditValue(setEditing, e.target.value);
                else setEditing({ cell: range.focus, value: e.target.value, replace: false });
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  commitEdit("down");
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  cancelEdit();
                }
              }}
              placeholder="칸 내용"
            />
          </div>
        )}

        {path && status?.kind === "conflict" && (
          <ConflictBar deleted={status.deleted} onKeepMine={keepMine} onLoadServer={loadServer} />
        )}
        {reloaded && (
          <div className="shrink-0 border-b border-sky-200 bg-sky-50 px-3 py-1 text-[11px] text-sky-800">
            이 파일이 밖에서 바뀌어 새로 읽었습니다.
          </div>
        )}

        {path ? (
          <div className="relative flex min-h-0 flex-1 flex-col" onMouseDown={() => !editingRef.current && focusGrid()}>
            {/* 보이지 않는 입력이 격자의 포커스를 든다 — 키·복사·붙여넣기가 모두 여기로 온다.
                화면에서 지우지 않고 1px 로 숨기는 이유는, display:none 이면 포커스를 받을 수 없어서다. */}
            <textarea
              ref={proxyRef}
              className="odycell-proxy"
              aria-label="표 격자"
              value=""
              readOnly
              onKeyDown={onKeyDown}
              onCopy={onCopy}
              onCut={onCut}
              onPaste={onPaste}
            />
            <Grid
              data={data}
              onViewport={setViewport}
              rows={rows}
              cols={cols}
              range={range}
              editing={editing}
              colWidths={colWidths}
              frozenHeader
              onSelect={select}
              onDragTo={dragTo}
              onSelectRow={selectRow}
              onSelectCol={selectCol}
              onSelectAll={selectAll}
              onBeginEdit={beginEdit}
              onEditChange={(v) => props_setEditValue(setEditing, v)}
              onCommitEdit={commitEdit}
              onCancelEdit={cancelEdit}
              onResizeCol={(c, w) => setColWidths((prev) => ({ ...prev, [c]: w }))}
              onHeaderMenu={headerMenu}
              onCellMenu={cellMenu}
            />
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center text-xs text-slate-400">
            왼쪽에서 표 파일을 고르거나 새로 만드세요.
          </div>
        )}

        {/* 시트 탭 — 엑셀의 아래쪽 탭 자리. 우리에게 한 시트는 한 파일이다.
            목록을 접어도 여기서 바꿀 수 있어야 접기가 쓸모 있는 기능이 된다. */}
        <div className="odycell-tabs app-bar h-8 shrink-0 items-end gap-0.5 border-t border-slate-200 bg-slate-100 px-2">
          {sheets.map((p2) => (
            <button
              key={p2}
              onClick={() => openSheet(p2)}
              onContextMenu={(e) =>
                openMenu(e, [
                  { label: "경로 복사", onClick: () => copyText(p2) },
                  "separator",
                  { label: "삭제", danger: true, onClick: () => removeSheet(p2) },
                ] as MenuEntry[])
              }
              title={p2}
              data-active={p2 === path ? "true" : undefined}
              className="odycell-tab"
            >
              {p2.split("/").pop()}
            </button>
          ))}
          <button
            title="새 표"
            onClick={() => {
              setRailOpen(true);
              setNameError("");
              setCreating(true);
            }}
            className="mb-0.5 ml-1 rounded px-1.5 py-1 text-slate-400 hover:bg-slate-200 hover:text-slate-600"
          >
            <IconAdd size={13} />
          </button>
        </div>

        <div className="app-bar h-7 shrink-0 gap-4 border-t border-slate-200 bg-slate-50 px-3 text-[11px] text-slate-500">
          <span>
            {data.length}행 × {gridWidth(data)}열
          </span>
          {path && <span>선택 {selectionLabel}</span>}
          {/* 엑셀도 한 칸만 골랐을 때는 아무 말을 하지 않는다 — 셈은 여럿을 골랐을 때 쓸모가 있다 */}
          {multi && stats.cells > 0 && <span>개수 {stats.cells}</span>}
          {multi && stats.numbers > 0 && (
            <>
              <span>합계 {formatNumber(stats.sum)}</span>
              <span>평균 {formatNumber(stats.avg)}</span>
            </>
          )}
          <span className="ml-auto">{path ? saveStatusText(status, saver.lastSavedAt(path)) : ""}</span>
        </div>
      </div>

      <ContextMenuView menu={menu} onClose={closeMenu} />
    </div>
  );
}

/** 편집 중인 값만 갈아 끼운다 — 칸 위치는 그대로. */
function props_setEditValue(set: (fn: (prev: EditState | null) => EditState | null) => void, value: string) {
  set((prev) => (prev ? { ...prev, value } : prev));
}

function ToolButton({
  children,
  disabled,
  title,
  onClick,
}: {
  children: React.ReactNode;
  disabled?: boolean;
  title: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className="flex h-7 items-center gap-1 rounded-md px-2 text-xs text-slate-600 hover:bg-slate-200/70 disabled:opacity-40"
    >
      {children}
    </button>
  );
}

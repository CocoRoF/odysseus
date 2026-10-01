"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError } from "@/lib/api";
import { Markdown } from "@/components/Markdown";
import { useToast } from "@/components/toast";
import { copyText, selectedText } from "@/lib/clipboard";
import {
  IconAdd,
  IconDelete,
  IconFileText,
  IconChevronLeft,
  IconChevronRight,
  IconRefresh,
  IconReply,
  IconSave,
  IconView,
} from "@/components/icons";
import { saveStatusText } from "@/lib/autosave";
import { ContextMenuView, MenuEntry, useContextMenu } from "../ContextMenu";
import { History, undoRedoIntent } from "@/lib/history";
import { caretPosition, mirrorScroll, onEnter, onTab } from "@/lib/markdown-edit";
import { checkNewPath, isKeepPath, selectFileStem, useWorkspaceAs } from "../workspace";
import { useFileSaver } from "../useFileSaver";
import { ConflictBar } from "./ConflictBar";

/** 문서로 다룰 확장자 — 보고서·회의록·공지문은 전부 여기에 들어간다. */
const DOC_EXTS = new Set(["md", "markdown", "txt"]);

function isDoc(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return DOC_EXTS.has(ext);
}

/** 단어 수 — 서버의 file_min_words 체크와 같은 규칙(글자가 있는 공백 토큰만 센다). */
function countWords(text: string): number {
  return text
    .split(/\s+/)
    .filter((t) => /[0-9A-Za-z가-힣]/.test(t)).length;
}

interface Template {
  key: string;
  label: string;
  body: string;
}

const TEMPLATES: Template[] = [
  {
    key: "blank",
    label: "빈 문서",
    body: "",
  },
  {
    key: "report",
    label: "보고서",
    body: `# 제목

작성자:
작성일:

## 1. 요약

## 2. 현황과 분석

## 3. 결론 및 제안
`,
  },
  {
    key: "minutes",
    label: "회의록",
    body: `# 회의록

- 일시:
- 장소:
- 참석자:
- 작성자:

## 논의 및 결정사항

## 보류 / 다음 논의

## 액션 아이템

| 담당 | 내용 | 기한 |
|---|---|---|
|  |  |  |

## 다음 회의
`,
  },
  {
    key: "notice",
    label: "공지·안내문",
    body: `# [공지] 제목

안녕하세요. OOO입니다.

## 안내 내용

## 조치 사항

## 문의

문의: 
`,
  },
  {
    key: "mail",
    label: "메일 초안",
    body: `# 제목

OOO 님께,

안녕하세요. OOO입니다.

(본문)

감사합니다.
OOO 드림
`,
  },
];

type ViewMode = "edit" | "split" | "preview";

/** 문서 편집기 — 워크스페이스의 문서 파일을 쓰고 다듬는 앱.
 *
 *  IDE 가 코드를 위한 도구인 것처럼, 이 앱은 보고서·회의록·공지문을 위한 도구다.
 *  같은 워크스페이스 파일을 다루므로 여기서 저장한 문서는 폴더·에이전트·채점이
 *  그대로 본다. 서식 도구는 마크다운을 넣어 주고, 상태바의 단어 수는 서버의
 *  분량 체크와 같은 방식으로 센다.
 */
interface DocStep {
  text: string;
  caret: number;
}

export function DocsApp({ winId }: { winId: string }) {
  const ws = useWorkspaceAs("docs");
  const { toast, confirm } = useToast();
  const { menu, open: openMenu, close: closeMenu } = useContextMenu();

  // 자동 저장·제출 전 저장·충돌·재시도 — IDE·문서·표가 같은 규칙을 쓴다 (lib/autosave)
  const saver = useFileSaver(ws);
  const [path, setPath] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [view, setView] = useState<ViewMode>("split");
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("output/새 문서.md");
  const [nameError, setNameError] = useState("");
  const [newTemplate, setNewTemplate] = useState("report");
  const areaRef = useRef<HTMLTextAreaElement>(null);
  /** 되돌리기 이력 — 서식 도구가 글을 프로그램으로 바꾸는 순간 브라우저의 기본 되돌리기는 끊긴다.
   *  (textarea 의 기본 이력은 사용자의 입력만 기억한다.) 그래서 글과 커서를 함께 우리가 기억한다. */
  const history = useRef(new History<DocStep>({ text: "", caret: 0 }));
  /** 문서 목록을 펼쳐 두었는가 — 글을 쓰는 동안에는 넓을수록 좋다 */
  const [railOpen, setRailOpen] = useState(true);
  /** 커서가 놓인 줄·칸 — 편집기라면 상태 표시줄이 알려 주는 것 */
  const [caret, setCaret] = useState({ line: 1, column: 1 });
  /** 분할 화면에서 미리보기가 따라갈 곳 */
  const previewRef = useRef<HTMLDivElement>(null);

  /** 파일을 새로 읽었다 — 이력을 통째로 새로 시작한다. 되돌리기가 앞 파일로 넘어가면 안 된다. */
  const loadText = useCallback((content: string) => {
    history.current.reset({ text: content, caret: content.length });
    setText(content);
  }, []);

  const pathRef = useRef(path);
  pathRef.current = path;
  /** 응시자가 고른 파일을 여는 중 — 아래의 "첫 문서를 보여 준다" 가 그 위를 덮지 않게 한다 */
  const openingRef = useRef(false);

  const docs = useMemo(
    () => ws.files.filter((f) => isDoc(f.path) && !isKeepPath(f.path)).map((f) => f.path).sort(),
    [ws.files],
  );

  const status = path ? saver.status(path) : null;
  const dirty = path ? saver.isDirty(path) : false;
  const saving = status?.kind === "saving";

  /** 다른 문서로 옮기기 전에 지금 문서를 저장한다. 저장하지 못했으면 이름을 대고 묻는다 —
   *  예전에는 자동 저장 2초 틈에 다른 문서를 열면 마지막 문장이 사라졌다. */
  const leaveCurrent = useCallback(async () => {
    const cur = pathRef.current;
    if (!cur) return true;
    if (!(await saver.flushOne(cur))) {
      const ok = await confirm({
        title: "저장하지 못한 편집이 있습니다",
        message: (
          <>
            <b>{cur}</b> — 다른 문서를 열면 이 편집은 사라집니다.
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

  /** 이 창에서 문서 하나를 연다.
   *
   *  이미 **다른 문서 창**이 그 파일을 들고 있으면 열지 않고 그 창을 앞으로 가져온다.
   *  같은 파일을 두 창에 띄우면 한쪽에서 고칠 때마다 다른 쪽이 충돌 띠를 만나 어느 편집을
   *  버릴지 고르게 된다 — 시험 중에 겪을 일이 아니다. 아예 두 번 열리지 않게 한다. */
  const openDoc = useCallback(
    async (target: string) => {
      if (target === pathRef.current) return;
      const owner = ws.fileOwner(target, winId);
      if (owner) {
        ws.focusWindow(owner);
        toast("이 문서는 이미 다른 문서 창에 열려 있습니다", "info");
        return;
      }
      // 기다리기 **전에** 찜한다. 문서 창 두 개가 같은 렌더에서 "첫 문서 보여 주기" 를 돌면
      // 둘 다 await 에서 양보한 뒤에 찜하게 되어, 점유 검사를 나란히 통과하고 같은 파일을 연다.
      ws.claimFile(winId, target);
      if (!(await leaveCurrent())) {
        ws.claimFile(winId, pathRef.current);
        return;
      }
      try {
        const fc = await ws.loadContent(target);
        saver.open(target, fc.content, fc.sha256);
        setPath(target);
        loadText(fc.content);
      } catch {
        ws.claimFile(winId, null);
        setPath(null);
        loadText("");
        toast("문서를 열 수 없습니다", "error");
      }
    },
    [ws, toast, saver, leaveCurrent, winId],
  );

  // 폴더/뷰어에서 "문서로 열기" 요청이 오면 그 파일을 연다.
  // take 는 원자적이라, 문서 창이 여럿이어도 **한 창만** 가져간다.
  useEffect(() => {
    if (!ws.pendingDocsOpen) return;
    const wanted = ws.takeDocsOpen();
    if (!wanted) return;
    openingRef.current = true;
    openDoc(wanted).finally(() => {
      openingRef.current = false;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws.pendingDocsOpen]);

  // 처음 열었을 때 문서가 하나라도 있으면 첫 문서를 보여 준다 (빈 화면보다 낫다).
  // 다른 창이 이미 든 문서는 건너뛴다. 응시자가 고른 파일을 여는 중이면 비켜 준다 —
  // 두 효과가 같은 마운트에서 함께 돌아, 고른 파일 대신 목록의 첫 파일이 열리곤 했다.
  useEffect(() => {
    if (path !== null || openingRef.current || ws.pendingDocsOpen) return;
    const free = docs.find((d) => !ws.fileOwner(d, winId));
    if (free) openDoc(free);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docs.length]);

  // 이 창이 든 파일을 등록부와 맞춰 둔다. 창을 닫으면(언마운트) 놓는다.
  useEffect(() => {
    ws.claimFile(winId, path);
    return () => ws.claimFile(winId, null);
  }, [ws.claimFile, winId, path]);

  const save = useCallback(async () => {
    if (!path) return;
    if (!(await saver.save(path))) toast(saveStatusText(saver.status(path)) || "저장에 실패했습니다", "error");
  }, [path, saver, toast]);

  // 편집은 저장기에 알린다 — 멈추면 저장하고, 쓰는 중이면 끝난 뒤 최신 내용으로 한 번 더 쓴다
  useEffect(() => {
    if (path) saver.edit(path, text);
  }, [path, text, saver]);

  // 밖에서 바뀐 문서 — 편집하지 않았으면 새 내용으로 맞추고, 편집 중이면 자동 저장을 멈추고 고르게 한다
  useEffect(() => {
    const cur = pathRef.current;
    const entry = cur ? ws.files.find((f) => f.path === cur) : undefined;
    if (!cur || !entry?.sha256 || saver.noteServerVersion(cur, entry.sha256) !== "reload") return;
    ws.loadContent(cur)
      .then((fc) => {
        if (pathRef.current !== cur || saver.isDirty(cur)) return;
        saver.open(cur, fc.content, fc.sha256);
        loadText(fc.content);
      })
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws.files]);

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
      saver.open(cur, fc.content, fc.sha256);
      loadText(fc.content);
    } catch {
      saver.close(cur);
      setPath(null);
      loadText("");
    }
  };

  /** 초기 내용으로 되돌리기 — 시나리오가 처음 준 문서가 원본이다. 자동 저장이 되돌린 내용을
   *  덮지 않도록 먼저 dirty 를 내려 예약된 저장을 취소한다. */
  const resetDoc = async () => {
    if (!path || !ws.isInitial(path)) return;
    const ok = await confirm({
      title: "초기 내용으로 되돌릴까요?",
      message: (
        <>
          <b>{path}</b> 를 시나리오가 처음 제공한 내용으로 되돌립니다. 지금까지 이 문서에 한 수정은
          사라집니다.
        </>
      ),
      danger: true,
      confirmLabel: "되돌리기",
    });
    if (!ok) return;
    saver.discard(path); // 예약된 저장이 되돌린 내용을 덮지 않게
    try {
      await ws.resetFile(path);
      const fc = await ws.loadContent(path);
      saver.open(path, fc.content, fc.sha256);
      loadText(fc.content);
      toast("초기 내용으로 되돌렸습니다", "success");
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "되돌리기에 실패했습니다", "error");
    }
  };

  // 다른 앱(폴더·IDE)에서 되돌렸으면 보고 있던 문서도 그 내용으로 맞춘다 — 되돌리기는 편집보다 우선한다
  useEffect(
    () =>
      ws.subscribeChanges(({ scope, paths }) => {
        const cur = pathRef.current;
        if (!cur) return;
        if (scope !== "all" && !paths.includes(cur)) return;
        saver.discard(cur);
        ws.loadContent(cur)
          .then((fc) => {
            saver.open(cur, fc.content, fc.sha256);
            loadText(fc.content);
          })
          .catch(() => {
            // 전체 초기화로 사라진 문서 — 빈 화면으로
            saver.close(cur);
            setPath(null);
            loadText("");
          });
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ws.subscribeChanges, ws.loadContent],
  );

  /** 글을 바꾸는 단 하나의 통로 — 이력에 걸음을 남긴다.
   *
   *  ``label`` 이 같고 시간이 가까우면 한 걸음으로 묶인다(lib/history). 타이핑은 "type" 하나로 묶고,
   *  서식 도구는 저마다 다른 이름을 써서 한 번 누른 것이 한 번에 되돌아가게 한다.
   */
  const edit = useCallback((next: string, caret: number, label: string) => {
    history.current.push({ text: next, caret }, label);
    setText(next);
  }, []);

  /** 이력의 한 걸음을 화면에 올린다 — 커서까지 되돌려야 사람이 이어서 칠 수 있다. */
  const applyStep = useCallback((step: DocStep) => {
    setText(step.text);
    requestAnimationFrame(() => {
      const el = areaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(step.caret, step.caret);
    });
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const mod = e.ctrlKey || e.metaKey;
    const intent = undoRedoIntent(e);
    if (intent) {
      e.preventDefault();
      history.current.seal();
      applyStep(intent === "undo" ? history.current.undo() : history.current.redo());
      return;
    }
    if (mod && e.key.toLowerCase() === "s") {
      e.preventDefault();
      save();
      return;
    }
    // 문서 프로그램의 관습 — 굵게·기울임은 어디서나 Ctrl+B·Ctrl+I 다.
    if (mod && e.key.toLowerCase() === "b") {
      e.preventDefault();
      applyFormat("bold");
      return;
    }
    if (mod && e.key.toLowerCase() === "i") {
      e.preventDefault();
      applyFormat("italic");
      return;
    }

    const el = areaRef.current;
    if (!el || mod || e.altKey) return;

    // Tab 이 포커스를 뺏지 않는다. 고른 줄을 들여쓰거나 내어쓰고, 고른 것이 없으면 공백을 넣는다.
    if (e.key === "Tab") {
      e.preventDefault();
      const r = onTab(text, el.selectionStart, el.selectionEnd, e.shiftKey);
      edit(r.text, r.caret, "");
      restoreSelection(r.caret, r.selectionEnd ?? r.caret);
      return;
    }

    // Enter 가 목록을 이어 준다. 빈 항목에서는 목록을 끝낸다.
    if (e.key === "Enter" && !e.nativeEvent.isComposing && el.selectionStart === el.selectionEnd) {
      const r = onEnter(text, el.selectionStart);
      if (r) {
        e.preventDefault();
        edit(r.text, r.caret, "");
        restoreSelection(r.caret, r.caret);
      }
    }
  };

  /** 글을 바꾼 뒤 커서를 제자리에 돌려놓는다 — React 가 값을 다시 심으면 커서가 끝으로 튄다. */
  const restoreSelection = (start: number, end: number) => {
    requestAnimationFrame(() => {
      const el = areaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(start, end);
      setCaret(caretPosition(el.value, start));
    });
  };

  /** 선택 영역을 감싸거나 줄 앞에 표식을 붙인다 (마크다운 서식 도구). */
  const applyFormat = (kind: string) => {
    const el = areaRef.current;
    if (!el) return;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const before = text.slice(0, start);
    const selected = text.slice(start, end);
    const after = text.slice(end);
    const lineStart = before.lastIndexOf("\n") + 1;

    let next = text;
    let caret = end;
    if (kind === "bold" || kind === "italic") {
      const mark = kind === "bold" ? "**" : "*";
      const body = selected || (kind === "bold" ? "굵게" : "기울임");
      next = `${before}${mark}${body}${mark}${after}`;
      caret = start + mark.length + body.length + mark.length;
    } else if (kind.startsWith("h")) {
      const hashes = "#".repeat(Number(kind.slice(1)));
      const head = text.slice(lineStart, start);
      next = `${text.slice(0, lineStart)}${hashes} ${head.replace(/^#+\s*/, "")}${text.slice(start)}`;
      caret = start + hashes.length + 1;
    } else if (kind === "list" || kind === "numbered" || kind === "quote") {
      const prefix = kind === "list" ? "- " : kind === "numbered" ? "1. " : "> ";
      const body = (selected || "").split("\n").map((l) => `${prefix}${l}`).join("\n");
      next = `${before}${selected ? body : prefix}${after}`;
      caret = start + (selected ? body.length : prefix.length);
    } else if (kind === "table") {
      const table = "\n| 항목 | 값 |\n|---|---|\n|  |  |\n";
      next = `${before}${table}${after}`;
      caret = start + table.length;
    } else if (kind === "divider") {
      next = `${before}\n---\n${after}`;
      caret = start + 5;
    }
    edit(next, caret, `format:${kind}`);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(caret, caret);
    });
  };

  const createDoc = async () => {
    const checked = checkNewPath(newName, [...DOC_EXTS]);
    if ("error" in checked) {
      setNameError(checked.error);
      return;
    }
    const target = checked.path;
    if (ws.files.some((f) => f.path === target)) {
      setNameError("같은 이름의 파일이 이미 있습니다");
      return;
    }
    const body = TEMPLATES.find((t) => t.key === newTemplate)?.body ?? "";
    if (!(await leaveCurrent())) return;
    try {
      const created = await ws.saveContent(target, body);
      saver.open(target, body, created.sha256);
      ws.claimFile(winId, target);
      setCreating(false);
      setNameError("");
      setPath(target);
      loadText(body);
      toast("새 문서를 만들었습니다", "success");
    } catch {
      toast("문서를 만들 수 없습니다", "error");
    }
  };

  const removeDoc = async (target: string) => {
    const ok = await confirm({
      title: "문서를 삭제할까요?",
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
        loadText("");
      }
    } catch {
      toast("삭제에 실패했습니다", "error");
    }
  };

  const words = countWords(text);
  const chars = text.length;
  const charsNoSpace = text.replace(/\s/g, "").length;
  const lines = text ? text.split("\n").length : 0;

  const toolButton = "flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium text-slate-600 hover:bg-slate-200/70";

  return (
    <div className="flex h-full bg-white">
      {/* 접힌 자리 — 다시 여는 단추는 **맨 위**, 도구 막대와 같은 높이에 둔다. */}
      {!railOpen && (
        <div className="flex w-7 shrink-0 flex-col border-r border-slate-200 bg-slate-50">
          <button
            title="문서 목록 열기"
            onClick={() => setRailOpen(true)}
            className="flex h-9 w-full shrink-0 items-center justify-center border-b border-slate-200 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          >
            <IconChevronRight size={14} />
          </button>
        </div>
      )}
      {/* 문서 목록 */}
      <div className={`${railOpen ? "flex w-56" : "hidden"} shrink-0 flex-col border-r border-slate-200 bg-slate-50/70`}>
        <div className="flex h-9 shrink-0 items-center gap-1 border-b border-slate-200 px-2">
          <span className="flex-1 truncate text-[11px] font-bold uppercase tracking-wide text-slate-400">문서</span>
          <button
            title="새 문서"
            onClick={() => {
              setNameError("");
              setCreating((v) => !v);
            }}
            className="rounded p-1 text-slate-400 hover:bg-slate-200 hover:text-slate-600"
          >
            <IconAdd size={14} />
          </button>
          <button title="새로고침" onClick={() => ws.refresh()} className="rounded p-1 text-slate-400 hover:bg-slate-200 hover:text-slate-600">
            <IconRefresh size={13} />
          </button>
          <button
            title="문서 목록 접기"
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
              className={`w-full rounded border px-2 py-1 text-xs ${
                nameError ? "border-red-400" : "border-slate-300"
              }`}
              value={newName}
              // 처음 들어오면 "새 문서" 부분만 골라 둔다 — 폴더와 확장자는 두고 이름만 덮어쓰게.
              onFocus={(e) => selectFileStem(e.currentTarget)}
              onChange={(e) => {
                setNewName(e.target.value);
                setNameError("");
              }}
              // 한글은 마지막 글자를 확정할 때도 Enter 를 쓴다. 그 Enter 를 [만들기] 로 받으면
              // 아직 조합 중인 이름으로 파일이 만들어진다. 조합 중에는 넘긴다.
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) createDoc();
                if (e.key === "Escape") setCreating(false);
              }}
              placeholder="output/report.md"
            />
            {nameError && <p className="px-0.5 text-[11px] text-red-500">{nameError}</p>}
            <select
              className="w-full rounded border border-slate-300 px-2 py-1 text-xs"
              value={newTemplate}
              onChange={(e) => setNewTemplate(e.target.value)}
            >
              {TEMPLATES.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.label} 서식
                </option>
              ))}
            </select>
            <div className="flex gap-1">
              <button onClick={createDoc} className="flex-1 rounded bg-slate-800 px-2 py-1 text-xs font-semibold text-white hover:bg-slate-700">
                만들기
              </button>
              <button onClick={() => setCreating(false)} className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-500">
                취소
              </button>
            </div>
          </div>
        )}
        <div className="thin-scroll min-h-0 flex-1 overflow-y-auto py-1">
          {docs.length === 0 && <p className="px-3 py-4 text-xs text-slate-400">문서가 없습니다. [+] 로 새로 만드세요.</p>}
          {docs.map((p) => (
            <button
              key={p}
              onClick={() => openDoc(p)}
              onContextMenu={(e) =>
                openMenu(e, [
                  { label: "열기", onClick: () => openDoc(p) },
                  { label: "경로 복사", onClick: () => copyText(p) },
                  "separator",
                  { label: "삭제", danger: true, onClick: () => removeDoc(p) },
                ] as MenuEntry[])
              }
              className={`flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-xs ${
                p === path ? "bg-sky-100 font-semibold text-sky-900" : "text-slate-600 hover:bg-slate-200/60"
              }`}
            >
              <IconFileText size={12} />
              <span className="truncate">{p}</span>
            </button>
          ))}
        </div>
      </div>

      {/* 본문 */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* 도구 막대 — 창을 줄여도 한 줄을 지킨다. 가운데(서식)만 가로로 밀리고, 파일 이름과
            오른쪽의 [저장] 은 늘 제자리다. 저장이 화면 밖으로 밀리면 그건 도구 막대가 아니다. */}
        <div className="flex h-9 shrink-0 items-center gap-1 border-b border-slate-200 px-2">
          <span className="mr-1 max-w-[240px] shrink-0 truncate text-xs font-semibold text-slate-700">
            {path ?? "문서를 선택하세요"}
            {dirty && <span className="ml-1 text-amber-500">•</span>}
          </span>
          <div className="app-bar min-w-0 flex-1 gap-1">
          {path && (
            <>
              <button title="제목 1" className={toolButton} onClick={() => applyFormat("h1")}>
                제목1
              </button>
              <button title="제목 2" className={toolButton} onClick={() => applyFormat("h2")}>
                제목2
              </button>
              <button title="굵게 (Ctrl+B)" className={`${toolButton} font-bold`} onClick={() => applyFormat("bold")}>
                B
              </button>
              <button title="기울임 (Ctrl+I)" className={`${toolButton} italic`} onClick={() => applyFormat("italic")}>
                I
              </button>
              <button title="글머리 목록 — Enter 로 이어지고, Tab 으로 한 단 들어갑니다" className={toolButton} onClick={() => applyFormat("list")}>
                목록
              </button>
              <button title="번호 목록 — 번호는 저절로 이어집니다" className={toolButton} onClick={() => applyFormat("numbered")}>
                번호
              </button>
              <button title="인용" className={toolButton} onClick={() => applyFormat("quote")}>
                인용
              </button>
              <button title="표 넣기" className={toolButton} onClick={() => applyFormat("table")}>
                표
              </button>
              <button title="구분선" className={toolButton} onClick={() => applyFormat("divider")}>
                구분선
              </button>
            </>
          )}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <div className="flex overflow-hidden rounded-md border border-slate-300">
              {(["edit", "split", "preview"] as ViewMode[]).map((m) => (
                <button
                  key={m}
                  onClick={() => setView(m)}
                  className={`px-2 py-1 text-[11px] font-medium ${
                    view === m ? "bg-slate-700 text-white" : "bg-white text-slate-500 hover:bg-slate-100"
                  }`}
                >
                  {m === "edit" ? "편집" : m === "split" ? "분할" : "미리보기"}
                </button>
              ))}
            </div>
            {path && ws.isInitial(path) && (
              <button
                title="시나리오가 처음 제공한 내용으로 되돌립니다"
                disabled={saving}
                onClick={resetDoc}
                className="flex h-7 items-center gap-1 rounded-md border border-slate-300 bg-white px-2.5 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-40"
              >
                <IconReply size={12} /> 되돌리기
              </button>
            )}
            <button
              disabled={!path || saving}
              onClick={save}
              className="flex h-7 items-center gap-1 rounded-md bg-slate-800 px-2.5 text-xs font-semibold text-white hover:bg-slate-700 disabled:opacity-40"
            >
              <IconSave size={12} /> 저장
            </button>
          </div>
        </div>

        {path && status?.kind === "conflict" && (
          <ConflictBar deleted={status.deleted} onKeepMine={keepMine} onLoadServer={loadServer} />
        )}
        <div className="flex min-h-0 flex-1">
          {view !== "preview" && (
            <textarea
              ref={areaRef}
              value={text}
              disabled={!path}
              onChange={(e) => edit(e.target.value, e.target.selectionStart, "type")}
              onKeyDown={onKeyDown}
              onSelect={(e) => setCaret(caretPosition(text, e.currentTarget.selectionStart))}
              onScroll={(e) => {
                // 미리보기가 편집기를 따라간다 — 아래를 고치는데 위가 보이면 분할이 무슨 소용인가
                const box = previewRef.current;
                if (!box || view !== "split") return;
                const ratio = mirrorScroll(e.currentTarget);
                box.scrollTop = ratio * Math.max(0, box.scrollHeight - box.clientHeight);
              }}
              onContextMenu={(e) => {
                const sel = selectedText();
                const items: MenuEntry[] = [];
                if (sel) items.push({ label: "선택 영역 복사", onClick: () => copyText(sel) });
                items.push({ label: "전체 복사", onClick: () => copyText(text) });
                if (path) items.push({ label: "저장", shortcut: "Ctrl+S", onClick: () => save() });
                openMenu(e, items);
              }}
              spellCheck={false}
              placeholder={path ? "여기에 문서를 작성하세요." : ""}
              className={`thin-scroll h-full ${view === "split" ? "w-1/2 border-r border-slate-200" : "w-full"} resize-none p-5 font-sans text-[13px] leading-7 text-slate-800 outline-none disabled:bg-slate-50`}
            />
          )}
          {view !== "edit" && (
            <div
              ref={previewRef}
              className={`thin-scroll h-full overflow-y-auto bg-white p-5 ${view === "split" ? "w-1/2" : "w-full"}`}
            >
              {text.trim() ? (
                <Markdown>{text}</Markdown>
              ) : (
                <p className="flex h-full items-center justify-center text-xs text-slate-300">
                  <IconView size={14} />
                  <span className="ml-1.5">미리보기</span>
                </p>
              )}
            </div>
          )}
        </div>

        {/* 상태바 — 분량은 채점 기준과 같은 방식으로 센다 */}
        <div className="app-bar h-7 shrink-0 gap-4 border-t border-slate-200 bg-slate-50 px-3 text-[11px] text-slate-500">
          <span>단어 {words.toLocaleString("ko-KR")}</span>
          <span>글자 {chars.toLocaleString("ko-KR")}</span>
          <span>공백 제외 {charsNoSpace.toLocaleString("ko-KR")}</span>
          <span>{lines}줄</span>
          {/* 커서 자리 — 편집기라면 알려 주는 것. 긴 글에서 "어디쯤인가" 를 셀 수 있어야 한다. */}
          {path && view !== "preview" && (
            <span>
              {caret.line}:{caret.column}
            </span>
          )}
          <span className="ml-auto">{path ? saveStatusText(status, saver.lastSavedAt(path)) : ""}</span>
        </div>
      </div>

      <ContextMenuView menu={menu} onClose={closeMenu} />
    </div>
  );
}

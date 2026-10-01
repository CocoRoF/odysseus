/** 마크다운을 **글로 쓰는 동안** 편집기가 대신 해 주어야 하는 일들.
 *
 *  평범한 textarea 로 마크다운을 쓰면 세 곳에서 매번 걸린다.
 *
 *  1. **Tab 을 누르면 포커스가 나간다.** 글을 쓰다가 목록을 한 단 들여쓰려던 손이 도구 막대로 날아간다.
 *  2. **Enter 가 목록을 이어 주지 않는다.** `- ` 를 줄마다 손으로 친다. 회의록처럼 목록이 중심인 글에서
 *     이게 가장 크다. 반대로 빈 항목에서 Enter 를 치면 목록을 끝내야 한다 — 안 그러면 `- ` 만 남는다.
 *  3. **번호 목록의 번호를 사람이 센다.** 1. 다음은 2. 여야 한다.
 *
 *  화면 없이 성립하는 계산이므로 여기 모아 두고 테스트로 규칙을 지킨다. 모든 함수는 새 글과 새 커서
 *  자리를 함께 돌려준다 — 편집기는 그 둘을 그대로 반영하면 된다.
 */

export interface EditResult {
  text: string;
  /** 반영한 뒤 커서를 둘 자리 */
  caret: number;
  /** 고를 영역이 있으면 (들여쓰기처럼 여러 줄을 다룰 때) */
  selectionEnd?: number;
}

const INDENT = "  ";

/** 커서가 놓인 줄의 시작·끝 위치 */
export function lineRange(text: string, at: number): { start: number; end: number } {
  const start = text.lastIndexOf("\n", Math.max(0, at - 1)) + 1;
  const nl = text.indexOf("\n", at);
  return { start, end: nl === -1 ? text.length : nl };
}

/** 줄 앞의 목록 표식을 읽는다. 목록이 아니면 null. */
export function listMarker(line: string): {
  indent: string;
  /** 다음 줄에 붙일 표식 ("- ", "1. ", "> ") */
  marker: string;
  /** 표식 뒤에 내용이 있는가 */
  filled: boolean;
} | null {
  const bullet = /^(\s*)([-*+])\s+(\[[ xX]\]\s+)?(.*)$/.exec(line);
  if (bullet) {
    const [, indent, sign, task, rest] = bullet;
    // 체크 목록은 다음 줄도 빈 상자로 이어 준다 — 회의록의 액션 아이템에서 흔하다.
    const marker = task ? `${sign} [ ] ` : `${sign} `;
    return { indent, marker, filled: rest.trim() !== "" };
  }
  const numbered = /^(\s*)(\d+)([.)])\s+(.*)$/.exec(line);
  if (numbered) {
    const [, indent, n, dot, rest] = numbered;
    return { indent, marker: `${Number(n) + 1}${dot} `, filled: rest.trim() !== "" };
  }
  const quote = /^(\s*)(>\s+)(.*)$/.exec(line);
  if (quote) {
    const [, indent, sign, rest] = quote;
    return { indent, marker: sign, filled: rest.trim() !== "" };
  }
  return null;
}

/** Enter — 목록 안이면 다음 항목을 이어 주고, 빈 항목이면 목록을 끝낸다. */
export function onEnter(text: string, caret: number): EditResult | null {
  const { start } = lineRange(text, caret);
  const line = text.slice(start, caret);
  const found = listMarker(line);
  if (!found) return null;
  if (!found.filled) {
    // 빈 항목에서 Enter — 표식을 걷어내고 목록을 끝낸다 (워드·노션과 같은 규칙)
    const next = text.slice(0, start) + text.slice(caret);
    return { text: next, caret: start };
  }
  const insert = `\n${found.indent}${found.marker}`;
  return {
    text: text.slice(0, caret) + insert + text.slice(caret),
    caret: caret + insert.length,
  };
}

/** Tab / Shift+Tab — 고른 줄을 들여쓰거나 내어쓴다. 고른 것이 없으면 그 자리에 공백을 넣는다. */
export function onTab(text: string, start: number, end: number, outdent: boolean): EditResult {
  const first = lineRange(text, start).start;
  // 고른 영역이 **다음 줄 첫머리에서 끝나면** 그 줄은 건드리지 않는다. 세 줄을 고르려고 마지막 줄
  // 끝에서 손을 뗐을 뿐인데 네 번째 줄까지 들여쓰이면 매번 되돌려야 한다 (편집기의 관습).
  const stop = end > start && lineRange(text, end).start === end ? end - 1 : end;
  const last = lineRange(text, stop).end;
  const block = text.slice(first, last);
  // 목록 안에서는 커서가 어디에 있든 **항목 전체**가 한 단 들어간다. 글을 쓰다가 "이건 하위 항목이네"
  // 싶어 Tab 을 누르는 것이지, 그 자리에 공백을 넣으려는 것이 아니다 (노션·옵시디언과 같은 규칙).
  const inList = listMarker(text.slice(first, lineRange(text, start).end)) !== null;
  const multi = start !== end || outdent || inList;

  if (!multi) {
    return { text: text.slice(0, start) + INDENT + text.slice(end), caret: start + INDENT.length };
  }

  const lines = block.split("\n");
  let firstDelta = 0;
  let total = 0;
  const changed = lines.map((line, i) => {
    if (outdent) {
      const m = /^(\s{1,2}|\t)/.exec(line);
      const cut = m ? m[0].length : 0;
      if (i === 0) firstDelta = -cut;
      total -= cut;
      return line.slice(cut);
    }
    if (i === 0) firstDelta = INDENT.length;
    total += INDENT.length;
    return INDENT + line;
  });
  const next = text.slice(0, first) + changed.join("\n") + text.slice(last);
  return {
    text: next,
    caret: Math.max(first, start + firstDelta),
    selectionEnd: Math.max(first, end + total),
  };
}

/** 스크롤 따라가기 — 편집기가 보는 자리의 비율을 미리보기에 그대로 옮긴다.
 *
 *  줄과 줄을 정확히 맞추려면 그려진 모든 요소의 높이를 알아야 한다. 마크다운은 한 줄이 제목이 되기도
 *  표가 되기도 해서 비용이 크고, 틀리면 오히려 덜컥거린다. 비율만 맞춰도 "내가 보는 곳이 저기구나" 는
 *  충분히 전해진다.
 */
export function mirrorScroll(from: { scrollTop: number; scrollHeight: number; clientHeight: number }): number {
  const room = from.scrollHeight - from.clientHeight;
  return room <= 0 ? 0 : from.scrollTop / room;
}

/** 커서가 몇 줄 몇 칸에 있는가 — 상태 표시줄이 쓴다 (편집기의 관습). */
export function caretPosition(text: string, caret: number): { line: number; column: number } {
  const upto = text.slice(0, caret);
  const nl = upto.lastIndexOf("\n");
  return { line: upto.split("\n").length, column: caret - nl };
}

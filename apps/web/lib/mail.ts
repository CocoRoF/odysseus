/** 메일 형식 파싱·조립 — 메일 앱과 파일 미리보기가 공유한다.
 *
 * 시험장의 메일은 별도 저장소가 아니라 **워크스페이스 파일**이다. 받은 메일은
 * 시나리오가 넣어 둔 `mail/` · `inbox/` 아래의 텍스트 파일이고, 응시자가 쓴 회신은
 * `output/` 아래의 파일이다. 그래서 메일 앱에서 한 일을 폴더·에이전트·자동 채점이
 * 그대로 본다 — 채점기에 메일 전용 규칙을 새로 만들 필요가 없다.
 *
 * 헤더는 한국어·영어를 모두 받는다. 시나리오 작성자가 `보낸사람:` 으로 쓰든
 * `From:` 으로 쓰든 같은 메일로 읽혀야 한다.
 */

export interface MailHeaders {
  from?: string;
  to?: string;
  cc?: string;
  subject?: string;
  date?: string;
}

export interface ParsedMail {
  headers: MailHeaders;
  /** 헤더 블록을 제외한 본문 */
  body: string;
  /** 헤더가 하나라도 있었는가 — 없으면 그냥 텍스트 파일이다 */
  hasHeaders: boolean;
}

const HEADER_ALIASES: Record<string, keyof MailHeaders> = {
  보낸사람: "from",
  보낸이: "from",
  발신: "from",
  발신자: "from",
  from: "from",
  받는사람: "to",
  받는이: "to",
  수신: "to",
  수신자: "to",
  to: "to",
  참조: "cc",
  cc: "cc",
  제목: "subject",
  subject: "subject",
  날짜: "date",
  일시: "date",
  date: "date",
};

const HEADER_LINE = /^\s*([A-Za-z가-힣]{1,10})\s*:\s*(.*)$/;

/** 헤더 블록(첫 빈 줄까지)을 읽어 본문과 분리한다. 헤더가 없으면 전체가 본문. */
export function parseMail(text: string): ParsedMail {
  const src = (text ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = src.split("\n");
  const headers: MailHeaders = {};
  let i = 0;
  let found = false;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) break; // 빈 줄 = 헤더 끝
    const m = HEADER_LINE.exec(line);
    if (!m) break;
    const key = HEADER_ALIASES[m[1].trim().toLowerCase()];
    if (!key) break; // 모르는 이름이면 헤더가 아니라 본문의 첫 줄로 본다
    headers[key] = m[2].trim();
    found = true;
  }
  if (!found) return { headers: {}, body: src, hasHeaders: false };
  while (i < lines.length && !lines[i].trim()) i++;
  return { headers, body: lines.slice(i).join("\n"), hasHeaders: true };
}

/** 회신 제목 — 이미 붙어 있으면 두 번 붙이지 않는다. */
export function replySubject(subject: string): string {
  const s = (subject || "").trim();
  if (/^(re|RE|답장|답변)\s*[:\]]/.test(s)) return s;
  return `RE: ${s || "(제목 없음)"}`;
}

/** 인용문 — 각 줄 앞에 `> `. 회신에 원문을 붙일 때만 쓴다(기본은 붙이지 않는다). */
export function quoteBody(body: string, from?: string): string {
  const head = from ? `\n\n---\n${from} 님이 쓴 내용:\n` : "\n\n---\n원문:\n";
  return head + body.split("\n").map((l) => `> ${l}`).join("\n");
}

/** 보낸사람/받는사람 문자열에서 표시 이름만 — `한미래 <a@b>` → `한미래`. */
export function displayName(value?: string): string {
  const raw = (value ?? "").trim();
  if (!raw) return "";
  const m = /^(.*?)\s*<[^>]*>$/.exec(raw);
  return (m ? m[1] : raw).replace(/^"|"$/g, "").trim() || raw;
}

/** 받은 편지함으로 볼 경로인가 — 시나리오가 넣어 둔 메일 폴더. */
export function isInboxPath(path: string): boolean {
  return /^(mail|inbox|메일)\//i.test(path);
}

/** 메일로 다룰 파일인가 (폴더 안의 텍스트 파일만). */
export function isMailFile(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return ["txt", "md", "eml", "mail", "markdown"].includes(ext);
}

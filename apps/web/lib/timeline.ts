import { EVENT_LABEL } from "./format.ts";

/** 응시 타임라인을 사람이 읽는 줄로 바꾼다.
 *
 *  예전에는 이벤트마다 payload 를 그대로 찍었다 — `{"app":"messenger","seq":2,"client_id":"wk4unxtg"}`.
 *  채점자에게 seq·client_id 는 아무 의미가 없고, 정작 필요한 "무엇을, 얼마나" 는 그 안에 묻혀 있었다.
 *  여기서 한 줄 설명을 만들고, 원본은 필요할 때만 펴 본다.
 */

const APP_LABEL: Record<string, string> = {
  messenger: "메신저",
  docs: "문서",
  sheet: "OdyCell",
  ide: "IDE",
  terminal: "터미널",
  files: "폴더",
  // [인터넷] 앱은 2026-09-19 에 없앴지만, 그 전에 치른 응시의 기록에는 이 이름이 남아 있다.
  // 지난 기록을 읽는 자리라 이름을 지우면 평가자가 "browser" 라는 날것을 보게 된다.
  browser: "인터넷",
  mail: "메일",
  // [달력] 앱은 2026-09-20 에 없앴지만, 그 전에 치른 응시의 기록에는 이 이름이 남아 있다.
  calendar: "달력",
  github: "GitHub",
  // 저장소를 내려받아 서버가 직접 푼 파일
  git: "저장소",
  viewer: "뷰어",
  agent: "AI 에이전트",
};

function appName(value: unknown): string {
  // 창이 여럿인 앱은 "docs::1" 처럼 인스턴스 번호가 붙는다 — 사람에게는 같은 앱이다.
  const id = String(value ?? "").split("::")[0];
  return APP_LABEL[id] ?? id;
}

/** 밀리초를 사람이 읽는 길이로. 자리 비움·실행 시간에 쓴다. */
export function humanMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}초`;
  const m = Math.floor(s / 60);
  const rest = Math.round(s % 60);
  return rest ? `${m}분 ${rest}초` : `${m}분`;
}

const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const text = (v: unknown): string => (typeof v === "string" ? v : "");

/** 채점자에게 아무 뜻이 없는 키 — 설명에서도 [자세히] 판단에서도 뺀다. */
const INTERNAL_KEYS = new Set(["seq", "client_id", "scenario_id", "attempt_id", "id", "execution_id", "by"]);

/** 원본을 펴 볼 값이 있는가 — 내부 식별자뿐이면 [자세히] 를 걸지 않는다. */
export function hasRawDetail(payloads: Record<string, unknown>[]): boolean {
  return payloads.some((p) => Object.keys(p || {}).some((k) => !INTERNAL_KEYS.has(k)));
}

/** 이 이벤트가 무슨 일이었는지 한 줄로. 설명할 것이 없으면 빈 문자열. */
export function describeEvent(type: string, payload: Record<string, unknown> = {}): string {
  const away = num(payload.away_ms);
  const chars = num(payload.chars);
  switch (type) {
    case "app_open":
    case "app_close":
      return appName(payload.app);
    case "window_focus":
    case "tab_visible":
    case "focus_gained":
      return away !== null ? `${humanMs(away)} 만에 돌아옴` : "";
    case "window_blur":
    case "tab_hidden":
    case "focus_lost":
      return "";
    case "msg_sent":
      return [text(payload.character), chars !== null ? `${chars}자` : ""].filter(Boolean).join(" · ");
    case "msg_received": {
      const who = text(payload.character);
      if (payload.error) return `${who} · 답변 실패 (${text(payload.error)})`;
      return [who, chars !== null ? `${chars}자` : ""].filter(Boolean).join(" · ");
    }
    case "agent_turn":
      return chars !== null ? `${chars}자` : "";
    case "file_create":
    case "file_save":
    case "file_delete":
    case "file_open": {
      // 어느 창에서 한 일인지가 이제 남는다 — 문서로 쓴 글과 뷰어로 읽은 파일은 다른 일이다.
      // 옛 기록의 "ide" 는 모든 창이 물려받던 기본값이라 이름을 붙이지 않는다.
      const actor = text(payload.actor);
      return [text(payload.path), actor && actor !== "ide" ? appName(actor) : ""].filter(Boolean).join(" · ");
    }
    case "mail_sent": {
      // 메일은 "무엇을 썼는가" 보다 **누구에게 보냈는가** 가 먼저 읽혀야 한다 — 받는 사람을 빠뜨린
      // 회신은 글이 좋아도 업무로는 실패다.
      const words = num(payload.words);
      const cc = text(payload.cc);
      const head = [text(payload.to) || "(수신자 미정)", text(payload.subject)].filter(Boolean).join(" → ");
      return [
        head,
        cc ? `참조 ${cc}` : "",
        words !== null ? `${words}단어` : "",
        payload.quoted ? "원문 인용" : "",
      ]
        .filter(Boolean)
        .join(" · ");
    }
    case "run_request":
      return text(payload.cmd) || text(payload.command);
    case "run_done": {
      const code = num(payload.exit_code);
      const ms = num(payload.ms) ?? num(payload.duration_ms);
      return [
        text(payload.cmd) || text(payload.command),
        code === null ? "" : code === 0 ? "성공" : `실패 (코드 ${code})`,
        ms !== null ? humanMs(ms) : "",
      ]
        .filter(Boolean)
        .join(" · ");
    }
    case "paste":
    case "copy":
    case "cut":
      return chars !== null ? `${chars}자` : "";
    case "github_clone":
      return [text(payload.repo) || text(payload.url), text(payload.ref)].filter(Boolean).join(" · ");
    case "reference_search":
    case "reference_open":
    case "reference_request":
    case "reference_failed": {
      // 참고 자료는 한 종류가 아니다 — 검색·저장소·파일·clone·웹페이지가 몇 안 되는 이름에 섞여 들어온다.
      const repo = text(payload.repo);
      const query = text(payload.q) || text(payload.query);
      const results = num(payload.results);
      const parts: string[] = [];
      if (query) parts.push(`“${query}” 검색`);
      else if (payload.clone) parts.push(`${text(payload.clone)} 내려받기`);
      else if (payload.file) parts.push([repo, text(payload.file)].filter(Boolean).join(" · "));
      else if (payload.tree) parts.push([repo, text(payload.tree)].filter(Boolean).join(" · "));
      else if (repo) parts.push(repo);
      else if (payload.url) parts.push(text(payload.url));
      if (results !== null) parts.push(`결과 ${results}건`);
      const status = num(payload.status);
      if (status !== null) parts.push(`실패 (${status})`);
      else if (payload.error) parts.push(`실패 (${text(payload.error)})`);
      return parts.join(" · ");
    }
    case "file_copy":
    case "file_rename": {
      const count = num(payload.count);
      const move = [text(payload.from), text(payload.to)].filter(Boolean).join(" → ");
      return [move, count !== null && count > 1 ? `${count}개` : ""].filter(Boolean).join(" · ");
    }
    case "run_started":
      return "";
    case "run_enqueue_delayed":
      return "대기열에 바로 넣지 못해 미뤘음";
    case "run_stale_reaped": {
      const th = num(payload.threshold_s);
      return th !== null ? `${humanMs(th * 1000)} 넘게 멈춰 있어 정리` : "멈춰 있어 정리";
    }
    case "attempt_grant": {
      const agent = num(payload.agent_turns);
      const messenger = num(payload.messenger_turns);
      const minutes = num(payload.extra_minutes);
      return [
        agent ? `에이전트 +${agent}회` : "",
        messenger ? `메신저 +${messenger}회` : "",
        minutes ? `시간 +${minutes}분` : "",
        text(payload.reason),
      ]
        .filter(Boolean)
        .join(" · ");
    }
    case "scenario_completed": {
      const ordinal = num(payload.ordinal);
      const total = num(payload.total);
      if (ordinal === null) return "";
      return total !== null ? `${ordinal + 1}번째 / 전체 ${total}개` : `${ordinal + 1}번째`;
    }
    case "telemetry_gap": {
      const missed = num(payload.missed) ?? num(payload.gap);
      return missed !== null ? `${missed}건 누락` : "";
    }
    case "unsaved_on_submit": {
      const count = num(payload.count);
      const paths = Array.isArray(payload.paths) ? payload.paths.slice(0, 3).join(", ") : "";
      return [count !== null ? `${count}개 파일` : "", paths].filter(Boolean).join(" · ");
    }
    case "attempt_expired":
    case "attempt_submitted":
    case "attempt_started":
      return "";
    default: {
      // 모르는 종류라도 payload 안의 읽을 만한 값은 보여 준다 — 내부 식별자는 뺀다.
      const skip = INTERNAL_KEYS;
      const parts = Object.entries(payload)
        .filter(([k, v]) => !skip.has(k) && v !== null && v !== "" && typeof v !== "object")
        .slice(0, 3)
        .map(([k, v]) => `${k} ${v}`);
      return parts.join(" · ");
    }
  }
}

export interface TimelineRow {
  key: string;
  /** 이 줄에 묶인 이벤트들 (한 건이면 길이 1) */
  ids: number[];
  type: string;
  label: string;
  detail: string;
  count: number;
  /** 브라우저가 보고한 값이 섞여 있는가 (ODY-017) */
  untrusted: boolean;
  createdAt: string;
  payloads: Record<string, unknown>[];
}

export interface TimelineEventInput {
  id: number;
  type: string;
  source?: string;
  payload: Record<string, unknown>;
  created_at: string;
}

const REFERENCE_DONE = new Set(["reference_search", "reference_open", "reference_failed"]);

/** 끝난 자료 요청의 시작 줄은 접는다.
 *
 *  서버는 외부 호출을 감싸며 시작(`reference_request`)과 끝(검색·열람·실패)을 따로 남긴다. 둘 다 보이면
 *  같은 검색이 1초 간격으로 두 줄이 된다. 시작 줄이 홀로 남은 경우 — 끝내 돌아오지 못한 요청 — 만 뜻이 있다.
 */
function dropSettledRequests(events: TimelineEventInput[]): TimelineEventInput[] {
  return events.filter((e, i) => {
    if (e.type !== "reference_request") return true;
    const next = events[i + 1];
    return !(next && REFERENCE_DONE.has(next.type));
  });
}

/** 연달아 같은 일이 벌어지면 한 줄로 묶는다 — 창 이탈·복귀가 4초 사이에 네 번이면 네 줄이 아니라 한 줄이다. */
export function groupEvents(input: TimelineEventInput[], windowMs = 120000): TimelineRow[] {
  const events = dropSettledRequests(input);
  const rows: TimelineRow[] = [];
  for (const e of events) {
    const detail = describeEvent(e.type, e.payload || {});
    const last = rows[rows.length - 1];
    const sameKind = last && last.type === e.type && last.detail === detail;
    const near = last && Math.abs(Date.parse(e.created_at) - Date.parse(last.createdAt)) <= windowMs;
    if (sameKind && near) {
      last.count += 1;
      last.ids.push(e.id);
      last.payloads.push(e.payload || {});
      last.untrusted = last.untrusted || e.source === "client_untrusted";
      continue;
    }
    rows.push({
      key: String(e.id),
      ids: [e.id],
      type: e.type,
      label: EVENT_LABEL[e.type] ?? e.type,
      detail,
      count: 1,
      untrusted: e.source === "client_untrusted",
      createdAt: e.created_at,
      payloads: [e.payload || {}],
    });
  }
  return rows;
}

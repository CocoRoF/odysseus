export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "-";
  const d = new Date(iso);
  return d.toLocaleString("ko-KR", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function fmtDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
}

export function fmtOffset(startIso: string, iso: string): string {
  const sec = Math.max(0, Math.round((new Date(iso).getTime() - new Date(startIso).getTime()) / 1000));
  return `+${fmtDuration(sec)}`;
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export const DIFFICULTY_LABEL: Record<string, string> = {
  easy: "쉬움",
  medium: "보통",
  hard: "어려움",
};

export const STATUS_LABEL: Record<string, string> = {
  in_progress: "진행 중",
  submitted: "제출 완료",
  expired: "시간 만료",
};

export const EVENT_LABEL: Record<string, string> = {
  attempt_started: "응시 시작",
  attempt_submitted: "응시 제출",
  attempt_expired: "시간 만료",
  attempt_superseded: "재응시로 대체",
  msg_sent: "메시지 전송",
  msg_received: "메시지 수신",
  agent_turn: "에이전트 질문",
  file_create: "파일 생성",
  file_save: "파일 저장",
  file_delete: "파일 삭제",
  file_open: "파일 열람",
  run_request: "실행 요청",
  run_done: "실행 완료",
  app_open: "앱 실행",
  app_close: "앱 종료",
  focus_lost: "화면 이탈",
  focus_gained: "화면 복귀",
  tab_hidden: "탭 이탈",
  tab_visible: "탭 복귀",
  window_blur: "창 이탈",
  window_focus: "창 복귀",
  paste: "붙여넣기",
  copy: "복사",
  cut: "잘라내기",
  page_enter: "페이지 진입",
  page_exit: "페이지 이탈",
  net_offline: "네트워크 끊김",
  net_online: "네트워크 복구",
  reference_search: "자료 검색",
  reference_open: "자료 열람",
  github_clone: "저장소 clone",
  exam_leave: "시험장 이탈",
};

export const AWAY_EVENT_TYPES = ["focus_lost", "tab_hidden", "window_blur"];

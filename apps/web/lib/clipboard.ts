/** 앱 내부 복사 버튼/메뉴가 성공했을 때 알리는 이벤트 (응시 행동 기록용) */
export const COPY_EVENT = "odysseus:copy";

function announce(text: string) {
  try {
    window.dispatchEvent(new CustomEvent(COPY_EVENT, { detail: { text } }));
  } catch {
    /* ignore */
  }
}

/** 클립보드 복사 — Clipboard API 우선, 실패 시 execCommand 폴백. */
export async function copyText(text: string): Promise<boolean> {
  if (!text) return false;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      announce(text);
      return true;
    }
  } catch {
    /* 폴백으로 진행 */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    if (ok) announce(text);
    return ok;
  } catch {
    return false;
  }
}

/** 브라우저가 클립보드 이벤트로 직접 실어 준 복사를 기록에 남긴다.
 *
 *  격자처럼 **선택이 DOM 선택이 아닌** 화면은 `copy` 이벤트에서 clipboardData 에 직접 값을 싣는다.
 *  그 길은 copyText 를 지나지 않으므로, 복사했다는 사실만 여기서 따로 알린다 (응시 행동 기록).
 */
export function announceCopy(text: string): void {
  if (text) announce(text);
}

/** 현재 선택된 텍스트 (없으면 빈 문자열) */
export function selectedText(): string {
  return (window.getSelection()?.toString() ?? "").trim();
}

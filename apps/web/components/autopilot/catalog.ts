/** 자동 진행([응시 (자동 진행)])이 풀 줄 아는 시험 — 제목으로 고른다.
 *
 *  로그인 화면은 이 목록만 본다. 진행 계획(plans.ts)에는 매니페스트 전문과 대사가 들어 있어 무겁고 정답이기도 하므로,
 *  로그인 화면의 번들에 싣지 않고 시험 화면에서 자동 진행을 켤 때만 불러온다.
 */
export const AUTOPILOT_EXAM_TITLE = "쿠버네티스 추론 파드가 스케줄되지 않는다";

/** 자동 진행 계정의 이름 머리 — 응시 리뷰에서 사람이 푼 응시와 섞이지 않게 이름으로 드러낸다 */
export const AUTOPILOT_NAME_PREFIX = "자동 진행";

/** 시험 화면이 이어서 돌릴 진행 상태를 담는 자리(이 탭에서만) */
export const autopilotKey = (attemptId: string) => `odysseus:autopilot:${attemptId}`;

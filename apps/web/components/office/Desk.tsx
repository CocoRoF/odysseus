"use client";

import type { MyAssignment } from "@/lib/types";
import { S } from "./atlas";

/** 업무 시작 지점 하나 = 시험 하나. 노트북이 놓인 스탠딩 데스크다 — 앉지 않는다.
 *
 * 시나리오가 아니라 **시험**인 이유는 서버가 순차 진행을 강제하기 때문이다. 응시자는
 * 시험 안에서 문제를 고를 수 없고, 아직 도달하지 않은 문제는 서버가 잠근 채 지문조차
 * 내려 주지 않는다. 자리를 문제 단위로 놓으면 잠긴 자리만 늘어선 방이 된다.
 *
 * **이 버튼은 책상 자체를 그리지 않는다.** 책상 그림은 층의 세계 층이 발끝 깊이로 정렬해 그린다 —
 * 버튼 안에 그리면 사람이 책상 뒤에 서도 책상이 사람을 가리지 못한다. 글자도 그리지 않는다. 층 전체가 배율을 먹고 있어서, 여기에
 * 제목을 넣으면 5~7 CSS px 로 렌더된다 — 읽히지도 않고 가구로 보이지도 않는 크기다.
 * 예전에 그 글자를 읽히게 하려고 자리를 112×78 로 키웠고, 그 바람에 방에 바닥이 남지
 * 않았다. 그래서 글자는 배율 밖(이름표·하단 바)으로 나가고 여기엔 위치를 알리는 표식만 남는다.
 *
 * 대신 **접근 가능한 이름이 계약이 된다.** 눈으로 알 수 있는 것 — 제목·상태·시나리오
 * 수·제한시간·이 누름이 두 단계 중 어느 쪽인지 — 이 전부가 이 버튼의 이름 하나로
 * 복원되어야 한다. 그래서 설명(`aria-describedby`)이 아니라 이름에 싣는다: 설명은
 * 보이스오버가 지연 뒤에 읽고, 아예 꺼 두는 사람도 많다.
 *
 * 방에 들어가기 전에는 이 버튼이 **시작하지 않고 방으로 데려간다.** 연출이 아니라
 * 안전 때문이다 — 응시를 시작하는 순간 서버가 마감 시각을 박으므로, 지나가다 잘못 누른
 * 한 번이 시험을 열어 버리면 되돌릴 수 없다.
 */
export function Desk({
  assignment,
  armed,
  left,
  top,
  busy,
  onStart,
  onEnterRoom,
  onPeek,
}: {
  assignment: MyAssignment;
  /** 이 자리가 있는 방에 이미 들어와 있는가. 아니라면 누를 때 방으로 먼저 간다. */
  armed: boolean;
  left: number;
  top: number;
  busy: boolean;
  onStart: () => void;
  onEnterRoom: () => void;
  /** 이름표와 하단 바에 띄울 대상. 벗어나면 null. */
  onPeek: (assignment: MyAssignment | null) => void;
}) {
  const finished = Boolean(assignment.attempt_status && assignment.attempt_status !== "in_progress");
  const resuming = assignment.attempt_status === "in_progress";
  const state = finished ? "응시 완료 — 결과 보기" : resuming ? "응시 중" : "빈자리";

  const step = armed || finished ? "" : " 누르면 이 자리로 갑니다 — 아직 시험은 시작되지 않습니다.";
  // 이름표가 제목을 그대로 보여 주므로(보이는 이름), 접근 가능한 이름은 반드시
  // 그 제목으로 **시작**해야 한다. 줄이거나 앞에 뭘 붙이면 음성 입력이 깨진다.
  const name = `${assignment.title} — ${state}. 시나리오 ${assignment.scenario_count}개, 제한시간 ${assignment.duration_min}분.${step}`;

  const descId = assignment.description ? `desk-desc-${assignment.assessment_id}` : undefined;
  const dataState = finished ? "done" : resuming ? "resume" : "open";

  return (
    <button
      type="button"
      onClick={armed ? onStart : onEnterRoom}
      onFocus={(e) => {
        // 키보드로 옮겨 온 포커스만 방 이동으로 친다. 마우스 클릭이 만든 포커스까지
        // 여기서 처리하면 focus 가 click 보다 먼저 도착하는 탓에 **한 번의 클릭이
        // '들어가기'와 '앉기'를 동시에 해 버린다** — 두 단계로 나눈 의미가 사라진다.
        try {
          if (e.currentTarget.matches(":focus-visible")) onEnterRoom();
        } catch {
          // :focus-visible 을 모르는 브라우저에서는 방을 따라 옮기지 않는다.
        }
        onPeek(assignment);
      }}
      onBlur={() => onPeek(null)}
      onPointerEnter={() => onPeek(assignment)}
      onPointerLeave={() => onPeek(null)}
      disabled={busy}
      aria-describedby={descId}
      data-state={dataState}
      className="office-desk office-desk-art absolute"
      // 누름 자리는 **책상 그림과 똑같은 사각형**이다(모니터가 솟은 윗줄까지). 발자국 줄만 덮으면 모니터를 눌러도
      // 반응이 없고, 포커스 테가 책상 허리에 걸린다.
      style={{ left, top, width: S.standDesk.w, height: S.standDesk.h }}
    >
      {!finished && <span className="office-desk-marker" aria-hidden="true"><i /></span>}
      <span className="sr-only">{name}</span>
      {assignment.description && (
        <span id={descId} hidden>
          {assignment.description}
        </span>
      )}
    </button>
  );
}

/** 이 자리 버튼이 지금 무엇을 하는 버튼인지 — 하단 바가 같은 문장을 쓴다. */
export function deskAction(assignment: MyAssignment, armed: boolean): string {
  const finished = Boolean(assignment.attempt_status && assignment.attempt_status !== "in_progress");
  if (finished) return armed ? "결과 보기" : "가서 보기";
  if (!armed) return "가서 보기";
  return assignment.attempt_status === "in_progress" ? "이어서 응시하기" : "업무 시작하기";
}

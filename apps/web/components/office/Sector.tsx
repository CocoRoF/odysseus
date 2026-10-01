"use client";

import type { MyAssignment } from "@/lib/types";
import { Desk } from "./Desk";
import { S } from "./atlas";
import { TILE, innerOrigin, type RoomLayout } from "./floorplan";

/** 섹터 하나 = 방 하나 = 시험 하나 = `<section>` 하나.
 *
 * **이 컴포넌트는 더 이상 건축물을 그리지 않는다.** 벽·바닥·러그·소품은 `OfficeStage`
 * 가 층 단위 레이어로 그린다. 이유는 z 순서다: 방이 자기 안에 벽을 들고 있으면, 그
 * 벽은 형제인 아바타 위로 절대 못 올라온다(쌓임 맥락에 갇힌다). 남쪽 방의 앞벽이
 * 아바타를 가려야 방에 '들어간' 것으로 보이는데, 그러려면 벽이 아바타의 형제여야 한다.
 *
 * 그래서 여기 남는 것은 **방 안쪽을 덮는 투명한 상호작용 영역**뿐이다. 벽을 눌러도
 * 아무 일이 없는 게 정직하다 — 거긴 걸어 들어갈 수 없는 곳이다.
 *
 */
export function Sector({
  layout,
  label,
  assignments,
  entered,
  busyId,
  onEnter,
  onStart,
  onPeek,
}: {
  layout: RoomLayout;
  label: string;
  assignments: MyAssignment[];
  entered: boolean;
  busyId: string | null;
  onEnter: () => void;
  onStart: (assignment: MyAssignment) => void;
  onPeek: (assignment: MyAssignment | null) => void;
}) {
  const { room, start } = layout;
  const inner = innerOrigin(room);
  const headingId = `sector-${room.id}`;

  return (
    <section
      aria-labelledby={headingId}
      data-sector={room.id}
      data-entered={entered ? "true" : undefined}
      className="o-zone absolute"
      style={{
        left: inner.x,
        top: inner.y,
        width: room.cols * TILE,
        height: room.rows * TILE,
      }}
    >
      {/* 방 이름은 문패와 바닥 글자가 눈으로 알려 주고, 그 둘은 보조기술에서 감춰 둔다.
          여기 한 번만 남겨야 방 이름이 두 번 읽히지 않는다. */}
      <h2 id={headingId} className="sr-only">
        {label}
      </h2>

      {assignments.length > 0 && (
        <ul className="o-zone-slots">
          {/* 방 하나가 시험 하나 — 업무 시작 지점은 하나다. */}
          <li key={assignments[0].assessment_id}>
            <Desk
              assignment={assignments[0]}
              armed={entered}
              left={start.x - inner.x}
              // 그림 윗변 — 책상은 발자국(한 줄) 위로 한 줄 솟는다. 세계 층이 그리는 그림과 같은 식이다.
              top={start.y + TILE - S.standDesk.h - inner.y}
              busy={busyId === assignments[0].assessment_id}
              onStart={() => onStart(assignments[0])}
              onEnterRoom={onEnter}
              onPeek={onPeek}
            />
          </li>
        </ul>
      )}

      {/* 방 안 빈 바닥을 누르면 들어간다. 자리보다 아래에 깔려 자리 클릭을 가로채지 않고,
          자리 목록은 클릭을 흘려보내므로 바닥이 실제로 눌린다. */}
      {!entered && (
        <button
          type="button"
          className="o-zone-enter"
          onClick={onEnter}
          aria-label={`${label}에 들어가기. ${
            assignments.length === 0 ? "배정된 시험 없음" : `시험 ${assignments.length}개`
          }.`}
        />
      )}
    </section>
  );
}

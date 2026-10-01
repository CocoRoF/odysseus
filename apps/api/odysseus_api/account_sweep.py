"""손님 계정은 다시 못 쓰게 되면 지운다.

게스트(응시)와 둘러보기(관리 화면)는 둘 다 만들 때 비밀번호 경로를 닫는다 — 맞출 수 없는 해시를
넣는다. 그래서 **세션이 끊기는 순간 그 계정은 영영 못 쓴다.** 로그아웃하면 같은 게스트로 다시 들어올
수 없고, 유휴 한도를 넘겨도, 기한이 지나도 마찬가지다.

그러니 지우는 조건의 첫 줄은 둘이 같다: **다시 들어올 수 없게 된 계정만 지운다.** 세션이 아직 살아
있으면 손대지 않는다 — 게스트는 그 쿠키 하나로 시험을 이어 하기 때문에, 여기서 한 발 앞서 지우면
잠시 자리를 비운 응시자의 시험을 뺏는 것이 된다. 그 판정은 :mod:`odysseus_api.sessions` 이 갖는다.
인증이 토큰을 받아 주는 조건과 같은 조건이어야 하므로 여기서 따로 적지 않는다.

다른 점은 **남길 것이 있느냐**다.

- **둘러보기**: 남길 것이 없다. 관리 화면을 보기만 했고 아무것도 바꾸지 못하는 계정이다. 바로 지운다.
- **게스트**: 응시 기록이 평가 대상이니 함부로 지우지 않는다. 단, 기록이 **비어 있으면** 남길 이유도
  없다 — 메신저에 한 마디도 걸지 않고, 에이전트에 묻지 않고, 파일 한 줄 고치지 않고, 아무것도 실행하지
  않은 채 시험장을 둘러보기만 한 응시다. 사람이 점수를 매긴 응시는 무슨 일이 있어도 남긴다.

무엇을 "했다"로 볼지는 :data:`WORKSPACE_EVENTS` 와 :func:`_worked_attempts` 가 정한다. 시험장을
열어 본 흔적(앱 실행·창 이탈·자료 검색)은 세지 않는다. 시작할 때 시나리오가 깔아 준 초기 파일과
오프닝 메시지도 마찬가지다 — 그건 응시자가 한 일이 아니다.
"""

from __future__ import annotations

import asyncio
import logging

from sqlalchemy import delete, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from .db import SessionLocal
from .demo import DEMO_ADMIN_ROLE
from .guests import ARRIVAL_WINDOW, GUEST_ROLE
from .models import (
    AgentMessage,
    Attempt,
    Evaluation,
    Event,
    Execution,
    GuestArrival,
    MessengerMessage,
    User,
    utcnow,
)
from .sessions import idle_limit, live_session_exists

log = logging.getLogger("odysseus.account-sweep")

SWEEP_INTERVAL_S = 60.0
#: 한 바퀴에 지우는 최대 개수 — 청소가 길어져 다른 일을 밀어내지 않게.
BATCH_SIZE = 200

#: 응시자가 워크스페이스를 건드렸다는 증거. 초기 파일 배치(_materialize)와 저장소 clone 은
#: 이 이벤트를 남기지 않으므로, 여기 걸리면 사람이 직접 만들었거나 고친 것이다.
WORKSPACE_EVENTS = ("file_create", "file_save", "file_delete", "file_copy", "file_rename")


def _worked_attempts(user_column):
    """남길 것이 있는 응시를 고르는 select — 한 건이라도 있으면 그 계정은 지우지 않는다."""
    chatted = (
        select(MessengerMessage.id)
        .where(MessengerMessage.attempt_id == Attempt.id, MessengerMessage.sender == "candidate")
        .exists()
    )
    asked = (
        select(AgentMessage.id)
        .where(AgentMessage.attempt_id == Attempt.id, AgentMessage.role == "user")
        .exists()
    )
    # 응시자가 돌린 것만 일이다. 채점기가 돌린 실행(source=check)은 시험이 끝나면 저절로 생긴다 —
    # 그것을 세면 "제출하면 채점한다" 가 된 뒤로 빈손으로 나간 게스트가 전부 남는다.
    ran = (
        select(Execution.id)
        .where(Execution.attempt_id == Attempt.id, Execution.source != "check")
        .exists()
    )
    wrote = (
        select(Event.id)
        .where(Event.attempt_id == Attempt.id, Event.type.in_(WORKSPACE_EVENTS))
        .exists()
    )
    # 사람이 점수를 매겼다면 내용이 무엇이든 기록이다.
    graded = (
        select(Evaluation.id)
        .where(Evaluation.attempt_id == Attempt.id, Evaluation.kind == "human")
        .exists()
    )
    return select(Attempt.id).where(
        Attempt.user_id == user_column,
        or_(chatted, asked, ran, wrote, graded),
    )


async def has_record_worth_keeping(db: AsyncSession, user: User) -> bool:
    """이 사람의 응시 중에 남길 만한 것이 하나라도 있는가."""
    if user.role != GUEST_ROLE:
        return False
    row = (await db.execute(_worked_attempts(user.id).limit(1))).first()
    return row is not None


async def spent_visitor(db: AsyncSession, user: User) -> bool:
    """지금 이 계정을 지워도 되는가 — 로그아웃 직후에 묻는다.

    다른 창에 살아 있는 세션이 남아 있으면 지우지 않는다. 한 곳에서 나갔다고 다른 곳에서
    시험을 보고 있는 사람을 끊을 수는 없다.
    """
    if user.role not in (DEMO_ADMIN_ROLE, GUEST_ROLE):
        return False
    now = utcnow()
    still_in = (
        await db.execute(select(User.id).where(User.id == user.id, live_session_exists(now, user.role)))
    ).first()
    if still_in:
        return False
    return not await has_record_worth_keeping(db, user)


async def _delete(db: AsyncSession, user: User) -> bool:
    try:
        await db.delete(user)
        await db.commit()
        return True
    except IntegrityError:
        # 어딘가 이 계정을 참조하는 행이 남아 있다 — 한 계정 때문에 청소가 멈추지는 않는다.
        await db.rollback()
        log.warning("손님 계정을 지우지 못했습니다: %s (%s)", user.id, user.role)
        return False


async def purge_spent_visitors() -> dict[str, int]:
    """다시 들어올 수 없게 된 손님 계정을 지운다. 역할별로 지운 수를 돌려준다."""
    now = utcnow()
    removed = {DEMO_ADMIN_ROLE: 0, GUEST_ROLE: 0}
    async with SessionLocal() as db:
        for role in (DEMO_ADMIN_ROLE, GUEST_ROLE):
            # 방금 만들어진 계정은 건드리지 않는다. 계정을 만든 뒤 세션을 발급하기까지의 짧은 틈에
            # 쓸어버리면 막 들어온 사람이 이유 없이 튕긴다.
            born_before = now - idle_limit(role)
            conditions = [User.role == role, User.created_at < born_before, ~live_session_exists(now, role)]
            if role == GUEST_ROLE:
                conditions.append(~_worked_attempts(User.id).exists())
            rows = (
                await db.execute(
                    select(User).where(*conditions).order_by(User.created_at).limit(BATCH_SIZE)
                )
            ).scalars().all()
            for user in rows:
                if await _delete(db, user):
                    removed[role] += 1
    return removed


async def prune_arrivals() -> int:
    """창을 벗어난 입장 원장을 지운다 — 상한을 세는 데만 쓰는 값이라 더 둘 이유가 없다."""
    async with SessionLocal() as db:
        result = await db.execute(
            delete(GuestArrival).where(GuestArrival.created_at < utcnow() - ARRIVAL_WINDOW)
        )
        await db.commit()
        return int(result.rowcount or 0)


async def account_sweep_loop() -> None:
    while True:
        try:
            removed = await purge_spent_visitors()
            await prune_arrivals()
            # 끝났는데 채점이 없는 응시 — 뒤에서 돌던 판이 프로세스와 함께 죽었을 때의 그물
            from .grading import grade_backlog

            retried = await grade_backlog()
            if retried:
                log.info("채점이 빠진 응시 %d건을 다시 걸었습니다", retried)
            if any(removed.values()):
                log.info(
                    "다시 쓸 수 없는 손님 계정을 정리했습니다 — 둘러보기 %d, 빈 게스트 %d",
                    removed[DEMO_ADMIN_ROLE],
                    removed[GUEST_ROLE],
                )
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 — 한 번 실패해도 다음 바퀴는 돈다
            log.exception("손님 계정 정리에 실패했습니다")
        await asyncio.sleep(SWEEP_INTERVAL_S)

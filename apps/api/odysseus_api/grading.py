"""채점 — 시험이 끝나면 돈다. 입구는 하나다.

응시가 끝나는 길은 셋이다. 응시자가 [시험 종료]를 누르거나, 마지막 문제를 제출하거나, 마감이
지나거나, 관리자가 세션을 끊거나. 어느 길이든 lifecycle.finalize_attempt 를 지나고, 거기서 이 모듈의
:func:`schedule` 을 부른다. 채점 그 자체는 ai.assessment_eval.run_auto_eval 하나뿐이다 — 응시 시작 때
동결한 정의로, 점수 엔진과 감사 기록을 붙여서.

여기서 지키는 것 세 가지.

- **한 응시는 한 번만 돈다.** 결과 화면·백로그 정리·관리자 버튼이 같은 응시를 동시에 부를 수 있다.
  Redis 잠금(NX) 하나로 막는다. 관리자가 [다시 평가]를 누르는 것만 예외(force)다.
- **놓치지 않는다.** 뒤에서 도는 채점은 프로세스와 함께 죽을 수 있다. 결과 화면이 열릴 때와 60초마다
  도는 정리 루프가 "끝났는데 채점이 없는 응시" 를 다시 건다 — 같은 응시를 30분에 한 번만.
- **채점이 안 돼도 종료는 끝난다.** 모델이 설정되지 않았거나 실패해도 응시 종료는 이미 커밋된 일이다.
  실패는 기록으로 남고, 관리자 화면에 "미평가" 로 보인다.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from datetime import timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .db import SessionLocal
from .models import Attempt, Evaluation, utcnow

log = logging.getLogger("odysseus.grading")

#: 끝난 뒤 이만큼 지나도 결과가 없으면, 뒤에서 돌던 것이 죽었다고 보고 다시 건다.
RETRY_AFTER_S = 180.0
#: 한 응시의 채점 잠금 — 이보다 오래 걸리면 죽은 것으로 본다 (시나리오 여럿 × 모델 호출 여유)
LOCK_TTL_S = 15 * 60
#: 백로그 정리가 같은 응시를 다시 시도하기까지의 간격
BACKLOG_RETRY_S = 30 * 60
#: 백로그 정리가 되돌아보는 범위 — 그보다 오래된 미평가는 사람이 볼 일이다
BACKLOG_WINDOW = timedelta(hours=24)

LOCK_KEY = "odysseus:grade:{aid}"
TRIED_KEY = "odysseus:grade:tried:{aid}"


class AlreadyGrading(RuntimeError):
    """지금 다른 손이 같은 응시를 채점하고 있다."""


#: 이 프로세스에서 돌고 있는 채점 — Redis 가 없을 때의 최소 방어선이자 결과 화면의 "채점 중" 표시
_running: set[uuid.UUID] = set()
_background: set[asyncio.Task] = set()


def is_running(attempt_id: uuid.UUID) -> bool:
    return attempt_id in _running


async def latest_auto(db: AsyncSession, attempt_id: uuid.UUID) -> Evaluation | None:
    return (
        await db.execute(
            select(Evaluation)
            .where(Evaluation.attempt_id == attempt_id, Evaluation.kind == "auto")
            .order_by(Evaluation.created_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()


async def _lock(attempt_id: uuid.UUID) -> bool:
    """잠근다. Redis 가 없으면 프로세스 안의 집합만 믿는다 (uvicorn 은 프로세스 하나다)."""
    try:
        from .runqueue import get_redis

        return bool(await get_redis().set(LOCK_KEY.format(aid=attempt_id), "1", ex=LOCK_TTL_S, nx=True))
    except Exception:  # noqa: BLE001
        return attempt_id not in _running


async def _unlock(attempt_id: uuid.UUID) -> None:
    try:
        from .runqueue import get_redis

        await get_redis().delete(LOCK_KEY.format(aid=attempt_id))
    except Exception:  # noqa: BLE001
        pass


async def grade(
    attempt_id: uuid.UUID,
    *,
    force: bool = False,
    provider_id: uuid.UUID | None = None,
) -> Evaluation | None:
    """이 응시를 채점한다. 이미 채점돼 있으면 그 결과를 돌려준다(force 가 아니면).

    RuntimeError 는 그대로 올린다 — 모델 미설정·응시 진행 중 같은 이유는 부른 쪽이 말해야 한다.
    """
    from .ai.assessment_eval import run_auto_eval

    async with SessionLocal() as db:
        attempt = await db.get(Attempt, attempt_id)
        if attempt is None:
            return None
        if attempt.status == "in_progress":
            raise RuntimeError("진행 중인 시험은 채점할 수 없습니다")
        if not force:
            done = await latest_auto(db, attempt_id)
            if done is not None:
                return done
        if not await _lock(attempt_id):
            raise AlreadyGrading("이미 채점하고 있습니다")
        _running.add(attempt_id)
        try:
            return await run_auto_eval(attempt, db, override_provider_id=provider_id)
        finally:
            _running.discard(attempt_id)
            await _unlock(attempt_id)


async def _grade_quietly(attempt_id: uuid.UUID) -> None:
    """뒤에서 도는 한 판. 실패는 기록으로만 남긴다 — 결과 화면과 백로그 정리가 다시 건다."""
    try:
        await grade(attempt_id)
        log.info("응시 %s 채점 완료", attempt_id)
    except AlreadyGrading:
        pass
    except RuntimeError as e:
        # 모델 미설정처럼 설정으로 풀 일 — 스택은 소음이다
        log.warning("응시 %s 채점 보류: %s", attempt_id, e)
    except Exception:  # noqa: BLE001
        log.exception("응시 %s 채점 실패", attempt_id)


def schedule(attempt_id: uuid.UUID) -> bool:
    """채점을 뒤에서 건다. 이 프로세스에서 이미 돌고 있으면 아무것도 하지 않는다."""
    if attempt_id in _running:
        return False
    task = asyncio.create_task(_grade_quietly(attempt_id), name=f"grade-{attempt_id}")
    # 태스크 참조를 잃으면 GC 가 중간에 거둘 수 있다
    _background.add(task)
    task.add_done_callback(_background.discard)
    return True


async def should_retry(db: AsyncSession, attempt: Attempt) -> bool:
    """끝났는데 결과가 없고, 걸어 둔 판을 기다릴 만큼 기다렸는가 — 결과 화면이 열릴 때 묻는다."""
    if attempt.status == "in_progress" or attempt.id in _running:
        return False
    if await latest_auto(db, attempt.id) is not None:
        return False
    ended = attempt.submitted_at or attempt.deadline_at
    if ended is None:
        return False
    return (utcnow() - ended).total_seconds() >= RETRY_AFTER_S


async def grade_backlog() -> int:
    """끝났는데 채점이 없는 응시를 찾아 다시 건다 — 뒤에서 돌던 판이 프로세스와 함께 죽었을 때를 위해.

    같은 응시는 30분에 한 번만 다시 시도한다. 모델이 설정돼 있지 않아 매번 실패하는 환경에서
    60초마다 같은 응시를 두드리는 일은 아무에게도 도움이 되지 않는다.
    """
    since = utcnow() - BACKLOG_WINDOW
    cutoff = utcnow() - timedelta(seconds=RETRY_AFTER_S)
    async with SessionLocal() as db:
        graded = select(Evaluation.attempt_id).where(Evaluation.kind == "auto")
        rows = (
            await db.execute(
                select(Attempt.id)
                .where(
                    Attempt.status != "in_progress",
                    Attempt.submitted_at.is_not(None),
                    Attempt.submitted_at >= since,
                    Attempt.submitted_at <= cutoff,
                    Attempt.id.not_in(graded),
                )
                .limit(50)
            )
        ).scalars().all()
    scheduled = 0
    for attempt_id in rows:
        if attempt_id in _running:
            continue
        try:
            from .runqueue import get_redis

            fresh = await get_redis().set(TRIED_KEY.format(aid=attempt_id), "1", ex=BACKLOG_RETRY_S, nx=True)
            if not fresh:
                continue
        except Exception:  # noqa: BLE001 — Redis 가 없으면 간격을 못 지킬 뿐, 시도는 한다
            pass
        if schedule(attempt_id):
            scheduled += 1
    return scheduled

"""응시 종료(제출·만료·관리자 종료)의 단일 경로 (ODY-007).

종료는 여러 곳에서 일어난다 — 마지막 문제 제출, 시험 종료 버튼, 마감 경과, 관리자 세션 종료.
어디서 시작했든 여기서 같은 일을 같은 순서로 한다:

  1. 응시 행을 잠근다 (SELECT … FOR UPDATE) — 늦게 도착하는 러너 콜백과 경쟁하지 않는다.
  2. 상태를 바꾼다 (submitted | expired).
  3. 남아 있는 실행(queued/running)을 취소한다 — 러너에 취소를 알리고 기록은 error 로 닫는다.
  4. 시나리오별 워크스페이스 **스냅샷 요약**(파일 수·바이트·내용 해시, 대화·실행 수)을 응시에 남긴다.
     워크스페이스 자체는 DB 트리거(main.MIGRATIONS)가 제출 뒤 변경을 막으므로, 이 해시는
     평가 시점에 "그대로인가" 를 검증하는 데 쓴다.
  5. 이벤트를 남기고 커밋한다.
"""

from __future__ import annotations

import hashlib
import logging
import uuid
from datetime import datetime

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from .models import AssessmentScenario, Attempt, Event, Execution, MessengerMessage, WorkspaceFile, utcnow

log = logging.getLogger("odysseus.lifecycle")

CANCEL_KEY = "odysseus:runner:cancel"


async def workspace_digest(db: AsyncSession, attempt_id: uuid.UUID, scenario_id: uuid.UUID) -> dict:
    """시나리오 워크스페이스의 내용 해시 — 경로순으로 (path, sha256(content)) 를 이어 붙여 sha256."""
    rows = (
        await db.execute(
            select(WorkspaceFile.path, WorkspaceFile.content)
            .where(WorkspaceFile.attempt_id == attempt_id, WorkspaceFile.scenario_id == scenario_id)
            .order_by(WorkspaceFile.path)
        )
    ).all()
    h = hashlib.sha256()
    total = 0
    for path, content in rows:
        data = (content or "").encode("utf-8")
        total += len(data)
        h.update(path.encode("utf-8"))
        h.update(b"\0")
        h.update(hashlib.sha256(data).hexdigest().encode())
        h.update(b"\n")
    return {"digest": h.hexdigest(), "files": len(rows), "bytes": total}


async def _snapshot(db: AsyncSession, attempt: Attempt) -> dict:
    links = (
        await db.execute(
            select(AssessmentScenario.scenario_id, AssessmentScenario.ordinal)
            .where(AssessmentScenario.assessment_id == attempt.assessment_id)
            .order_by(AssessmentScenario.ordinal)
        )
    ).all()
    snap: dict[str, dict] = {}
    for scenario_id, ordinal in links:
        entry = await workspace_digest(db, attempt.id, scenario_id)
        entry["ordinal"] = ordinal
        entry["messages"] = (
            await db.execute(
                select(func.count(MessengerMessage.id)).where(
                    MessengerMessage.attempt_id == attempt.id, MessengerMessage.scenario_id == scenario_id
                )
            )
        ).scalar() or 0
        entry["executions"] = (
            await db.execute(
                select(func.count(Execution.id)).where(
                    Execution.attempt_id == attempt.id, Execution.scenario_id == scenario_id
                )
            )
        ).scalar() or 0
        snap[str(scenario_id)] = entry
    return snap


async def cancel_open_executions(db: AsyncSession, attempt_id: uuid.UUID, reason: str) -> int:
    """queued/running 실행을 닫고 러너에 취소를 알린다. 이후 도착하는 콜백은 internal.py 가 감사용으로만 받는다."""
    rows = (
        await db.execute(
            select(Execution).where(Execution.attempt_id == attempt_id, Execution.status.in_(("queued", "running")))
        )
    ).scalars().all()
    if not rows:
        return 0
    try:
        from .runqueue import get_redis

        r = get_redis()
        for e in rows:
            await r.sadd(CANCEL_KEY, str(e.id))
        await r.expire(CANCEL_KEY, 300)
    except Exception:  # noqa: BLE001 — 취소 통지 실패가 종료를 막아선 안 된다
        log.warning("cancel notify failed attempt=%s", attempt_id)
    now = utcnow()
    for e in rows:
        e.status = "error"
        e.stderr = ((e.stderr or "") + f"\n[{reason}]").strip()
        e.finished_at = now
    return len(rows)


async def finalize_attempt(
    db: AsyncSession,
    attempt_id: uuid.UUID,
    status: str,
    *,
    actor: str = "candidate",
    submitted_at: datetime | None = None,
) -> Attempt | None:
    """응시를 끝낸다. 이미 끝났으면 그대로 돌려준다. 행 잠금 아래에서 상태·취소·스냅샷·이벤트를 한 번에."""
    assert status in ("submitted", "expired")
    attempt = (
        await db.execute(select(Attempt).where(Attempt.id == attempt_id).with_for_update())
    ).scalar_one_or_none()
    if attempt is None:
        return None
    if attempt.status != "in_progress":
        return attempt

    attempt.status = status
    attempt.submitted_at = submitted_at or utcnow()
    cancelled = await cancel_open_executions(
        db, attempt.id, "제출로 취소됨" if status == "submitted" else "마감으로 취소됨"
    )
    # 스냅샷은 취소 뒤에 잰다 — 취소된 실행의 결과는 반영되지 않으므로 이 값이 최종이다
    attempt.snapshot = await _snapshot(db, attempt)
    db.add(
        Event(
            attempt_id=attempt.id,
            type="attempt_submitted" if status == "submitted" else "attempt_expired",
            payload={
                "actor": actor,
                "cancelled_executions": cancelled,
                "snapshot": {sid: {"digest": v["digest"], "files": v["files"]} for sid, v in attempt.snapshot.items()},
            },
        )
    )
    await db.commit()
    log.info("attempt %s finalized status=%s actor=%s cancelled=%d", attempt.id, status, actor, cancelled)
    return attempt

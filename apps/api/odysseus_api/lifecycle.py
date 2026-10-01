"""응시 종료(제출·만료·관리자 종료)의 단일 경로 (ODY-007).

종료는 여러 곳에서 일어난다 — 마지막 문제 제출, 시험 종료 버튼, 마감 경과, 관리자 세션 종료.
어디서 시작했든 여기서 같은 일을 같은 순서로 한다:

  1. 응시 행을 잠근다 (SELECT … FOR UPDATE) — 늦게 도착하는 러너 콜백과 경쟁하지 않는다.
  2. 상태를 바꾼다 (submitted | expired).
  3. 남아 있는 실행(queued/running)을 취소한다 — 러너에 취소를 알리고 기록은 error 로 닫는다.
  4. 시나리오별 워크스페이스 스냅샷 요약을 응시에 남긴다.
     응시 시작 때 고정한 `_definition` / `_definition_hash` 는 절대 덮어쓰지 않는다.
  5. 이벤트를 남기고 커밋한다.
"""

from __future__ import annotations

import hashlib
import logging
import uuid
from datetime import datetime

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from .definitions import DEFINITION_HASH_KEY, DEFINITION_KEY, definition_for_attempt
from .models import Attempt, Event, Execution, MessengerMessage, WorkspaceFile, utcnow

log = logging.getLogger("odysseus.lifecycle")

CANCEL_KEY = "odysseus:runner:cancel"
CANCEL_TTL_S = 6 * 3600


async def workspace_digest(db: AsyncSession, attempt_id: uuid.UUID, scenario_id: uuid.UUID) -> dict:
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
    definition = await definition_for_attempt(db, attempt, persist_legacy=False)
    previous = dict(attempt.snapshot or {})
    # `_` 로 시작하는 키는 시나리오 요약이 아니라 **응시 메타데이터**다 (_definition, _grants…).
    # 여기서 snapshot 을 다시 짓기 때문에, 명시적으로 옮기지 않으면 종료하는 순간 조용히 사라진다 —
    # 관리자가 준 보정 기록이 그렇게 없어지면 "왜 이 응시만 질문이 33회였나" 를 나중에 설명할 수 없다.
    snap: dict[str, object] = {k: v for k, v in previous.items() if k.startswith("_")}
    snap[DEFINITION_KEY] = previous.get(DEFINITION_KEY, definition)
    snap[DEFINITION_HASH_KEY] = previous.get(DEFINITION_HASH_KEY, definition.get("definition_hash"))
    for spec in definition.get("scenarios") or []:
        try:
            scenario_id = uuid.UUID(str(spec.get("scenario_id")))
        except (TypeError, ValueError):
            continue
        ordinal = int(spec.get("ordinal", 0) or 0)
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
    """Close queued/running work and leave durable-enough cancellation tombstones for the runner."""
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
        # Queue backlogs can exceed five minutes. Keep tombstones for the full attempt telemetry window.
        await r.expire(CANCEL_KEY, CANCEL_TTL_S)
    except Exception:  # noqa: BLE001 — 취소 통지 실패가 종료를 막아선 안 된다
        log.warning("cancel notify failed attempt=%s", attempt_id)
    now = utcnow()
    for e in rows:
        e.status = "error"
        e.stderr = ((e.stderr or "") + f"\n[{reason}]").strip()
        e.finished_at = now
        # Even if a stale worker later executes the old queue payload, its callback can no longer mutate state.
        e.callback_token = None
        e.input_files = None
    return len(rows)


async def finalize_attempt(
    db: AsyncSession,
    attempt_id: uuid.UUID,
    status: str,
    *,
    actor: str = "candidate",
    submitted_at: datetime | None = None,
) -> Attempt | None:
    assert status in ("submitted", "expired")
    # 잠근 뒤 행을 다시 읽는다. 호출부가 앞서 읽어 둔 객체를 그대로 쓰면, 그 사이 커밋된 보정
    # (연장·질문 추가)을 모른 채 옛 마감으로 닫고 _grants 를 옛 스냅샷으로 덮어쓴다.
    attempt = (
        await db.execute(
            select(Attempt)
            .where(Attempt.id == attempt_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
    ).scalar_one_or_none()
    if attempt is None:
        return None
    if attempt.status != "in_progress":
        return attempt
    if status == "expired":
        # 마감은 잠근 행의 값으로 판단한다 — 호출부가 옛 마감을 보고 불렀는데 그 사이 연장됐으면 닫지 않는다
        if utcnow() <= attempt.deadline_at:
            return attempt
        submitted_at = attempt.deadline_at

    attempt.status = status
    attempt.submitted_at = submitted_at or utcnow()
    cancelled = await cancel_open_executions(
        db, attempt.id, "제출로 취소됨" if status == "submitted" else "마감으로 취소됨"
    )
    attempt.snapshot = await _snapshot(db, attempt)
    public_snapshot = {
        sid: {"digest": v["digest"], "files": v["files"]}
        for sid, v in attempt.snapshot.items()
        if not sid.startswith("_") and isinstance(v, dict) and "digest" in v
    }
    db.add(
        Event(
            attempt_id=attempt.id,
            type="attempt_submitted" if status == "submitted" else "attempt_expired",
            payload={
                "actor": actor,
                "cancelled_executions": cancelled,
                "definition_hash": attempt.snapshot.get(DEFINITION_HASH_KEY),
                "snapshot": public_snapshot,
            },
        )
    )
    await db.commit()
    log.info("attempt %s finalized status=%s actor=%s cancelled=%d", attempt.id, status, actor, cancelled)
    _grade_after_finish(attempt)
    return attempt


def _grade_after_finish(attempt: Attempt) -> None:
    """끝난 응시는 채점한다 — 누가 어떻게 끝냈든.

    [시험 종료]든 마지막 문제 제출이든 마감이든 관리자의 강제 종료든, 끝났다는 사실은 하나고 채점도
    하나다(grading). 응답을 붙잡지 않으려고 기다리지 않으며, 걸지 못해도 종료는 이미 커밋된 일이다.
    """
    from .grading import schedule

    try:
        schedule(attempt.id)
    except Exception:  # noqa: BLE001
        log.exception("attempt %s: 채점을 걸지 못했습니다", attempt.id)

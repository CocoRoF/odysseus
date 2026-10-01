"""Execution delivery reconciliation and stale-run recovery.

PostgreSQL owns the durable execution state and exact input snapshot. Redis is a delivery layer:
- queued rows are idempotently replayed when Redis/API delivery was interrupted;
- running rows that outlive the sandbox + callback safety window are closed and cancelled so a dead
  runner cannot consume an attempt's concurrency slot forever.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import timedelta

from sqlalchemy import select, update

from . import workspace as ws
from .config import settings
from .db import SessionLocal
from .definitions import scenario_run_timeout
from .models import Event, Execution, utcnow
from .runqueue import enqueue_marker, enqueue_run, get_redis

log = logging.getLogger("odysseus.queue-recovery")
RECONCILE_INTERVAL_S = 15.0
BATCH_SIZE = 100
CANCEL_KEY = "odysseus:runner:cancel"
STALE_RUNNING_MIN_S = 5 * 60
# queued 인 채로 이만큼 지나면 더 기다리지 않는다 — 서명 불일치로 러너가 버렸거나 RUNNER_ID 가 바뀌어
# processing 리스트에 고아가 된 작업이 마커 TTL(24h) 동안 응시자의 동시 실행 슬롯을 붙들지 않게.
STALE_QUEUED_S = 30 * 60


async def reconcile_once() -> int:
    recovered = 0
    async with SessionLocal() as db:
        rows = (
            await db.execute(
                select(Execution)
                .where(Execution.status == "queued", Execution.callback_token.is_not(None))
                .order_by(Execution.created_at)
                .limit(BATCH_SIZE)
            )
        ).scalars().all()
        for execution in rows:
            try:
                try:
                    # 이미 Redis 에 들어가 있으면(마커 존재) 큰 payload 를 매 주기 다시 직렬화하지 않는다.
                    if await get_redis().exists(enqueue_marker(str(execution.id))):
                        continue
                except Exception:  # noqa: BLE001 — Redis 가 없으면 아래 enqueue 가 False 를 돌려준다
                    pass
                input_files = execution.input_files
                if input_files is None:
                    legacy_rows = await ws.list_files(db, execution.attempt_id, execution.scenario_id)
                    input_files = ws.files_payload(legacy_rows)
                added = await enqueue_run(
                    str(execution.id),
                    execution.command,
                    input_files,
                    # 원래 요청과 같은 제한 시간으로 되돌린다 — 복구된 실행만 다른 조건으로 돌면
                    # 같은 명령이 Redis 사정에 따라 통과하기도 실패하기도 한다.
                    await scenario_run_timeout(db, execution.attempt_id, execution.scenario_id),
                    attempt_id=str(execution.attempt_id),
                    scenario_id=str(execution.scenario_id),
                    source=execution.source,
                    callback_token=execution.callback_token or "",
                )
                recovered += int(added)
            except Exception as exc:  # noqa: BLE001 — recovery continues next interval
                log.warning("queued execution reconciliation failed id=%s: %s", execution.id, type(exc).__name__)
    return recovered


async def _started_at(db, execution: Execution):
    """Read the server-observed runner start timestamp from the append-only event log."""
    rows = (
        await db.execute(
            select(Event)
            .where(
                Event.attempt_id == execution.attempt_id,
                Event.scenario_id == execution.scenario_id,
                Event.type == "run_started",
            )
            .order_by(Event.created_at.desc())
            .limit(50)
        )
    ).scalars().all()
    expected = str(execution.id)
    for event in rows:
        if str((event.payload or {}).get("execution_id") or "") == expected:
            return event.created_at
    return None


async def _close_stale(db, execution: Execution, *, from_status: str, note: str, threshold_s: int) -> bool:
    """Conditional close: 결과 콜백이 먼저 들어와 done 으로 바뀐 행은 덮어쓰지 않는다."""
    result = await db.execute(
        update(Execution)
        .where(Execution.id == execution.id, Execution.status == from_status)
        .values(
            status="error",
            stderr=((execution.stderr or "") + f"\n[{note}]").strip(),
            finished_at=utcnow(),
            callback_token=None,
            input_files=None,
        )
    )
    if result.rowcount != 1:
        return False
    db.add(
        Event(
            attempt_id=execution.attempt_id,
            scenario_id=execution.scenario_id,
            type="run_stale_reaped",
            payload={
                "execution_id": str(execution.id),
                "from_status": from_status,
                "threshold_s": threshold_s,
                "actor": "queue_recovery",
            },
        )
    )
    try:
        r = get_redis()
        await r.sadd(CANCEL_KEY, str(execution.id))
        await r.expire(CANCEL_KEY, 6 * 3600)
        await r.delete(enqueue_marker(str(execution.id)))
    except Exception:  # noqa: BLE001 — DB closure must not depend on Redis availability
        pass
    return True


async def reap_stale_running() -> int:
    """Close executions whose runner vanished after marking them running."""
    threshold_s = max(STALE_RUNNING_MIN_S, int(settings.run_timeout_s) + 180)
    cutoff = utcnow() - timedelta(seconds=threshold_s)
    reaped = 0
    async with SessionLocal() as db:
        running = (
            await db.execute(
                select(Execution)
                .where(Execution.status == "running", Execution.callback_token.is_not(None))
                .order_by(Execution.created_at)
                .limit(BATCH_SIZE)
            )
        ).scalars().all()
        for execution in running:
            started = await _started_at(db, execution)
            # Old versions did not emit run_started. created_at is a conservative compatibility fallback.
            observed = started or execution.created_at
            if not observed or observed > cutoff:
                continue
            if await _close_stale(
                db, execution, from_status="running", note="러너 응답이 장시간 없어 고아 실행을 자동 종료했습니다", threshold_s=threshold_s
            ):
                reaped += 1
        if reaped:
            await db.commit()
    return reaped


async def reap_stale_queued() -> int:
    """Close executions that no runner ever claimed within the queued window."""
    cutoff = utcnow() - timedelta(seconds=STALE_QUEUED_S)
    reaped = 0
    async with SessionLocal() as db:
        queued = (
            await db.execute(
                select(Execution)
                .where(Execution.status == "queued", Execution.created_at < cutoff)
                .order_by(Execution.created_at)
                .limit(BATCH_SIZE)
            )
        ).scalars().all()
        for execution in queued:
            if await _close_stale(
                db, execution, from_status="queued", note="러너가 오래 받아가지 않아 실행을 취소했습니다", threshold_s=STALE_QUEUED_S
            ):
                reaped += 1
        if reaped:
            await db.commit()
    return reaped


async def recovery_loop() -> None:
    while True:
        try:
            count = await reconcile_once()
            if count:
                log.warning("re-enqueued %d committed executions missing from Redis pending queue", count)
            stale = await reap_stale_running()
            if stale:
                log.warning("reaped %d stale running executions", stale)
            stuck = await reap_stale_queued()
            if stuck:
                log.warning("reaped %d executions stuck in queued", stuck)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            log.exception("execution queue reconciliation failed")
        await asyncio.sleep(RECONCILE_INTERVAL_S)

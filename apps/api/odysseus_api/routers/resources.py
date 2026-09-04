"""자원 현황 — 응시자의 사용량 표시와 관리자의 자원 관리 화면.

러너가 1초마다 Redis 에 게시하는 스냅샷(`odysseus:runner:stats`)을 읽어,
응시자에게는 **자기 실행분만**, 관리자에게는 전체와 세션 목록을 준다.
러너가 죽거나 재시작되면 스냅샷은 만료되어 사라지므로, 없으면 없다고 말한다.
"""

import json
import uuid
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from ..db import get_db
from ..deps import get_current_user, is_staff, require_admin
from ..models import Attempt, Event, Execution, User, WorkspaceFile, utcnow
from ..runqueue import get_redis

router = APIRouter(tags=["resources"])

STATS_KEY = "odysseus:runner:stats"
CANCEL_KEY = "odysseus:runner:cancel"

# 이 시간 넘게 아무 활동이 없는 진행 중 응시는 '방치'로 본다
IDLE_THRESHOLD = timedelta(minutes=30)
# 러너 스냅샷에 없는데 계속 running 인 실행은 유실된 것이다
ORPHAN_EXEC_GRACE = timedelta(minutes=5)


async def _snapshot() -> dict | None:
    try:
        raw = await get_redis().get(STATS_KEY)
    except Exception:
        return None
    return json.loads(raw) if raw else None


def _empty_container() -> dict:
    return {"cpu_percent": 0.0, "memory_bytes": 0, "memory_limit_bytes": None, "cpu_count": None}


# ── 응시자: 내 실행의 자원 ───────────────────────────────────────


@router.get("/attempts/{attempt_id}/resources")
async def my_resources(
    attempt_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """작업 표시줄의 자원 막대가 읽는 값 — 남의 실행은 절대 섞이지 않는다."""
    attempt = await db.get(Attempt, attempt_id)
    if not attempt:
        raise HTTPException(404, "attempt not found")
    if attempt.user_id != user.id and not is_staff(user):
        raise HTTPException(403, "권한이 없습니다")

    snap = await _snapshot()
    mine = [r for r in (snap or {}).get("active", []) if r.get("attempt_id") == str(attempt_id)]
    last_run = None
    stats = {"runs": 0, "cpu_seconds": 0.0}
    try:
        raw_last = await get_redis().get(f"odysseus:attempt:{attempt_id}:lastrun")
        if raw_last:
            last_run = json.loads(raw_last)
        h = await get_redis().hgetall(f"odysseus:attempt:{attempt_id}:stats")
        if h:
            stats = {"runs": int(h.get("runs", 0)), "cpu_seconds": round(float(h.get("cpu_seconds", 0)), 2)}
    except Exception:
        pass
    cpu = round(sum(r.get("cpu_percent", 0) for r in mine), 1)
    mem = sum(r.get("memory_bytes", 0) for r in mine)
    limit = (snap or {}).get("container", {}).get("memory_limit_bytes")
    cores = (snap or {}).get("container", {}).get("cpu_count") or 1

    return {
        "online": snap is not None,
        "running": len(mine),
        "cpu_percent": cpu,
        # 코어 여러 개를 쓸 수 있으므로 100%가 상한이 아니다 — 막대는 이 값으로 정규화한다
        "cpu_capacity_percent": cores * 100,
        "memory_bytes": mem,
        "memory_limit_bytes": limit,
        # 실행이 짧아 순간값을 놓쳐도 '방금 무엇이 얼마나 돌았는지'는 보여 준다
        "last_run": last_run,
        "stats": stats,
        "commands": [
            {"command": r.get("command", ""), "elapsed_s": r.get("elapsed_s", 0), "source": r.get("source")}
            for r in mine
        ],
    }


# ── 관리자: 자원 관리 대시보드 ──────────────────────────────────


@router.get("/admin/resources", dependencies=[Depends(require_admin)])
async def admin_resources(db: AsyncSession = Depends(get_db)):
    snap = await _snapshot()
    now = utcnow()

    # 진행 중인 응시 세션 + 마지막 활동 시각
    attempts = (
        await db.execute(
            select(Attempt)
            .where(Attempt.status == "in_progress")
            .options(selectinload(Attempt.user), selectinload(Attempt.assessment))
            .order_by(Attempt.started_at)
        )
    ).scalars().all()

    last_event: dict[uuid.UUID, object] = {}
    if attempts:
        rows = await db.execute(
            select(Event.attempt_id, func.max(Event.created_at))
            .where(Event.attempt_id.in_([a.id for a in attempts]))
            .group_by(Event.attempt_id)
        )
        last_event = {aid: ts for aid, ts in rows.all()}

    file_counts: dict[uuid.UUID, int] = {}
    if attempts:
        rows = await db.execute(
            select(WorkspaceFile.attempt_id, func.count())
            .where(WorkspaceFile.attempt_id.in_([a.id for a in attempts]))
            .group_by(WorkspaceFile.attempt_id)
        )
        file_counts = {aid: n for aid, n in rows.all()}

    active_by_attempt: dict[str, int] = {}
    for r in (snap or {}).get("active", []):
        key = r.get("attempt_id") or ""
        active_by_attempt[key] = active_by_attempt.get(key, 0) + 1

    sessions = []
    for a in attempts:
        seen = last_event.get(a.id) or a.started_at
        idle_s = (now - seen).total_seconds() if seen else None
        expired = bool(a.deadline_at and a.deadline_at < now)
        sessions.append(
            {
                "attempt_id": str(a.id),
                "user_name": a.user.name if a.user else "—",
                "user_email": a.user.email if a.user else "",
                "assessment_title": a.assessment.title if a.assessment else "—",
                "started_at": a.started_at,
                "deadline_at": a.deadline_at,
                "last_seen_at": seen,
                "idle_seconds": int(idle_s) if idle_s is not None else None,
                "expired": expired,
                # 마감이 지났거나 오래 방치된 세션 — 자원만 잡고 있는 '고아'
                "orphan": expired or (idle_s is not None and idle_s > IDLE_THRESHOLD.total_seconds()),
                "workspace_files": file_counts.get(a.id, 0),
                "running": active_by_attempt.get(str(a.id), 0),
            }
        )

    # 러너가 모르는데 계속 running 인 실행 = 유실된 실행
    live_ids = {r.get("execution_id") for r in (snap or {}).get("active", [])}
    stuck_rows = (
        await db.execute(
            select(Execution)
            .where(Execution.status.in_(("queued", "running")))
            .order_by(Execution.created_at)
            .limit(200)
        )
    ).scalars().all()
    stuck = [
        {
            "execution_id": str(e.id),
            "attempt_id": str(e.attempt_id),
            "status": e.status,
            "source": e.source,
            "command": (e.command or "")[:160],
            "created_at": e.created_at,
            "age_seconds": int((now - e.created_at).total_seconds()),
        }
        for e in stuck_rows
        if str(e.id) not in live_ids
        and (now - e.created_at) > ORPHAN_EXEC_GRACE
    ]

    return {
        "online": snap is not None,
        "updated_at": (snap or {}).get("updated_at"),
        "concurrency": (snap or {}).get("concurrency"),
        "queue_depth": (snap or {}).get("queue_depth", 0),
        "container": (snap or {}).get("container") or _empty_container(),
        "active": (snap or {}).get("active", []),
        "sessions": sessions,
        "stuck_executions": stuck,
    }


@router.post("/admin/resources/executions/{execution_id}/kill", dependencies=[Depends(require_admin)])
async def kill_execution(execution_id: uuid.UUID, db: AsyncSession = Depends(get_db)):
    """실행 강제 종료 — 러너에게 요청을 남기고, DB 상태도 즉시 닫는다."""
    execution = await db.get(Execution, execution_id)
    if not execution:
        raise HTTPException(404, "execution not found")
    try:
        await get_redis().sadd(CANCEL_KEY, str(execution_id))
        await get_redis().expire(CANCEL_KEY, 300)
    except Exception:
        pass
    if execution.status in ("queued", "running"):
        execution.status = "error"
        execution.stderr = (execution.stderr or "") + "\n[관리자가 실행을 종료했습니다]"
        execution.finished_at = utcnow()
        await db.commit()
    return {"ok": True}


@router.post("/admin/resources/attempts/{attempt_id}/terminate", dependencies=[Depends(require_admin)])
async def terminate_attempt(attempt_id: uuid.UUID, db: AsyncSession = Depends(get_db)):
    """세션 종료 — 응시를 제출 처리하고, 남은 실행이 있으면 함께 끊는다."""
    attempt = await db.get(Attempt, attempt_id)
    if not attempt:
        raise HTTPException(404, "attempt not found")
    if attempt.status != "in_progress":
        return {"ok": True, "already": attempt.status}
    from ..lifecycle import finalize_attempt

    done = await finalize_attempt(db, attempt_id, "submitted", actor="admin")
    killed = 0
    if done and done.snapshot is not None:
        ev = (
            await db.execute(
                select(Event).where(Event.attempt_id == attempt_id, Event.type == "attempt_submitted").order_by(Event.created_at.desc())
            )
        ).scalars().first()
        killed = int((ev.payload or {}).get("cancelled_executions", 0)) if ev else 0
    return {"ok": True, "killed_executions": killed}


@router.post("/admin/resources/cleanup", dependencies=[Depends(require_admin)])
async def cleanup(db: AsyncSession = Depends(get_db)):
    """고아 정리 — 마감이 지난 세션을 닫고, 유실된 실행을 종료 상태로 확정한다."""
    now = utcnow()
    closed = 0
    expired = (
        await db.execute(
            select(Attempt).where(Attempt.status == "in_progress", Attempt.deadline_at < now)
        )
    ).scalars().all()
    for a in expired:
        a.status = "expired"
        a.submitted_at = now
        db.add(Event(attempt_id=a.id, type="attempt_expired", payload={"actor": "cleanup"}))
        closed += 1

    snap = await _snapshot()
    live_ids = {r.get("execution_id") for r in (snap or {}).get("active", [])}
    stale = (
        await db.execute(
            select(Execution).where(Execution.status.in_(("queued", "running")))
        )
    ).scalars().all()
    freed = 0
    for e in stale:
        if str(e.id) in live_ids or (now - e.created_at) <= ORPHAN_EXEC_GRACE:
            continue
        e.status = "error"
        e.stderr = (e.stderr or "") + "\n[러너에서 사라진 실행 — 정리됨]"
        e.finished_at = now
        freed += 1

    await db.commit()
    return {"closed_attempts": closed, "freed_executions": freed}

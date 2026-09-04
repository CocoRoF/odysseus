"""응시 생명주기 — 시작(워크스페이스 물질화 + 오프닝 메시지), 상태, 행동 이벤트, 종료, 재응시."""

import hashlib
import uuid
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from ..config import settings
from ..db import get_db
from ..deps import get_current_user
from ..models import (
    Assessment,
    AssessmentScenario,
    Assignment,
    Attempt,
    Event,
    MessengerMessage,
    Scenario,
    User,
    WorkspaceFile,
    utcnow,
)
from ..lifecycle import finalize_attempt
from ..schemas import AttemptOut, AttemptScenarioOut, EventBatchIn, MyAssignmentOut

router = APIRouter(tags=["attempts"])

# 마감 뒤 **행동 이벤트 플러시만** 받아 주는 유예 (ODY-007). 파일·실행·대화 등 변경은 마감 즉시 거부된다.
EVENT_FLUSH_GRACE = timedelta(seconds=45)

# 응시 클라이언트가 기록할 수 있는 행동 이벤트 화이트리스트
ALLOWED_EVENT_TYPES = {
    "focus_lost",
    "focus_gained",
    "tab_hidden",
    "tab_visible",
    "window_blur",
    "window_focus",
    "paste",
    "copy",
    "cut",
    "app_open",
    "app_close",
    "file_open",
    "page_enter",
    "page_exit",
    "net_offline",
    "net_online",
    "exam_leave",
}
# 참고자료 검색·열람은 서버가 직접 기록한다 (reference.py) — 브라우저가 보고한 값을 받으면 위조가 된다.

# 브라우저 보고 이벤트의 payload 는 이 키만, 이 크기까지만 남긴다 (ODY-017)
CLIENT_PAYLOAD_KEYS = {"away_ms", "chars", "text", "app", "path", "page", "reason", "seq", "client_id"}
CLIENT_TEXT_MAX = 500
CLIENT_SEQ_KEY = "odysseus:attempt:{aid}:client_seq"


def sanitize_client_payload(payload: dict) -> dict:
    out: dict = {}
    for k, v in (payload or {}).items():
        if k not in CLIENT_PAYLOAD_KEYS:
            continue
        if isinstance(v, bool) or v is None:
            out[k] = v
        elif isinstance(v, (int, float)):
            out[k] = v if abs(v) < 1e12 else None
        else:
            out[k] = str(v)[:CLIENT_TEXT_MAX]
    return out


async def check_expired(attempt: Attempt, db: AsyncSession) -> Attempt:
    """마감이 지났으면 그 자리에서 종료한다 — 유예 없음. 종료 절차는 lifecycle 이 한 곳에서 한다."""
    if attempt.status == "in_progress" and utcnow() > attempt.deadline_at:
        done = await finalize_attempt(db, attempt.id, "expired", actor="deadline", submitted_at=attempt.deadline_at)
        return done or attempt
    return attempt


async def get_attempt_for(attempt_id: uuid.UUID, user: User, db: AsyncSession) -> Attempt:
    attempt = await db.get(Attempt, attempt_id)
    if not attempt:
        raise HTTPException(404, "응시 정보를 찾을 수 없습니다")
    if user.role == "candidate" and attempt.user_id != user.id:
        raise HTTPException(403, "본인의 응시만 볼 수 있습니다")
    return await check_expired(attempt, db)


async def require_own_active(attempt_id: uuid.UUID, user: User, db: AsyncSession) -> Attempt:
    """본인 소유 + 진행중 응시 — 데스크톱 조작 계열 엔드포인트 공통 가드."""
    attempt = await get_attempt_for(attempt_id, user, db)
    if attempt.user_id != user.id:
        raise HTTPException(403, "본인의 응시에서만 사용할 수 있습니다")
    if attempt.status != "in_progress":
        raise HTTPException(400, "이미 종료된 시험입니다")
    return attempt


async def _scenario_link(attempt: Attempt, scenario_id: uuid.UUID, db: AsyncSession) -> AssessmentScenario:
    link = (
        await db.execute(
            select(AssessmentScenario).where(
                AssessmentScenario.assessment_id == attempt.assessment_id,
                AssessmentScenario.scenario_id == scenario_id,
            )
        )
    ).scalar_one_or_none()
    if not link:
        raise HTTPException(404, "이 시험에 포함되지 않은 시나리오입니다")
    return link


def _is_taker(attempt: Attempt, user: User | None) -> bool:
    """지금 이 응시를 '치르는 중'인 본인인가 — 잠금 규칙은 이 경우에만 적용한다.

    (스태프가 남의 응시를 리뷰할 때는 전 구간을 볼 수 있어야 한다.)
    """
    return bool(user) and attempt.user_id == user.id and attempt.status == "in_progress"


async def scenario_in_attempt(
    attempt: Attempt,
    scenario_id: uuid.UUID,
    db: AsyncSession,
    user: User | None = None,
    *,
    mutate: bool = False,
) -> Scenario:
    """시나리오 접근 가드.

    다중 시나리오 시험은 **순차 진행**이다. 응시 중인 본인에게는
      · 아직 순서가 오지 않은 시나리오 → 잠김(423)
      · 이미 제출한 시나리오 → 읽기만 허용(쓰기는 423)
    """
    link = await _scenario_link(attempt, scenario_id, db)
    scenario = await db.get(Scenario, scenario_id)
    if not scenario:
        raise HTTPException(404, "시나리오를 찾을 수 없습니다")

    if _is_taker(attempt, user):
        if link.ordinal > attempt.current_ordinal:
            raise HTTPException(423, "아직 잠긴 문제입니다. 앞선 문제를 먼저 제출하세요")
        if mutate and link.ordinal < attempt.current_ordinal:
            raise HTTPException(423, "이미 제출한 문제입니다. 되돌아갈 수 없습니다")
    return scenario


def _scenario_status(attempt: Attempt, ordinal: int) -> str:
    """completed | in_progress | locked.

    시험이 끝난 뒤에는 진행 중이던 문제도 제출된 것으로 본다 (마지막 문제가
    영원히 '진행 중'으로 남지 않도록).
    """
    if ordinal < attempt.current_ordinal:
        return "completed"
    if ordinal > attempt.current_ordinal:
        return "locked"
    return "in_progress" if attempt.status == "in_progress" else "completed"


async def _attempt_out(attempt: Attempt, db: AsyncSession) -> AttemptOut:
    from .settings import get_ui_settings

    assessment = await db.get(Assessment, attempt.assessment_id)
    ui = await get_ui_settings(db)
    links = (
        await db.execute(
            select(AssessmentScenario)
            .where(AssessmentScenario.assessment_id == attempt.assessment_id)
            .options(selectinload(AssessmentScenario.scenario))
            .order_by(AssessmentScenario.ordinal)
        )
    ).scalars().all()
    scenarios = [
        AttemptScenarioOut(
            scenario_id=link.scenario_id,
            title=link.scenario.title,
            # 잠긴 문제의 브리핑은 미리 보여주지 않는다 (스포일러 방지)
            briefing_md=(
                link.scenario.briefing_md if link.ordinal <= attempt.current_ordinal else ""
            ),
            ordinal=link.ordinal,
            points=link.points,
            status=_scenario_status(attempt, link.ordinal),
            agent_enabled=link.scenario.agent_enabled,
            characters=[
                {
                    "key": c.get("key"),
                    "name": c.get("name"),
                    "role": c.get("role", ""),
                    "color": c.get("color", "#6366f1"),
                }
                for c in (link.scenario.characters or [])
            ],
        )
        for link in links
    ]
    return AttemptOut(
        id=attempt.id,
        assessment_id=attempt.assessment_id,
        assessment_title=assessment.title,
        status=attempt.status,
        started_at=attempt.started_at,
        deadline_at=attempt.deadline_at,
        submitted_at=attempt.submitted_at,
        agent_max_turns=assessment.agent_max_turns,
        current_ordinal=attempt.current_ordinal,
        gamified_intro=bool(ui.get("gamified_intro")),
        scenarios=scenarios,
    )


@router.get("/my/assignments", response_model=list[MyAssignmentOut])
async def my_assignments(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    is_staff = user.role in ("admin", "evaluator")
    assigned_ids: set[uuid.UUID] = {
        r
        for r in (
            await db.execute(select(Assignment.assessment_id).where(Assignment.user_id == user.id))
        ).scalars()
    }
    if is_staff:
        assessments = (
            await db.execute(
                select(Assessment)
                .options(selectinload(Assessment.scenarios))
                .order_by(Assessment.created_at.desc())
            )
        ).scalars().all()
    else:
        assessments = [
            asg.assessment
            for asg in (
                await db.execute(
                    select(Assignment)
                    .where(Assignment.user_id == user.id)
                    .options(selectinload(Assignment.assessment).selectinload(Assessment.scenarios))
                    .order_by(Assignment.created_at.desc())
                )
            ).scalars()
        ]

    attempts = (
        await db.execute(select(Attempt).where(Attempt.user_id == user.id).order_by(Attempt.started_at))
    ).scalars().all()
    for at in attempts:
        await check_expired(at, db)
    attempt_by_assessment = {at.assessment_id: at for at in attempts if not at.superseded}
    return [
        MyAssignmentOut(
            assessment_id=a.id,
            title=a.title,
            description=a.description,
            duration_min=a.duration_min,
            scenario_count=len(a.scenarios),
            starts_at=a.starts_at,
            ends_at=a.ends_at,
            attempt_id=(attempt_by_assessment.get(a.id).id if attempt_by_assessment.get(a.id) else None),
            attempt_status=(
                attempt_by_assessment.get(a.id).status if attempt_by_assessment.get(a.id) else None
            ),
            assigned=a.id in assigned_ids,
        )
        for a in assessments
    ]


async def _materialize(attempt: Attempt, db: AsyncSession) -> None:
    """시작 시점: 시나리오별 초기 파일 + 오프닝 메신저 메시지 생성."""
    links = (
        await db.execute(
            select(AssessmentScenario)
            .where(AssessmentScenario.assessment_id == attempt.assessment_id)
            .options(selectinload(AssessmentScenario.scenario))
            .order_by(AssessmentScenario.ordinal)
        )
    ).scalars().all()
    for link in links:
        scenario = link.scenario
        for f in scenario.initial_files or []:
            db.add(
                WorkspaceFile(
                    attempt_id=attempt.id,
                    scenario_id=scenario.id,
                    path=str(f.get("path", "")),
                    content=str(f.get("content", "")),
                )
            )
        for om in scenario.opening_messages or []:
            db.add(
                MessengerMessage(
                    attempt_id=attempt.id,
                    scenario_id=scenario.id,
                    character_key=str(om.get("character_key", "")),
                    sender="npc",
                    content=str(om.get("content", "")),
                    meta={"opening": True},
                )
            )


async def _lock_attempt_slot(db: AsyncSession, assessment_id: uuid.UUID, user_id: uuid.UUID) -> None:
    """(시험, 사용자) 슬롯에 트랜잭션 범위 advisory lock — 커밋/롤백과 함께 풀린다."""
    key = int.from_bytes(hashlib.sha256(f"{assessment_id}:{user_id}".encode()).digest()[:8], "big", signed=True)
    await db.execute(text("SELECT pg_advisory_xact_lock(:k)"), {"k": key})


async def _active_attempt(db: AsyncSession, assessment_id: uuid.UUID, user_id: uuid.UUID) -> Attempt | None:
    return (
        await db.execute(
            select(Attempt)
            .where(Attempt.assessment_id == assessment_id, Attempt.user_id == user_id, Attempt.superseded.is_(False))
            .order_by(Attempt.started_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()


@router.post("/assessments/{assessment_id}/attempts", response_model=AttemptOut)
async def start_attempt(
    assessment_id: uuid.UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    assignment = (
        await db.execute(
            select(Assignment).where(
                Assignment.assessment_id == assessment_id, Assignment.user_id == user.id
            )
        )
    ).scalar_one_or_none()
    if not assignment and user.role not in ("admin", "evaluator"):
        raise HTTPException(403, "이 시험에 배정되지 않았습니다")

    assessment = await db.get(Assessment, assessment_id)
    if not assessment:
        raise HTTPException(404, "시험을 찾을 수 없습니다")
    now = utcnow()
    if assessment.starts_at and now < assessment.starts_at:
        raise HTTPException(400, "아직 시험 시작 시간이 아닙니다")
    if assessment.ends_at and now > assessment.ends_at:
        raise HTTPException(400, "시험 응시 기간이 종료되었습니다")

    # ODY-015: 같은 (시험, 사용자) 의 동시 시작은 트랜잭션 advisory lock 으로 줄 세운다.
    # 잠금 아래에서 조회→생성이 원자적이고, 그래도 겹치면 부분 유일 인덱스가 막는다 (아래 IntegrityError).
    await _lock_attempt_slot(db, assessment_id, user.id)
    existing = await _active_attempt(db, assessment_id, user.id)
    if existing:
        await check_expired(existing, db)
        if existing.status != "in_progress":
            raise HTTPException(400, "이미 종료된 시험입니다")
        return await _attempt_out(existing, db)

    deadline = now + timedelta(minutes=assessment.duration_min)
    if assessment.ends_at and deadline > assessment.ends_at:
        deadline = assessment.ends_at
    attempt = Attempt(assessment_id=assessment_id, user_id=user.id, started_at=now, deadline_at=deadline)
    db.add(attempt)
    try:
        await db.flush()
        await _materialize(attempt, db)
        db.add(
            Event(
                attempt_id=attempt.id,
                type="attempt_started",
                payload={"assessment_id": str(assessment_id), "deadline_at": deadline.isoformat()},
            )
        )
        await db.commit()
    except IntegrityError:
        # 잠금을 우회한 경로(다른 인스턴스 등)에서 먼저 만들어졌다 — 그 응시를 그대로 돌려준다
        await db.rollback()
        existing = await _active_attempt(db, assessment_id, user.id)
        if not existing:
            raise
        return await _attempt_out(existing, db)
    return await _attempt_out(attempt, db)


@router.get("/attempts/{attempt_id}", response_model=AttemptOut)
async def get_attempt(
    attempt_id: uuid.UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    attempt = await get_attempt_for(attempt_id, user, db)
    return await _attempt_out(attempt, db)


@router.post("/attempts/{attempt_id}/events")
async def post_events(
    attempt_id: uuid.UUID,
    body: EventBatchIn,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """브라우저가 보고하는 행동 이벤트 — **신뢰할 수 없는 보조 신호**로만 저장한다 (ODY-017).

    · source=client_untrusted 로 표시되어 서버 관측 이벤트(파일·실행·대화·참고자료·제출)와 구분된다
    · 종류는 화이트리스트, 시나리오는 이 시험에 속한 것만, payload 는 허용 키·크기만 남긴다
    · 클라이언트가 보내는 seq 로 중복은 버리고 빈틈은 서버 이벤트(telemetry_gap)로 남긴다
    """
    attempt = await get_attempt_for(attempt_id, user, db)
    if attempt.user_id != user.id:
        raise HTTPException(403, "본인의 응시에만 기록할 수 있습니다")
    if attempt.status != "in_progress":
        # 종료 직후 도착하는 마지막 플러시(화면 이탈·탭 전환 등)만 짧게 받아 준다 — 변경은 아니다
        ended = attempt.submitted_at or attempt.deadline_at
        if not ended or utcnow() > ended + EVENT_FLUSH_GRACE:
            return {"ok": True, "recorded": 0}
    valid_scenarios = {
        sid
        for (sid,) in (
            await db.execute(
                select(AssessmentScenario.scenario_id).where(AssessmentScenario.assessment_id == attempt.assessment_id)
            )
        ).all()
    }
    # 순서 번호 — Redis 에 마지막 값을 둔다 (없으면 순서 검사를 건너뛴다)
    last_seq: int | None = None
    redis = None
    try:
        from ..runqueue import get_redis

        redis = get_redis()
        raw = await redis.get(CLIENT_SEQ_KEY.format(aid=attempt.id))
        last_seq = int(raw) if raw else 0
    except Exception:  # noqa: BLE001
        redis = None

    recorded = dropped = 0
    for ev in body.events[: settings.max_event_batch]:
        if ev.type not in ALLOWED_EVENT_TYPES:
            dropped += 1
            continue
        if ev.scenario_id is not None and ev.scenario_id not in valid_scenarios:
            dropped += 1
            continue
        payload = sanitize_client_payload(ev.payload)
        seq = payload.get("seq")
        if isinstance(seq, (int, float)) and last_seq is not None:
            seq = int(seq)
            if seq <= last_seq:
                dropped += 1  # 재전송·재생
                continue
            if last_seq and seq > last_seq + 1:
                db.add(
                    Event(
                        attempt_id=attempt.id,
                        scenario_id=ev.scenario_id,
                        type="telemetry_gap",
                        source="server",
                        payload={"expected": last_seq + 1, "got": seq, "missing": seq - last_seq - 1},
                    )
                )
            last_seq = seq
        db.add(
            Event(
                attempt_id=attempt.id,
                scenario_id=ev.scenario_id,
                type=ev.type,
                source="client_untrusted",
                payload=payload,
            )
        )
        recorded += 1
    await db.commit()
    if redis is not None and last_seq:
        try:
            await redis.set(CLIENT_SEQ_KEY.format(aid=attempt.id), str(last_seq), ex=6 * 3600)
        except Exception:  # noqa: BLE001
            pass
    return {"ok": True, "recorded": recorded, "dropped": dropped}


@router.post("/attempts/{attempt_id}/scenarios/{scenario_id}/complete", response_model=AttemptOut)
async def complete_scenario(
    attempt_id: uuid.UUID,
    scenario_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """현재 문제를 제출하고 다음 문제로 넘어간다 (되돌아갈 수 없다).

    마지막 문제였다면 시험 자체가 종료된다.
    """
    attempt = await require_own_active(attempt_id, user, db)
    link = await _scenario_link(attempt, scenario_id, db)
    if link.ordinal != attempt.current_ordinal:
        raise HTTPException(409, "현재 진행 중인 문제가 아닙니다")

    total = (
        await db.execute(
            select(func.count(AssessmentScenario.id)).where(
                AssessmentScenario.assessment_id == attempt.assessment_id
            )
        )
    ).scalar() or 0

    db.add(
        Event(
            attempt_id=attempt.id,
            scenario_id=scenario_id,
            type="scenario_completed",
            payload={"ordinal": link.ordinal, "total": total},
        )
    )
    if link.ordinal + 1 >= total:
        await db.commit()  # scenario_completed 이벤트를 먼저 남기고, 종료는 잠금 아래에서
        attempt = await finalize_attempt(db, attempt.id, "submitted") or attempt
    else:
        attempt.current_ordinal = link.ordinal + 1
        await db.commit()
    return await _attempt_out(attempt, db)


@router.post("/attempts/{attempt_id}/finish", response_model=AttemptOut)
async def finish_attempt(
    attempt_id: uuid.UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    attempt = await get_attempt_for(attempt_id, user, db)
    if attempt.user_id != user.id:
        raise HTTPException(403, "본인의 응시만 종료할 수 있습니다")
    if attempt.status == "in_progress":
        attempt = await finalize_attempt(db, attempt.id, "submitted") or attempt
    return await _attempt_out(attempt, db)


@router.post("/attempts/{attempt_id}/retake", response_model=AttemptOut)
async def retake_attempt(
    attempt_id: uuid.UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    """재응시 — 이전 기록을 superseded로 보존한 채 새 시도를 시작 (스태프는 본인/타인, 응시자는 불가)."""
    attempt = await db.get(Attempt, attempt_id)
    if not attempt:
        raise HTTPException(404, "응시 정보를 찾을 수 없습니다")
    if user.role == "candidate":
        raise HTTPException(403, "재응시는 관리자가 허용해야 합니다")
    if user.role == "evaluator" and attempt.user_id != user.id:
        raise HTTPException(403, "평가자는 본인 체험 응시만 재응시할 수 있습니다")

    # ODY-015: 같은 슬롯의 잠금 아래에서 '이전 것 superseded + 새 것 생성' 을 한 트랜잭션으로.
    # 두 관리자가 동시에 재응시를 눌러도 활성 응시는 하나만 남는다.
    await _lock_attempt_slot(db, attempt.assessment_id, attempt.user_id)
    await db.refresh(attempt)
    if attempt.superseded:
        current = await _active_attempt(db, attempt.assessment_id, attempt.user_id)
        if current:
            return await _attempt_out(current, db)
    for other in (
        await db.execute(
            select(Attempt).where(
                Attempt.assessment_id == attempt.assessment_id,
                Attempt.user_id == attempt.user_id,
                Attempt.superseded.is_(False),
            )
        )
    ).scalars().all():
        other.superseded = True
        db.add(Event(attempt_id=other.id, type="attempt_superseded", payload={"by": str(user.id)}))
    await db.flush()

    assessment = await db.get(Assessment, attempt.assessment_id)
    now = utcnow()
    deadline = now + timedelta(minutes=assessment.duration_min)
    new_attempt = Attempt(
        assessment_id=attempt.assessment_id, user_id=attempt.user_id, started_at=now, deadline_at=deadline
    )
    db.add(new_attempt)
    await db.flush()
    await _materialize(new_attempt, db)
    db.add(
        Event(attempt_id=new_attempt.id, type="attempt_started", payload={"retake_of": str(attempt.id)})
    )
    await db.commit()
    return await _attempt_out(new_attempt, db)


@router.delete("/attempts/{attempt_id}")
async def delete_attempt(
    attempt_id: uuid.UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    """응시 기록 완전 삭제 — admin 전용 (데모/정리용)."""
    if user.role != "admin":
        raise HTTPException(403, "관리자만 삭제할 수 있습니다")
    attempt = await db.get(Attempt, attempt_id)
    if not attempt:
        raise HTTPException(404, "응시 정보를 찾을 수 없습니다")
    await db.delete(attempt)
    await db.commit()
    return {"ok": True}

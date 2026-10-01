"""응시 생명주기 — 시작(정의 고정 + 워크스페이스 물질화 + 오프닝 메시지), 상태, 행동 이벤트, 종료, 재응시."""

import hashlib
import uuid
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from ..config import settings
from ..db import get_db
from ..definitions import (
    FrozenScenario,
    agent_turn_limit,
    granted_agent_turns,
    granted_messenger_turns,
    granted_minutes,
    grants_of,
    bind_definition,
    build_assessment_definition,
    definition_for_attempt,
    scenario_from_definition,
)
from ..deps import get_current_user, is_staff
from ..desktop import allowed_desktop_apps
from ..avatar_alloc import allocate
from ..demo import NO_EXAM_MESSAGE, is_demo_admin
from ..grading import schedule, should_retry
from ..guest_result import view as result_view
from ..guests import GUEST_ROLE
from ..models import (
    Assessment,
    AssessmentScenario,
    Assignment,
    Attempt,
    Event,
    MessengerMessage,
    OfficePreset,
    Scenario,
    User,
    WorkspaceFile,
    utcnow,
)
from ..lifecycle import finalize_attempt
from ..office import parse_ref, resolve_ref
from ..routers.office import builtin_overrides, get_office_settings, scene_of
from ..schemas import (
    AttemptGrantsOut,
    AttemptOut,
    AttemptScenarioOut,
    EventBatchIn,
    MyAssignmentOut,
    OfficeColleague,
)

router = APIRouter(tags=["attempts"])

# 마감 뒤 **행동 이벤트 플러시만** 받아 주는 유예 (ODY-007). 파일·실행·대화 등 변경은 마감 즉시 거부된다.
EVENT_FLUSH_GRACE = timedelta(seconds=45)

# 응시 클라이언트가 기록할 수 있는 행동 이벤트 화이트리스트
ALLOWED_EVENT_TYPES = {
    # focus_lost/focus_gained 는 어느 클라이언트도 보낸 적이 없다(window_blur/window_focus 가 그 일이다).
    # file_open 은 2026-09-20 부터 서버가 직접 기록한다(files.py) — 브라우저가 보고하게 두면 위조가 된다.
    "tab_hidden",
    "tab_visible",
    "window_blur",
    "window_focus",
    "paste",
    "copy",
    "cut",
    "app_open",
    "app_close",
    "page_enter",
    "page_exit",
    "net_offline",
    "net_online",
    "exam_leave",
    # 화면 캡처 키(PrintScreen)가 눌렸다 — 캡처 자체는 막을 수 없지만 사실은 남는다
    "screenshot_key",
    # 브리핑을 다시 열어 봤다
    "briefing_reopen",
}

# 브라우저 보고 이벤트의 payload 는 이 키만, 이 크기까지만 남긴다 (ODY-017).
# 클립보드 원문은 평가에 필요하지 않으므로 받더라도 저장하지 않는다 — chars/source 같은 메타만 쓴다.
# 참고자료 검색·열람은 서버가 직접 기록한다 (reference.py) — 브라우저가 보고한 값을 받으면 위조가 된다.
# 브라우저 보고 이벤트의 payload 는 이 키만, 이 크기까지만 남긴다 (ODY-017). 클립보드 원문(text)은 받지 않는다.
CLIENT_PAYLOAD_KEYS = {"away_ms", "chars", "app", "path", "page", "reason", "seq", "client_id", "source"}
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
    if not is_staff(user) and attempt.user_id != user.id:
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


async def _scenario_link(attempt: Attempt, scenario_id: uuid.UUID, db: AsyncSession) -> FrozenScenario:
    """응시 시작 때 고정한 정의에서 시나리오를 찾는다 — live assessment relation을 읽지 않는다."""
    definition = await definition_for_attempt(db, attempt)
    scenario = scenario_from_definition(definition, scenario_id)
    if not scenario:
        raise HTTPException(404, "이 시험에 포함되지 않은 시나리오입니다")
    return scenario


def _is_taker(attempt: Attempt, user: User | None) -> bool:
    """지금 이 응시를 '치르는 중'인 본인인가 — 잠금 규칙은 이 경우에만 적용한다."""
    return bool(user) and attempt.user_id == user.id and attempt.status == "in_progress"


async def scenario_in_attempt(
    attempt: Attempt,
    scenario_id: uuid.UUID,
    db: AsyncSession,
    user: User | None = None,
    *,
    mutate: bool = False,
) -> FrozenScenario:
    """응시 정의 안의 immutable 시나리오 접근 가드.

    다중 시나리오 시험은 **순차 진행**이다. 응시 중인 본인에게는
      · 아직 순서가 오지 않은 시나리오 → 잠김(423)
      · 이미 제출한 시나리오 → 읽기만 허용(쓰기는 423)
    """
    scenario = await _scenario_link(attempt, scenario_id, db)
    if _is_taker(attempt, user):
        if scenario.ordinal > attempt.current_ordinal:
            raise HTTPException(423, "아직 잠긴 문제입니다. 앞선 문제를 먼저 제출하세요")
        if mutate and scenario.ordinal < attempt.current_ordinal:
            raise HTTPException(423, "이미 제출한 문제입니다. 되돌아갈 수 없습니다")
    return scenario


def require_app(scenario: FrozenScenario, app: str, *more: str) -> None:
    """이 시나리오가 그 앱을 줬는가 — 주지 않았으면 그 앱의 API 도 닫는다.

    시나리오는 어떤 앱을 띄울지 스스로 정하고(desktop_apps), 그 선택이 곧 "이건 어떤 종류의
    문제인가" 다. 그런데 지금까지 그 선택은 **화면에서 아이콘을 감추는 것**뿐이었다. 터미널을
    빼 둔 사무 과제에서도 실행 API 는 그대로 열려 있었고, 메일을 주지 않은 시나리오에서도
    메일 발송 API 는 받아 주었다.

    채점의 전제가 "이 사람은 문서와 표만으로 일했다" 라면 그 전제는 집행돼야 한다. 집행되지
    않는 전제 위에서 매긴 점수는 그 자체로 틀린 점수다.

    응시 시작 때 **동결된** 정의를 본다 — 출제자가 나중에 앱을 빼도 진행 중인 응시의 조건은
    바뀌지 않는다.
    """
    allowed = set(allowed_desktop_apps(scenario.desktop_apps or []))
    wanted = (app, *more)
    if not allowed.intersection(wanted):
        raise HTTPException(423, "이 문제에서는 제공되지 않는 기능입니다")


def _scenario_status(attempt: Attempt, ordinal: int) -> str:
    if ordinal < attempt.current_ordinal:
        return "completed"
    if ordinal > attempt.current_ordinal:
        return "locked"
    return "in_progress" if attempt.status == "in_progress" else "completed"


async def _attempt_out(attempt: Attempt, db: AsyncSession) -> AttemptOut:
    from .settings import get_ui_settings

    definition = await definition_for_attempt(db, attempt)
    ui = await get_ui_settings(db)
    scenarios: list[AttemptScenarioOut] = []
    ordered = sorted(definition.get("scenarios") or [], key=lambda x: int(x.get("ordinal", 0) or 0))
    # 아바타 할당은 **시험 전체의 인물 합집합**으로 한 번 — 사무실(my_assignments)이 보는 것과
    # 같은 목록·같은 순서라, 사무실에서 본 얼굴이 메신저에서 그대로다.
    everyone: list[dict] = []
    for spec in ordered:
        sc = scenario_from_definition(definition, spec.get("scenario_id"))
        if sc:
            everyone.extend(
                {"key": c.get("key"), "gender": c.get("gender"), "avatar_preset": c.get("avatar_preset")}
                for c in (sc.characters or [])
            )
    alloc = allocate(everyone)
    for spec in ordered:
        scenario = scenario_from_definition(definition, spec.get("scenario_id"))
        if not scenario:
            continue
        scenarios.append(
            AttemptScenarioOut(
                scenario_id=scenario.id,
                title=scenario.title,
                briefing_md=scenario.briefing_md if scenario.ordinal <= attempt.current_ordinal else "",
                ordinal=scenario.ordinal,
                points=scenario.points,
                status=_scenario_status(attempt, scenario.ordinal),
                agent_enabled=scenario.agent_enabled,
                desktop_apps=list(scenario.desktop_apps or []),
                characters=[
                    {
                        "key": c.get("key"),
                        "name": c.get("name"),
                        "role": c.get("role", ""),
                        "color": c.get("color", "#6366f1"),
                        # 메신저가 이 인물의 도트·초상을 고르는 데 쓴다 — 비어 있으면 할당기가 채운 것
                        "avatar_preset": str(c.get("avatar_preset") or "") or alloc.get(str(c.get("key") or ""), ""),
                        "gender": str(c.get("gender") or ""),
                    }
                    for c in (scenario.characters or [])
                ],
            )
        )
    return AttemptOut(
        id=attempt.id,
        assessment_id=attempt.assessment_id,
        assessment_title=str(definition.get("title") or ""),
        status=attempt.status,
        started_at=attempt.started_at,
        deadline_at=attempt.deadline_at,
        submitted_at=attempt.submitted_at,
        # 보정분은 동결된 정의에 섞지 않고 여기서 더한다 — 에이전트 라우터와 같은 함수다.
        agent_max_turns=agent_turn_limit(definition, attempt),
        current_ordinal=attempt.current_ordinal,
        gamified_intro=bool(ui.get("gamified_intro")),
        # 사유·집행자는 내보내지 않는다 — 응시자에게 필요한 것은 "얼마나 받았는가" 뿐이다.
        grants=(
            AttemptGrantsOut(
                agent_turns=granted_agent_turns(attempt),
                messenger_turns=granted_messenger_turns(attempt),
                extra_minutes=granted_minutes(attempt),
                at=str(grants.get("at") or ""),
            )
            if (grants := grants_of(attempt))
            else None
        ),
        scenarios=scenarios,
    )


@router.get("/my/assignments", response_model=list[MyAssignmentOut])
async def my_assignments(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    # 둘러보기 계정은 관리 화면만 본다. 응시 목록을 주면 거기서 시험이 시작되고, 데모를 보러 온
    # 사람이 실제 응시 자원(모델 호출·러너)을 쓰게 된다 (demo.py).
    if is_demo_admin(user):
        raise HTTPException(403, NO_EXAM_MESSAGE)
    # 게스트는 배정을 받지 않는다 — 배정할 상대가 미리 존재하지 않기 때문이다.
    # 대신 열려 있는 시험을 전부 본다. 스태프와 같은 목록을 보지만 이유는 다르고
    # (권한이 아니라 배정의 부재), 권한은 아무것도 따라오지 않는다.
    assigned_ids: set[uuid.UUID] = {
        r
        for r in (
            await db.execute(select(Assignment.assessment_id).where(Assignment.user_id == user.id))
        ).scalars()
    }
    # 시험 하나를 골라 들어온 게스트는 배정을 받는다(auth.guest_login) — 그러면 그 하나만 본다.
    # 분야만 고르고 들어온 옛 흐름의 게스트는 분야 전체를 본다.
    sees_all = is_staff(user) or (user.role == GUEST_ROLE and not assigned_ids)
    if sees_all:
        q = (
            select(Assessment)
            # 난이도는 시나리오의 것이다 — 비동기 세션에서 뒤늦게 lazy load 하면 MissingGreenlet 로 죽는다
            .options(selectinload(Assessment.scenarios).selectinload(AssessmentScenario.scenario))
            .order_by(Assessment.created_at.desc())
        )
        # 게스트가 들어올 때 분야를 골랐으면 **그 분야만** 본다. 전부 보여 주는 것은
        # 너무 쉽고, 고른 뒤에 다른 분야가 섞여 나오면 고른 의미가 없다.
        if user.role == GUEST_ROLE and (user.guest_category or ""):
            q = q.where(Assessment.category == user.guest_category)
        assessments = (await db.execute(q)).scalars().all()
    else:
        assessments = [
            asg.assessment
            for asg in (
                await db.execute(
                    select(Assignment)
                    .where(Assignment.user_id == user.id)
                    .options(
                        selectinload(Assignment.assessment)
                        .selectinload(Assessment.scenarios)
                        .selectinload(AssessmentScenario.scenario)
                    )
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

    # Explicit identities and public DTOs only. Private exam cards stay server-side.
    from ..npc.public import compile_public, public_rows
    colleagues_of: dict[uuid.UUID, dict[str, OfficeColleague]] = {}
    grouped = await public_rows(db, [a.id for a in assessments]) if assessments else {}
    for assessment_id, rows in grouped.items():
        _, roster = compile_public(rows)
        colleagues_of[assessment_id] = {c["key"]: OfficeColleague(**c) for c in roster}

    # 방의 장면 — 시험에 정한 것, 없으면 분야 기본, 없으면 자동. 프리셋이면 장면 JSON 을 싣는다
    # (응시자는 관리자 API 에 닿지 않는다). 없어진 프리셋을 가리키면 자동으로 돌아간다.
    defaults = (await get_office_settings(db)).get("defaults", {})
    ref_of = {a.id: resolve_ref(a.office_preset, a.category, defaults) for a in assessments}
    wanted = {uuid.UUID(v) for v in ref_of.values() if parse_ref(v)[0] == "custom"}
    presets = {}
    if wanted:
        presets = {
            row.id: row
            for row in (await db.execute(select(OfficePreset).where(OfficePreset.id.in_(wanted)))).scalars()
        }

    overrides = await builtin_overrides(db)

    def office_of(a: Assessment) -> tuple[str, dict | None]:
        ref = ref_of.get(a.id, "")
        kind, value = parse_ref(ref)
        if kind == "custom":
            row = presets.get(uuid.UUID(value))
            return (ref, scene_of(row)) if row else ("", None)
        if kind == "builtin":
            # 관리자가 고친 템플릿이면 고친 모양을 싣는다. 고치지 않았으면 None — 웹이 코드의 기본값을 쓴다.
            return ref, overrides.get(value)
        return ref, None

    out = []
    for a in assessments:
        ref, scene = office_of(a)
        out.append(
            MyAssignmentOut(
                assessment_id=a.id,
                title=a.title,
                description=a.description,
                category=a.category,
                label=a.label,
                difficulty=(a.scenarios[0].scenario.difficulty if a.scenarios and a.scenarios[0].scenario else ""),
                duration_min=a.duration_min,
                scenario_count=len(a.scenarios),
                starts_at=a.starts_at,
                ends_at=a.ends_at,
                attempt_id=(attempt_by_assessment.get(a.id).id if attempt_by_assessment.get(a.id) else None),
                attempt_status=(attempt_by_assessment.get(a.id).status if attempt_by_assessment.get(a.id) else None),
                assigned=a.id in assigned_ids,
                colleagues=list(colleagues_of.get(a.id, {}).values()),
                office_preset=ref,
                office_scene=scene,
            )
        )
    return out


@router.get("/my/office/builtins")
async def my_office_builtins(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)) -> dict[str, dict]:
    """관리자가 고친 템플릿 — 템플릿 id → 장면 JSON. 고치지 않은 템플릿은 없다(웹이 코드의 기본값을 쓴다).

    장면을 정하지 않은 방은 웹이 템플릿 중에서 고르므로(층 안에서 겹치지 않게), 고친 모양을 여기서 받아야 그 방도
    고친 모양으로 선다. 방의 모양뿐이라 응시자·게스트에게 보여도 된다.
    """
    return await builtin_overrides(db)


async def _materialize(attempt: Attempt, db: AsyncSession) -> None:
    """시작 시점에 고정된 정의에서 초기 파일 + 오프닝 메시지를 정확히 한 번 생성한다."""
    definition = await definition_for_attempt(db, attempt, persist_legacy=False)
    for spec in definition.get("scenarios") or []:
        scenario = scenario_from_definition(definition, spec.get("scenario_id"))
        if not scenario:
            continue
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
    if not assignment and not is_staff(user):
        # 게스트는 배정 없이 들어올 수 있었다(분야만 고른 옛 흐름). 시험 하나를 골라 배정을 받은 게스트는
        # 그 하나만 — 사무실에 방 하나만 선 사람이 주소로 다른 시험을 시작하는 길을 막는다.
        if user.role != GUEST_ROLE:
            raise HTTPException(403, "이 시험에 배정되지 않았습니다")
        has_any = (
            await db.execute(select(Assignment.id).where(Assignment.user_id == user.id).limit(1))
        ).scalar_one_or_none()
        if has_any is not None:
            raise HTTPException(403, "고른 시험만 응시할 수 있습니다")

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

    # 여기서 정의 전체를 고정한다. 이후 authoring row가 바뀌어도 이 응시는 이 JSON만 읽는다.
    definition = await build_assessment_definition(db, assessment)
    duration_min = int(definition.get("duration_min", assessment.duration_min) or assessment.duration_min)
    deadline = now + timedelta(minutes=duration_min)
    if assessment.ends_at and deadline > assessment.ends_at:
        deadline = assessment.ends_at
    attempt = Attempt(assessment_id=assessment_id, user_id=user.id, started_at=now, deadline_at=deadline)
    bind_definition(attempt, definition)
    from ..npc.store import snapshot_relations
    await snapshot_relations(db, attempt, definition)
    db.add(attempt)
    try:
        await db.flush()
        await _materialize(attempt, db)
        db.add(
            Event(
                attempt_id=attempt.id,
                type="attempt_started",
                payload={
                    "assessment_id": str(assessment_id),
                    "deadline_at": deadline.isoformat(),
                    "definition_hash": definition.get("definition_hash"),
                },
            )
        )
        await db.commit()
    except IntegrityError:
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
    """브라우저가 보고하는 행동 이벤트 — 신뢰할 수 없는 보조 신호로만 저장한다 (ODY-017)."""
    attempt = await get_attempt_for(attempt_id, user, db)
    if attempt.user_id != user.id:
        raise HTTPException(403, "본인의 응시에만 기록할 수 있습니다")
    if attempt.status != "in_progress":
        # 종료 직후 도착하는 마지막 플러시(화면 이탈·탭 전환 등)만 짧게 받아 준다 — 변경은 아니다
        ended = attempt.submitted_at or attempt.deadline_at
        if not ended or utcnow() > ended + EVENT_FLUSH_GRACE:
            return {"ok": True, "recorded": 0}
    definition = await definition_for_attempt(db, attempt)
    valid_scenarios = {
        uuid.UUID(str(s.get("scenario_id")))
        for s in definition.get("scenarios") or []
        if s.get("scenario_id")
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
                dropped += 1
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


@router.get("/attempts/{attempt_id}/result")
async def attempt_result(
    attempt_id: uuid.UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    """끝난 시험의 결과 — 응시자 본인이 본다 (guest_result.view).

    자동 체크의 항목 이름(=정답지)은 돌려주지 않는다. 같은 시험이 실제 채용에 쓰이는데 게스트로
    한 번 들어와 정답 목록을 받아 갈 수 있으면 안 된다.
    """
    attempt = await db.get(Attempt, attempt_id)
    if attempt is None or attempt.user_id != user.id:
        raise HTTPException(404, "응시를 찾을 수 없습니다")
    await check_expired(attempt, db)
    if attempt.status == "in_progress":
        raise HTTPException(400, "아직 진행 중인 시험입니다")
    if await should_retry(db, attempt):
        # 종료 직후 걸어 둔 채점이 프로세스와 함께 사라졌을 때의 두 번째 기회다.
        schedule(attempt.id)
    assessment = await db.get(Assessment, attempt.assessment_id)
    return {
        "attempt_id": str(attempt.id),
        "assessment_title": assessment.title if assessment else "",
        "status": attempt.status,
        "submitted_at": attempt.submitted_at,
        "started_at": attempt.started_at,
        **await result_view(db, attempt),
    }


@router.post("/attempts/{attempt_id}/scenarios/{scenario_id}/complete", response_model=AttemptOut)
async def complete_scenario(
    attempt_id: uuid.UUID,
    scenario_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    attempt = await require_own_active(attempt_id, user, db)
    scenario = await _scenario_link(attempt, scenario_id, db)
    if scenario.ordinal != attempt.current_ordinal:
        raise HTTPException(409, "현재 진행 중인 문제가 아닙니다")
    definition = await definition_for_attempt(db, attempt)
    total = len(definition.get("scenarios") or [])

    db.add(
        Event(
            attempt_id=attempt.id,
            scenario_id=scenario_id,
            type="scenario_completed",
            payload={"ordinal": scenario.ordinal, "total": total},
        )
    )
    if scenario.ordinal + 1 >= total:
        await db.commit()
        attempt = await finalize_attempt(db, attempt.id, "submitted") or attempt
    else:
        attempt.current_ordinal = scenario.ordinal + 1
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
    """재응시 — 이전 기록을 보존하고 현재 authoring definition으로 새 시도를 시작한다."""
    attempt = await db.get(Attempt, attempt_id)
    if not attempt:
        raise HTTPException(404, "응시 정보를 찾을 수 없습니다")
    if not is_staff(user):
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
    if not assessment:
        raise HTTPException(404, "시험을 찾을 수 없습니다")
    definition = await build_assessment_definition(db, assessment)
    now = utcnow()
    deadline = now + timedelta(minutes=int(definition.get("duration_min", assessment.duration_min)))
    if assessment.ends_at and deadline > assessment.ends_at:
        deadline = assessment.ends_at
    new_attempt = Attempt(
        assessment_id=attempt.assessment_id, user_id=attempt.user_id, started_at=now, deadline_at=deadline
    )
    bind_definition(new_attempt, definition)
    from ..npc.store import snapshot_relations
    await snapshot_relations(db, new_attempt, definition)
    db.add(new_attempt)
    await db.flush()
    await _materialize(new_attempt, db)
    db.add(
        Event(
            attempt_id=new_attempt.id,
            type="attempt_started",
            payload={"retake_of": str(attempt.id), "definition_hash": definition.get("definition_hash")},
        )
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

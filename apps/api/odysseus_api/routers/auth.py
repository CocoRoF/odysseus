from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import cookie_secure_enabled
from ..db import get_db
from ..deps import get_current_user
import secrets
import uuid
from datetime import timedelta

from ..config import settings
from ..categories import ASSESSMENT_CATEGORIES, UNCATEGORIZED_LABEL
from ..account_sweep import spent_visitor
from ..demo import DEMO_ADMIN_ROLE, DEMO_EMAIL_DOMAIN
from ..guests import (
    arrival_rate,
    count_arrivals,
    over_capacity,
    record_arrival,
    GUEST_EMAIL_DOMAIN,
    GUEST_ROLE,
    assert_ip_allowed,
    load_policy,
)
from ..models import Assessment, AssessmentScenario, Assignment, Attempt, Scenario, Session, User, utcnow
from ..sessions import session_is_live
from ..ratelimit import client_ip, enforce, login_failed, login_locked, login_succeeded, too_many
from ..schemas import GuestAvailabilityOut, GuestCategoryOut, GuestExamOut, GuestStartIn, LoginIn, ResumeOut, UserOut
from ..security import COOKIE_NAME, create_token, decode_token, hash_password, verify_password

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/login", response_model=UserOut)
async def login(body: LoginIn, request: Request, response: Response, db: AsyncSession = Depends(get_db)):
    # ODY-010: IP 별 속도 + 이메일별 실패 누적 잠금(지수 backoff). 잠금 응답은 비밀번호를 확인하기 전에 낸다
    ip = client_ip(request)
    email = body.email.lower()
    enforce(f"login:ip:{ip}", per_min=20, burst=10, what="로그인 시도")
    locked = login_locked(email)
    if locked:
        raise too_many(locked, "로그인 시도")
    user = (await db.execute(select(User).where(User.email == email))).scalar_one_or_none()
    if not user or not user.is_active or not verify_password(body.password, user.password_hash):
        lock = login_failed(email, ip)
        if lock:
            raise too_many(lock, "로그인 시도")
        raise HTTPException(401, "이메일 또는 비밀번호가 올바르지 않습니다")
    login_succeeded(email)
    # 차단 판정은 비밀번호를 맞힌 뒤에 한다. 먼저 하면 응답이 갈리는 지점이
    # 하나 늘어 "이 주소는 차단, 저 주소는 401" 로 계정 존재 여부가 새어 나간다.
    await assert_ip_allowed(db, ip, role=user.role)
    await _issue_session(db, response, request, user, ip)
    return user


async def _issue_session(
    db: AsyncSession, response: Response, request: Request, user: User, ip: str
) -> Session:
    """서버 세션 행을 만들고 그 id 를 토큰 jti 로 실어 쿠키에 담는다 (ODY-023).

    로그인과 게스트 시작이 같은 세션 수명·같은 폐기 경로를 쓰게 하려고 한곳에 둔다 —
    게스트만 다른 규칙으로 도는 순간, 관리자의 '세션 폐기'가 게스트에게만 듣지 않는
    식의 구멍이 생긴다.
    """
    session = Session(
        user_id=user.id,
        expires_at=utcnow() + timedelta(hours=settings.jwt_expire_hours),
        ip=ip[:64],
        user_agent=(request.headers.get("user-agent") or "")[:200],
    )
    db.add(session)
    await db.commit()
    token = create_token(user.id, user.role, session.id)
    response.set_cookie(
        COOKIE_NAME,
        token,
        httponly=True,
        secure=cookie_secure_enabled(),  # 운영에서는 HTTPS 로만 실린다 (ODY-014)
        samesite="lax",
        max_age=60 * 60 * 12,
        path="/",
    )
    return session


@router.get("/guest", response_model=GuestAvailabilityOut)
async def guest_available(db: AsyncSession = Depends(get_db)):
    """로그인 화면이 게스트 버튼을 띄울지, 그리고 게스트가 고를 수 있는 분야가 무엇인지.

    분야는 **시험이 하나 이상 있는 것만** 준다 — 골랐는데 빈 사무실이면 없느니만 못하다.
    제목이나 내용은 주지 않는다. 로그인 전 화면에 새어 나가는 것은 분야 이름과 개수뿐이다.
    """
    policy = await load_policy(db)
    if not policy.enabled:
        return GuestAvailabilityOut(enabled=False, categories=[], admin_demo=policy.admin_demo_enabled)
    # 시험은 시나리오 하나라(2026-09-20) 난이도는 그 시나리오의 것이다. 분야 안에 여럿이 서면
    # 꼬리표·난이도·시간으로 갈라 보여 준다 — 제목과 내용은 로그인 뒤에 본다.
    rows = (
        await db.execute(
            select(
                Assessment.category, Assessment.label, Assessment.duration_min, Scenario.difficulty,
                Assessment.id, Assessment.title, Assessment.description,
            )
            .outerjoin(AssessmentScenario, AssessmentScenario.assessment_id == Assessment.id)
            .outerjoin(Scenario, Scenario.id == AssessmentScenario.scenario_id)
        )
    ).all()
    by_cat: dict[str, list[GuestExamOut]] = {}
    for category, label, minutes, difficulty, aid, title, pitch in rows:
        by_cat.setdefault(str(category or ""), []).append(
            GuestExamOut(
                assessment_id=aid, label=label or "", title=title, pitch=pitch or "",
                difficulty=difficulty or "medium", duration_min=int(minutes or 0),
            )
        )
    order = {"easy": 0, "medium": 1, "hard": 2}
    for exams in by_cat.values():
        exams.sort(key=lambda e: (order.get(e.difficulty, 1), e.label))
    cats = [
        GuestCategoryOut(key=key, label=label, count=len(by_cat[key]), exams=by_cat[key])
        for key, label in ASSESSMENT_CATEGORIES
        if by_cat.get(key)
    ]
    if by_cat.get(""):
        cats.append(GuestCategoryOut(key="", label=UNCATEGORIZED_LABEL, count=len(by_cat[""]), exams=by_cat[""]))
    return GuestAvailabilityOut(enabled=True, categories=cats, admin_demo=policy.admin_demo_enabled)


async def _session_user(request: Request, db: AsyncSession) -> tuple[User, Session] | None:
    """쿠키가 가리키는 **살아 있는** 세션과 주인. 없으면 None — 여기서는 401 을 내지 않는다.

    로그인하지 않은 사람에게도 열려 있어야 하는 자리(로그인 화면, 게스트 시작)에서 "지금 누구인가" 를
    묻는 용도다. 살아 있는지는 인증과 같은 판정을 쓴다 (sessions.session_is_live).
    """
    token = request.cookies.get(COOKIE_NAME)
    if not token:
        auth = request.headers.get("Authorization", "")
        token = auth[7:] if auth.startswith("Bearer ") else None
    payload = decode_token(token) if token else None
    if not payload or not payload.get("jti"):
        return None
    try:
        session = await db.get(Session, uuid.UUID(payload["jti"]))
        user = await db.get(User, uuid.UUID(payload["sub"]))
    except (ValueError, KeyError):
        return None
    if user is None or session is None or str(session.user_id) != str(user.id) or not user.is_active:
        return None
    if not session_is_live(session, utcnow(), user.role):
        return None
    return user, session


async def _running_attempt(db: AsyncSession, user: User) -> Attempt | None:
    """이 사람이 지금 치르고 있는 시험. 마감이 지난 것은 세지 않는다."""
    attempt = (
        await db.execute(
            select(Attempt)
            .where(
                Attempt.user_id == user.id,
                Attempt.status == "in_progress",
                Attempt.superseded.is_(False),
                Attempt.deadline_at > utcnow(),
            )
            .order_by(Attempt.started_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    return attempt


async def _guard_running_exam(request: Request, db: AsyncSession, replace: bool) -> None:
    """치르는 중인 시험이 있는데 새 계정을 만들려 하면 막는다.

    게스트는 나가면 그 계정으로 다시 못 들어온다. 그래서 새 계정을 내주는 순간 앞선 응시는 아무 말 없이
    영영 닫힌다 — 실제로 뒤로가기 한 번, 북마크 한 번으로 재현됐다(2026-09-19). 버릴 생각이라고
    화면에서 확인받은 뒤에만(``replace``) 지나간다.
    """
    current = await _session_user(request, db)
    if current is None or current[0].role != GUEST_ROLE:
        return
    if replace:
        await _retire_guest(db, current[0])
        return
    attempt = await _running_attempt(db, current[0])
    if attempt is not None:
        raise HTTPException(
            409, "진행 중인 시험이 있습니다. 이어서 하거나, 새로 시작하려면 지금 시험을 버린다고 확인해 주세요"
        )


async def _retire_guest(db: AsyncSession, old: User) -> None:
    """새 게스트에게 자리를 내주는 옛 게스트를 그 자리에서 정리한다.

    "버리고 새로 시작" 을 확인받고도 옛 계정을 그대로 두면 세 가지가 남는다 — 살아 있는 세션(4시간),
    진행 중인 응시(마감까지), 그리고 마감이 지나면 버려진 시험을 채점하는 모델 호출. 나가면 끝인
    계정이니 나간 것으로 처리한다: 세션을 끊고, 남길 기록이 없으면 계정째 지우고(응시도 함께),
    기록이 있으면 응시만 닫는다(닫히면 채점된다 — 한 일이 있으니 값어치가 있다).
    """
    from ..lifecycle import finalize_attempt

    await revoke_user_sessions(db, old.id, "replaced")
    await db.flush()
    if await spent_visitor(db, old):
        await db.delete(old)
        await db.commit()
        return
    running = await _running_attempt(db, old)
    if running is not None:
        await finalize_attempt(db, running.id, "submitted", actor="replaced")
    await db.commit()


@router.get("/resume", response_model=ResumeOut)
async def resume(request: Request, db: AsyncSession = Depends(get_db)):
    """지금 이 브라우저가 이어 할 것이 있는가 — 로그인 화면이 묻는다.

    로그인하지 않았으면 빈 값을 돌려준다. 401 이 아니라 200 인 이유는, 이것이 '인증 실패' 가 아니라
    '이어 할 것이 없다' 라는 정상적인 답이기 때문이다.
    """
    current = await _session_user(request, db)
    if current is None:
        return ResumeOut()
    user, _ = current
    attempt = await _running_attempt(db, user)
    title = ""
    if attempt is not None:
        assessment = await db.get(Assessment, attempt.assessment_id)
        title = assessment.title if assessment else ""
    return ResumeOut(
        name=user.name,
        role=user.role,
        home=("/office" if user.role == GUEST_ROLE else "/dashboard"),
        attempt_id=str(attempt.id) if attempt else None,
        assessment_title=title,
        deadline_at=attempt.deadline_at if attempt else None,
    )


@router.post("/guest", response_model=UserOut)
async def guest_login(
    body: GuestStartIn, request: Request, response: Response, db: AsyncSession = Depends(get_db)
):
    """게스트 계정을 만들고 바로 로그인시킨다.

    만들어지는 것은 진짜 ``users`` 행이다. 그래야 관리자가 목록에서 보고,
    정지시키고, 세션을 끊고, 응시 기록을 되짚을 수 있다 — 익명 토큰으로 처리하면
    남용이 시작됐을 때 손댈 대상 자체가 없다.
    """
    ip = client_ip(request)
    policy = await load_policy(db)
    if not policy.enabled:
        raise HTTPException(403, "게스트 접속이 비활성화되어 있습니다")
    if policy.max_new_per_hour_per_ip <= 0:
        # '받지 않는다' 는 정책이지 혼잡이 아니다. 아래 속도 제한보다 먼저 답해야
        # 최근 트래픽에 따라 403 과 429 사이에서 답이 흔들리지 않는다.
        raise HTTPException(403, "게스트 접속이 비활성화되어 있습니다")
    await assert_ip_allowed(db, ip)
    # 진행 중인 시험을 실수로 버리지 않게 한다. 게스트는 나가면 그 계정으로 못 돌아오므로,
    # 여기서 새 계정을 내주는 순간 앞선 응시는 영영 열 수 없다. 버릴 생각이면 replace 로 말한다.
    await _guard_running_exam(request, db, body.replace)
    # 짧은 순간의 연타(버튼 중복 클릭·스크립트)를 자른다. 속도는 정책에서 끌어온다 —
    # 한 회선에 여럿이 앉아 동시에 들어오는 자리(교실·사무실)를 코드에 박힌 숫자가 막고 있었다.
    per_min, burst = arrival_rate(policy)
    enforce(f"guest:new:{ip}", per_min=per_min, burst=burst, what="게스트 접속")
    # 그리고 시간당 총량. 속도 제한만으로는 천천히 계속 만드는 것을 막지 못한다.
    # 계정이 아니라 입장 원장에서 센다 — 계정은 나가면 지워지므로(account_sweep) 세는 자리가 못 된다.
    if await count_arrivals(db, ip, GUEST_ROLE) >= policy.max_new_per_hour_per_ip:
        raise over_capacity(policy.max_new_per_hour_per_ip, "게스트")

    tag = secrets.token_hex(4)
    name = (body.name or "").strip()[:40] or f"게스트-{tag[:4].upper()}"
    user = User(
        email=f"guest-{tag}-{secrets.token_hex(4)}@{GUEST_EMAIL_DOMAIN}",
        name=name,
        # 게스트는 다시 로그인해 들어오는 계정이 아니다 — 세션 쿠키가 전부다.
        # 맞출 수 없는 해시를 넣어 비밀번호 경로를 아예 닫는다.
        password_hash=hash_password(secrets.token_urlsafe(32)),
        role=GUEST_ROLE,
        created_ip=ip[:64],
        avatar_preset=body.avatar_preset,
        guest_category=body.category,
    )
    db.add(user)
    record_arrival(db, ip, GUEST_ROLE)
    # 시험 하나를 골라 들어왔다 — 그 시험만 배정한다. 사무실에는 그 방 하나만 서고, 대시보드에도 그것만 있다.
    if body.assessment_id is not None:
        chosen = await db.get(Assessment, body.assessment_id)
        if chosen is None:
            raise HTTPException(400, "없는 시험입니다")
        user.guest_category = chosen.category or ""
        await db.flush()
        db.add(Assignment(assessment_id=chosen.id, user_id=user.id))
    await db.commit()
    await db.refresh(user)
    await _issue_session(db, response, request, user, ip)
    return user


@router.post("/guest/admin", response_model=UserOut)
async def demo_admin_login(request: Request, response: Response, db: AsyncSession = Depends(get_db)):
    """관리 화면을 **읽기만** 하는 둘러보기 계정을 만들고 바로 로그인시킨다 (demo.py).

    게스트 응시와 같은 문을 쓰지 않는 이유: 관리 화면을 열어 주는 것은 시험 하나를 열어 주는
    것과 무게가 다르다. 그래서 스위치도 따로다(``admin_demo_enabled``). 주소 차단·속도 제한·
    시간당 총량은 게스트와 같은 것을 쓴다 — 계정을 만드는 문은 다 같은 값어치의 자원이다.
    """
    ip = client_ip(request)
    policy = await load_policy(db)
    if not policy.admin_demo_enabled:
        raise HTTPException(403, "관리 화면 둘러보기가 비활성화되어 있습니다")
    await assert_ip_allowed(db, ip)
    per_min, burst = arrival_rate(policy)
    enforce(f"demo:new:{ip}", per_min=per_min, burst=burst, what="둘러보기 접속")
    cap = policy.max_new_per_hour_per_ip
    if cap > 0 and await count_arrivals(db, ip, DEMO_ADMIN_ROLE) >= cap:
        raise over_capacity(cap, "둘러보기 손님")

    tag = secrets.token_hex(4)
    user = User(
        email=f"demo-{tag}-{secrets.token_hex(4)}@{DEMO_EMAIL_DOMAIN}",
        name=f"둘러보기-{tag[:4].upper()}",
        # 게스트와 같은 이유로 비밀번호 경로를 닫는다 — 세션 쿠키가 전부다.
        password_hash=hash_password(secrets.token_urlsafe(32)),
        role=DEMO_ADMIN_ROLE,
        created_ip=ip[:64],
    )
    db.add(user)
    record_arrival(db, ip, DEMO_ADMIN_ROLE)
    await db.commit()
    await db.refresh(user)
    await _issue_session(db, response, request, user, ip)
    return user


@router.post("/logout")
async def logout(request: Request, response: Response, db: AsyncSession = Depends(get_db)):
    """쿠키 삭제 + 서버 세션 폐기 + 브라우저 잔존 데이터 정리 (ODY-023)."""
    token = request.cookies.get(COOKIE_NAME)
    if not token:
        auth = request.headers.get("Authorization", "")
        token = auth[7:] if auth.startswith("Bearer ") else None
    payload = decode_token(token) if token else None
    if payload and payload.get("jti"):
        session = await db.get(Session, uuid.UUID(payload["jti"]))
        if session and session.revoked_at is None:
            session.revoked_at = utcnow()
            session.revoked_reason = "logout"
            await db.commit()
        # 손님 계정(게스트·둘러보기)은 나가면 끝이다 — 같은 계정으로 다시 들어올 수 없다. 남길 응시
        # 기록이 없으면 그 자리에서 지운다(account_sweep 가 조건을 갖는다). 세션은 CASCADE 로 함께 사라진다.
        if session:
            user = await db.get(User, session.user_id)
            if user is not None and await spent_visitor(db, user):
                await db.delete(user)
                await db.commit()
    response.delete_cookie(COOKIE_NAME, path="/")
    # 공유 PC: 캐시·쿠키·스토리지(터미널 히스토리, 텔레메트리 seq 등)를 브라우저가 지우게 한다
    response.headers["Clear-Site-Data"] = '"cache", "cookies", "storage"'
    return {"ok": True}


async def revoke_user_sessions(db: AsyncSession, user_id: uuid.UUID, reason: str) -> int:
    """사용자의 살아 있는 세션을 모두 폐기한다 — 비밀번호 변경·비활성화·삭제 때."""
    rows = (
        await db.execute(select(Session).where(Session.user_id == user_id, Session.revoked_at.is_(None)))
    ).scalars().all()
    now = utcnow()
    for s in rows:
        s.revoked_at = now
        s.revoked_reason = reason
    return len(rows)


@router.get("/me", response_model=UserOut)
async def me(user: User = Depends(get_current_user)):
    return user

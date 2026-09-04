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
from ..guests import (
    GUEST_EMAIL_DOMAIN,
    GUEST_ROLE,
    assert_ip_allowed,
    load_policy,
)
from ..models import Session, User, utcnow
from ..ratelimit import client_ip, enforce, login_failed, login_locked, login_succeeded, too_many
from ..schemas import GuestStartIn, LoginIn, UserOut
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


@router.get("/guest")
async def guest_available(db: AsyncSession = Depends(get_db)):
    """로그인 화면이 게스트 버튼을 띄울지 판단하는 공개 엔드포인트."""
    return {"enabled": (await load_policy(db)).enabled}


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
    # 짧은 순간의 연타(버튼 중복 클릭·스크립트)를 자른다
    enforce(f"guest:new:{ip}", per_min=6, burst=3, what="게스트 접속")
    # 그리고 시간당 총량. 속도 제한만으로는 천천히 계속 만드는 것을 막지 못한다.
    recent = int(
        (
            await db.execute(
                select(func.count())
                .select_from(User)
                .where(
                    User.role == GUEST_ROLE,
                    User.created_ip == ip,
                    User.created_at > utcnow() - timedelta(hours=1),
                )
            )
        ).scalar_one()
        or 0
    )
    if recent >= policy.max_new_per_hour_per_ip:
        raise HTTPException(429, "이 주소에서 만들 수 있는 게스트 수를 초과했습니다. 잠시 후 다시 시도하세요")

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
    )
    db.add(user)
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

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import cookie_secure_enabled
from ..db import get_db
from ..deps import get_current_user
import uuid
from datetime import timedelta

from ..config import settings
from ..models import Session, User, utcnow
from ..ratelimit import client_ip, enforce, login_failed, login_locked, login_succeeded, too_many
from ..schemas import LoginIn, UserOut
from ..security import COOKIE_NAME, create_token, decode_token, verify_password

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
    # ODY-023: 서버 세션 행을 만들고 그 id 를 토큰 jti 로
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

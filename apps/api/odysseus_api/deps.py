import uuid

from fastapi import Depends, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession

from .db import get_db
from datetime import timedelta

from .config import settings
from .models import Session, User, utcnow
from .security import COOKIE_NAME, decode_token


async def get_current_user(request: Request, db: AsyncSession = Depends(get_db)) -> User:
    token = request.cookies.get(COOKIE_NAME)
    if not token:
        auth = request.headers.get("Authorization", "")
        if auth.startswith("Bearer "):
            token = auth[7:]
    if not token:
        raise HTTPException(401, "로그인이 필요합니다")
    payload = decode_token(token)
    if not payload:
        raise HTTPException(401, "세션이 만료되었습니다")
    # ODY-023: 토큰의 jti 가 가리키는 세션이 살아 있어야 한다 — 로그아웃·비밀번호 변경·비활성화로 폐기된다
    jti = payload.get("jti")
    if not jti:
        raise HTTPException(401, "세션이 만료되었습니다. 다시 로그인하세요")
    session = await db.get(Session, uuid.UUID(jti))
    now = utcnow()
    if (
        session is None
        or session.revoked_at is not None
        or session.expires_at < now
        or session.last_seen_at < now - timedelta(hours=settings.session_idle_hours)
    ):
        raise HTTPException(401, "세션이 만료되었습니다. 다시 로그인하세요")
    if str(session.user_id) != payload["sub"]:
        raise HTTPException(401, "세션이 만료되었습니다. 다시 로그인하세요")
    user = await db.get(User, uuid.UUID(payload["sub"]))
    if not user or not user.is_active:
        raise HTTPException(401, "유효하지 않은 사용자입니다")
    # 마지막 활동 시각은 1분에 한 번만 갱신 (매 요청 쓰기 방지)
    if (now - session.last_seen_at).total_seconds() > 60:
        session.last_seen_at = now
        await db.commit()
    return user


def require_roles(*roles: str):
    async def checker(user: User = Depends(get_current_user)) -> User:
        if user.role not in roles:
            raise HTTPException(403, "권한이 없습니다")
        return user

    return checker


require_admin = require_roles("admin")
require_staff = require_roles("admin", "evaluator")

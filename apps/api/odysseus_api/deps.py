import uuid

from fastapi import Depends, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession

from .db import get_db
from .models import User
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
    user = await db.get(User, uuid.UUID(payload["sub"]))
    if not user or not user.is_active:
        raise HTTPException(401, "유효하지 않은 사용자입니다")
    return user


def require_roles(*roles: str):
    async def checker(user: User = Depends(get_current_user)) -> User:
        if user.role not in roles:
            raise HTTPException(403, "권한이 없습니다")
        return user

    return checker


require_admin = require_roles("admin")
require_staff = require_roles("admin", "evaluator")

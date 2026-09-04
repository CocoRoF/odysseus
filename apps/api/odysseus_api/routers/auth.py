from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_db
from ..deps import get_current_user
from ..models import User
from ..ratelimit import client_ip, enforce, login_failed, login_locked, login_succeeded, too_many
from ..schemas import LoginIn, UserOut
from ..security import COOKIE_NAME, create_token, verify_password

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
    token = create_token(user.id, user.role)
    response.set_cookie(
        COOKIE_NAME,
        token,
        httponly=True,
        samesite="lax",
        max_age=60 * 60 * 12,
        path="/",
    )
    return user


@router.post("/logout")
async def logout(response: Response):
    response.delete_cookie(COOKIE_NAME, path="/")
    return {"ok": True}


@router.get("/me", response_model=UserOut)
async def me(user: User = Depends(get_current_user)):
    return user

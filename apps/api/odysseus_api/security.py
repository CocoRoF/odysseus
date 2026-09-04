import uuid
from datetime import datetime, timedelta, timezone

import bcrypt
import jwt

from .config import settings

COOKIE_NAME = "odysseus_token"


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode(), password_hash.encode())
    except ValueError:
        return False


def create_token(user_id: uuid.UUID, role: str, session_id: uuid.UUID | None = None) -> str:
    """세션 id(jti)를 품은 토큰 — 서버가 세션 행으로 폐기할 수 있다 (ODY-023)."""
    payload = {
        "sub": str(user_id),
        "role": role,
        "jti": str(session_id) if session_id else None,
        "exp": datetime.now(timezone.utc) + timedelta(hours=settings.jwt_expire_hours),
    }
    return jwt.encode(payload, settings.jwt_secret, algorithm="HS256")


def decode_token(token: str) -> dict | None:
    try:
        return jwt.decode(token, settings.jwt_secret, algorithms=["HS256"])
    except jwt.PyJWTError:
        return None

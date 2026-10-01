import uuid

from fastapi import Depends, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession

from .db import get_db
from .demo import DEMO_ADMIN_ROLE, DEMO_EXPIRED_MESSAGE, READONLY_MESSAGE, is_demo_admin, readonly_violation
from .guests import assert_ip_allowed
from .models import Session, User, utcnow
from .ratelimit import client_ip
from .security import COOKIE_NAME, decode_token
from .sessions import session_is_live


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
    # 유휴 한도는 역할마다 다르므로(sessions.idle_limit) 사용자를 먼저 찾는다. 역할과 무관한
    # 조건 — 폐기됐는가, 기한이 지났는가, 주인이 맞는가 — 은 여기서 먼저 거른다.
    if session is None or session.revoked_at is not None or session.expires_at < now:
        raise HTTPException(401, "세션이 만료되었습니다. 다시 로그인하세요")
    if str(session.user_id) != payload["sub"]:
        raise HTTPException(401, "세션이 만료되었습니다. 다시 로그인하세요")
    user = await db.get(User, uuid.UUID(payload["sub"]))
    if not user or not user.is_active:
        raise HTTPException(401, "유효하지 않은 사용자입니다")
    # 여기서 끊긴 손님 계정은 곧 청소가 지운다(account_sweep). 두 곳의 판정이 어긋나면 아직 시험을
    # 이어 할 수 있는 사람의 계정을 지우게 되므로, 조건은 sessions.py 하나에만 둔다.
    if not session_is_live(session, now, user.role):
        raise HTTPException(
            401,
            DEMO_EXPIRED_MESSAGE if is_demo_admin(user) else "세션이 만료되었습니다. 다시 로그인하세요",
        )
    # 주소 차단은 로그인 시점이 아니라 매 요청에 건다. 로그인 당시엔 멀쩡했던
    # 세션이 지금도 그대로 살아 있으면, 차단은 "다음 로그인부터"가 되어
    # 정작 막고 싶었던 진행 중인 남용을 그대로 통과시킨다.
    await assert_ip_allowed(db, client_ip(request), role=user.role)
    # 둘러보기 계정(데모)은 **바꾸는 요청을 서버가 거절한다.** 화면에서 버튼을 감추는 것으로는
    # 막은 것이 아니다 — 주소만 알면 그대로 부를 수 있다. 인증을 지나는 모든 길이 여기를 지난다.
    if readonly_violation(user.role, request.method, request.url.path):
        raise HTTPException(403, READONLY_MESSAGE)
    # 마지막 활동 시각은 1분에 한 번만 갱신 (매 요청 쓰기 방지)
    if (now - session.last_seen_at).total_seconds() > 60:
        session.last_seen_at = now
        await db.commit()
    return user


#: 남의 응시를 들여다보는 역할. 조작 여부는 별개다 — demo_admin 은 여기 들어 있지만
#: 바꾸는 요청은 get_current_user 가 먼저 거절한다.
#:
#: 권한 판정은 "스태프인가"로 쓰고, "응시자인가"로 쓰지 않는다. 후자는 역할이
#: 하나 늘어날 때마다 조용히 열리는 쪽으로 틀린다 — guest 를 추가했을 때
#: `role == "candidate"` 로 적힌 검사 세 곳이 전부 게스트를 통과시켰다.
STAFF_ROLES = ("admin", "evaluator", DEMO_ADMIN_ROLE)


def is_staff(user: User) -> bool:
    return user.role in STAFF_ROLES


def require_roles(*roles: str):
    async def checker(user: User = Depends(get_current_user)) -> User:
        if user.role not in roles:
            raise HTTPException(403, "권한이 없습니다")
        return user

    return checker


#: 관리 화면의 조회는 둘러보기 계정에도 열어 준다. 바꾸는 요청은 위에서 이미 걸러졌다.
require_admin = require_roles("admin", DEMO_ADMIN_ROLE)
require_staff = require_roles("admin", "evaluator", DEMO_ADMIN_ROLE)

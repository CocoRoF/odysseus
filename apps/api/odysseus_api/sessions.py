"""세션이 살아 있는가 — 한 곳에서만 판정한다.

이 물음은 두 곳에서 나온다.

- **요청을 받을 때** (:func:`odysseus_api.deps.get_current_user`): 이 토큰을 받아 줄 것인가.
- **계정을 지울 때** (:mod:`odysseus_api.account_sweep`): 이 계정으로 다시 들어올 수 있는가.

두 판정이 어긋나면 사고가 난다. 지우는 쪽이 느슨하면 **아직 시험을 이어 할 수 있는 사람의 계정을
지우고**, 받는 쪽이 느슨하면 이미 지운 계정의 토큰을 통과시킨다. 그래서 조건도, 역할별 유휴 한도도
여기에만 둔다 — 한쪽은 객체로 묻고(:func:`session_is_live`) 한쪽은 SQL 로 묻지만
(:func:`live_session_exists`) 조건은 같은 세 줄이다.

세 줄은 이것이다: 폐기되지 않았고(로그아웃·비활성화), 기한이 남았고, 마지막 활동이 유휴 한도 안이다.
"""

from __future__ import annotations

from datetime import datetime, timedelta

from sqlalchemy import select

from .config import settings
from .demo import DEMO_ADMIN_ROLE, DEMO_IDLE_MINUTES
from .models import Session, User


def idle_limit(role: str) -> timedelta:
    """이 역할을 얼마나 놀려 둘 수 있는가.

    둘러보기 계정만 훨씬 짧다. 어차피 다시 들어올 수 없는 계정이라 오래 살려 둘 이유가 없고,
    세션이 살아 있는 동안은 계정도 지우지 못해 사용자 목록에 쌓이기만 한다.
    """
    if role == DEMO_ADMIN_ROLE:
        return timedelta(minutes=DEMO_IDLE_MINUTES)
    return timedelta(hours=settings.session_idle_hours)


def session_is_live(session: Session | None, now: datetime, role: str) -> bool:
    """이 세션으로 지금 요청을 보낼 수 있는가."""
    return bool(
        session is not None
        and session.revoked_at is None
        and session.expires_at > now
        and session.last_seen_at > now - idle_limit(role)
    )


def live_session_exists(now: datetime, role: str):
    """``User.id`` 에 걸리는 상관 EXISTS — 이 사람에게 아직 쓸 수 있는 세션이 있는가.

    :func:`session_is_live` 와 같은 세 조건을 SQL 로 적은 것이다. 한쪽만 고치지 말 것.
    """
    return (
        select(Session.id)
        .where(
            Session.user_id == User.id,
            Session.revoked_at.is_(None),
            Session.expires_at > now,
            Session.last_seen_at > now - idle_limit(role),
        )
        .exists()
    )

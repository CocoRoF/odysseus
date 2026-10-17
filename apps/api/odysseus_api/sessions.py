"""세션이 살아 있는가 — 한 곳에서만 판정한다.

요청을 받을 때(:func:`odysseus_api.deps.get_current_user`)와 로그인 화면이 "지금 누구인가" 를 물을 때
(:func:`odysseus_api.routers.auth._session_user`) 같은 조건을 써야 한다. 한쪽만 느슨하면 다른 쪽에서
이미 끝난 세션이 살아 있는 것처럼 보인다.

조건은 세 줄이다: 폐기되지 않았고(로그아웃·비활성화), 기한이 남았고, 마지막 활동이 유휴 한도 안이다.
"""

from __future__ import annotations

from datetime import datetime, timedelta

from .config import settings
from .models import Session


def idle_limit() -> timedelta:
    """세션을 얼마나 놀려 둘 수 있는가."""
    return timedelta(hours=settings.session_idle_hours)


def session_is_live(session: Session | None, now: datetime) -> bool:
    """이 세션으로 지금 요청을 보낼 수 있는가."""
    return bool(
        session is not None
        and session.revoked_at is None
        and session.expires_at > now
        and session.last_seen_at > now - idle_limit()
    )

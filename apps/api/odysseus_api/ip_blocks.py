"""주소 차단: 단일 IP 또는 CIDR 대역.

차단은 로그인 시점이 아니라 **매 요청**에 건다(:func:`odysseus_api.deps.get_current_user`). 관리 화면은
[설정] → 주소 차단이고 API 는 :mod:`odysseus_api.routers.access` 다.
"""

from __future__ import annotations

import ipaddress
import time

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .models import BlockedIp


def _parse(entry: str) -> ipaddress._BaseNetwork | None:
    """저장된 문자열 → 네트워크. 단일 IP 는 /32(/128) 로 읽는다."""
    text = (entry or "").strip()
    if not text:
        return None
    try:
        return ipaddress.ip_network(text, strict=False)
    except ValueError:
        return None


def normalize_cidr(entry: str) -> str:
    """관리자가 입력한 값을 저장 형태로. 잘못된 값은 거절한다.

    입력을 그대로 담아두면 "203.0.113.7" 과 "203.0.113.7/32" 가 서로 다른
    행이 되어, 하나만 지우고 차단이 풀린 줄 아는 일이 생긴다.
    """
    net = _parse(entry)
    if net is None:
        raise HTTPException(400, "IP 또는 CIDR 형식이 아닙니다")
    if net.num_addresses == 1:
        return str(net.network_address)
    return str(net)


def is_blocked(ip: str, entries: list[str]) -> bool:
    """*ip* 가 차단 목록에 걸리는지. 판정 불가한 값은 막지 않는다.

    프록시 뒤에서 주소를 못 읽는 경우가 있고, 그때 '모르니까 차단'은
    전체 서비스를 잠그는 쪽으로 실패한다.
    """
    try:
        addr = ipaddress.ip_address((ip or "").strip())
    except ValueError:
        return False
    for entry in entries:
        net = _parse(entry)
        if net is not None and addr.version == net.version and addr in net:
            return True
    return False


#: 차단 목록 캐시. 이 목록은 모든 요청에서 읽히지만 거의 바뀌지 않는다.
#: 요청마다 SELECT 를 도는 대신 짧게 캐시한다. TTL 이 있으므로 워커가 여러
#: 개여도 몇 초 안에 서로 수렴하고, 같은 워커 안의 변경은 즉시 반영된다.
_CACHE_TTL_S = 10.0
_cache: tuple[float, list[str]] | None = None


def invalidate_cache() -> None:
    """차단 목록을 바꾼 직후 호출한다. 방금 한 조치가 곧바로 들어야 한다."""
    global _cache
    _cache = None


async def blocked_entries(db: AsyncSession) -> list[str]:
    global _cache
    now = time.monotonic()
    if _cache is not None and now - _cache[0] < _CACHE_TTL_S:
        return _cache[1]
    rows = [r for r in (await db.execute(select(BlockedIp.cidr))).scalars()]
    _cache = (now, rows)
    return rows


async def assert_ip_allowed(db: AsyncSession, ip: str, *, role: str | None = None) -> None:
    """*ip* 가 차단 목록에 있으면 403. 관리자는 예외.

    관리자를 면제하는 이유는 편의가 아니라 복구 가능성이다. 자기 대역을 실수로
    넣으면 차단을 푸는 화면 자체에 못 들어가고, 그때 남는 수단은 DB 직접 수정뿐이다.
    되돌릴 수 없는 조치는 결국 아무도 쓰지 않게 된다.
    """
    if role == "admin":
        return
    if is_blocked(ip, await blocked_entries(db)):
        raise HTTPException(403, "차단된 주소입니다")

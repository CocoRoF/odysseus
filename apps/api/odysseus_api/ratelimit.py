"""요청 속도·동시성·비용 상한 (ODY-010).

프로세스 안 토큰 버킷이다 — api 는 단일 인스턴스로 돈다. 여러 인스턴스로 늘리면 Redis 로
옮겨야 한다 (키 규약은 그대로 쓰면 된다).

세 종류를 제공한다:
  * `limiter(scope, per_min, burst)` — FastAPI 의존성. 키는 로그인 사용자 id, 없으면 클라이언트 IP.
    넘으면 429 + Retry-After.
  * `login_guard` — 로그인 전용. IP 별 속도 + (이메일별) 실패 누적 잠금(지수 backoff).
  * `check(key, per_min, burst)` — 라우터 안에서 직접 쓰는 원시 함수 (응시별 키 등).

클라이언트 IP 는 엣지(nginx)가 붙인 X-Forwarded-For, 그 앞의 Cloudflare 가 붙인 CF-Connecting-IP
순으로 본다 — api 는 엣지와 루프백에서만 접근되므로 이 헤더를 믿어도 된다.
"""

from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass

from fastapi import Depends, HTTPException, Request

log = logging.getLogger("odysseus.ratelimit")


@dataclass
class _Bucket:
    tokens: float
    updated: float


_buckets: dict[str, _Bucket] = {}
_lock = threading.Lock()
_MAX_KEYS = 50_000


def _prune(now: float) -> None:
    if len(_buckets) < _MAX_KEYS:
        return
    stale = [k for k, b in _buckets.items() if now - b.updated > 600]
    for k in stale:
        _buckets.pop(k, None)


def check(key: str, per_min: float, burst: int) -> float:
    """허용이면 0, 아니면 다시 시도할 때까지의 초."""
    now = time.monotonic()
    rate = per_min / 60.0
    with _lock:
        _prune(now)
        b = _buckets.get(key)
        if b is None:
            b = _Bucket(tokens=float(burst), updated=now)
            _buckets[key] = b
        b.tokens = min(float(burst), b.tokens + (now - b.updated) * rate)
        b.updated = now
        if b.tokens >= 1.0:
            b.tokens -= 1.0
            return 0.0
        return max(1.0, (1.0 - b.tokens) / rate)


def client_ip(request: Request) -> str:
    cf = request.headers.get("cf-connecting-ip")
    if cf:
        return cf.strip()
    xff = request.headers.get("x-forwarded-for")
    if xff:
        return xff.split(",")[0].strip()
    return request.client.host if request.client else "?"


def too_many(retry_after: float, what: str = "요청") -> HTTPException:
    secs = int(retry_after) + 1
    return HTTPException(
        429,
        f"{what}이 너무 잦습니다. {secs}초 뒤에 다시 시도하세요",
        headers={"Retry-After": str(secs)},
    )


def enforce(key: str, per_min: float, burst: int, what: str = "요청") -> None:
    wait = check(key, per_min, burst)
    if wait:
        log.info("rate limited key=%s scope=%s retry=%.0fs", key[:80], what, wait)
        raise too_many(wait, what)


def limiter(scope: str, per_min: float, burst: int, what: str = "요청"):
    """엔드포인트 의존성 — 로그인 사용자별(없으면 IP 별) 버킷."""

    async def dep(request: Request) -> None:
        from .deps import get_current_user  # 순환 import 방지

        subject = None
        try:
            # 쿠키/헤더에 토큰이 있으면 사용자 id 로, 아니면 IP 로 — DB 를 거치지 않는다
            from .security import COOKIE_NAME, decode_token

            token = request.cookies.get(COOKIE_NAME)
            if not token:
                auth = request.headers.get("Authorization", "")
                token = auth[7:] if auth.startswith("Bearer ") else None
            payload = decode_token(token) if token else None
            subject = payload.get("sub") if payload else None
        except Exception:  # noqa: BLE001
            subject = None
        key = f"{scope}:{'u:' + subject if subject else 'ip:' + client_ip(request)}"
        enforce(key, per_min, burst, what)

    return dep


# ── 로그인: IP 속도 + 이메일별 실패 잠금 ─────────────────────────

_failures: dict[str, tuple[int, float]] = {}  # email → (연속 실패 수, 마지막 실패 시각)
LOGIN_FREE_FAILURES = 5
LOCK_BASE_S = 30.0
LOCK_MAX_S = 15 * 60.0
FAIL_WINDOW_S = 15 * 60.0


def _lock_seconds(failures: int) -> float:
    """실패 5회까지는 잠그지 않는다. 6회째부터 30초, 그 뒤 실패마다 2배 (최대 15분)."""
    if failures <= LOGIN_FREE_FAILURES:
        return 0.0
    return min(LOCK_MAX_S, LOCK_BASE_S * (2 ** (failures - LOGIN_FREE_FAILURES - 1)))


def login_locked(email: str) -> float:
    """이 이메일이 잠겨 있으면 남은 초, 아니면 0."""
    now = time.monotonic()
    with _lock:
        rec = _failures.get(email)
        if not rec:
            return 0.0
        n, last = rec
        if now - last > FAIL_WINDOW_S:
            _failures.pop(email, None)
            return 0.0
        remaining = _lock_seconds(n) - (now - last)
        return max(0.0, remaining)


def login_failed(email: str, ip: str) -> float:
    """실패를 누적하고, 잠금이 시작됐으면 그 길이를 돌려준다."""
    now = time.monotonic()
    with _lock:
        n, last = _failures.get(email, (0, now))
        n = n + 1 if now - last <= FAIL_WINDOW_S else 1
        _failures[email] = (n, now)
        if len(_failures) > _MAX_KEYS:
            for k in [k for k, (_, t) in _failures.items() if now - t > FAIL_WINDOW_S]:
                _failures.pop(k, None)
    lock = _lock_seconds(n)
    log.warning("login failed email=%s ip=%s consecutive=%d lock=%.0fs", email, ip, n, lock)
    return lock


def login_succeeded(email: str) -> None:
    with _lock:
        _failures.pop(email, None)


def reset_for_tests() -> None:
    with _lock:
        _buckets.clear()
        _failures.clear()

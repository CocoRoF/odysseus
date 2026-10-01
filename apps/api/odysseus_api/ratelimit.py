"""요청 속도·동시성·비용 상한 (ODY-010).

Token buckets and login-failure backoff live in Redis so multiple API replicas enforce one shared
budget. A small process-local implementation remains only as a degradation fallback when Redis is
briefly unavailable; the API does not silently lose all rate limiting during an outage.
"""

from __future__ import annotations

import hashlib
import logging
import threading
import time
from dataclasses import dataclass

import redis
from fastapi import HTTPException, Request

from .config import settings

log = logging.getLogger("odysseus.ratelimit")


@dataclass
class _Bucket:
    tokens: float
    updated: float


_buckets: dict[str, _Bucket] = {}
_lock = threading.Lock()
_MAX_KEYS = 50_000
_sync_redis: redis.Redis | None = None
# Redis 가 죽어 있는 동안 모든 요청이 연결 타임아웃(0.25s)을 이벤트 루프에서 물지 않도록,
# 실패 뒤 잠깐은 바로 로컬 폴백으로 간다.
_redis_down_until = 0.0
_REDIS_RETRY_S = 5.0


def _redis_usable() -> bool:
    return time.monotonic() >= _redis_down_until


def _redis_failed() -> None:
    global _redis_down_until
    _redis_down_until = time.monotonic() + _REDIS_RETRY_S

_BUCKET_LUA = """
local t = redis.call('TIME')
local now = tonumber(t[1]) + tonumber(t[2]) / 1000000
local capacity = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local vals = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(vals[1]) or capacity
local ts = tonumber(vals[2]) or now
if now > ts then tokens = math.min(capacity, tokens + (now - ts) * rate) end
local allowed = 0
local wait = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
else
  wait = (1 - tokens) / rate
end
redis.call('HSET', KEYS[1], 'tokens', tokens, 'ts', now)
local ttl = math.max(60, math.ceil((capacity / rate) * 2))
redis.call('EXPIRE', KEYS[1], ttl)
return {allowed, tostring(wait)}
"""


def _redis() -> redis.Redis:
    global _sync_redis
    if _sync_redis is None:
        _sync_redis = redis.Redis.from_url(
            settings.redis_url, decode_responses=True, socket_connect_timeout=0.25, socket_timeout=0.5
        )
    return _sync_redis


def _digest_key(prefix: str, value: str) -> str:
    # Redis operators should not see candidate emails/IPs or other raw subjects in key names.
    digest = hashlib.sha256(value.encode("utf-8", errors="replace")).hexdigest()
    return f"odysseus:{prefix}:{digest}"


def _prune(now: float) -> None:
    if len(_buckets) < _MAX_KEYS:
        return
    stale = [k for k, b in _buckets.items() if now - b.updated > 600]
    for k in stale:
        _buckets.pop(k, None)


def _local_check(key: str, per_min: float, burst: int) -> float:
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


def check(key: str, per_min: float, burst: int) -> float:
    """허용이면 0, 아니면 다시 시도할 때까지의 초. 모든 API replica가 같은 Redis bucket을 본다."""
    if per_min <= 0 or burst <= 0:
        return 60.0
    if not _redis_usable():
        return _local_check(key, per_min, burst)
    try:
        result = _redis().eval(
            _BUCKET_LUA,
            1,
            _digest_key("ratelimit", key),
            max(1, int(burst)),
            float(per_min) / 60.0,
        )
        allowed = int(result[0])
        wait = float(result[1])
        return 0.0 if allowed else max(1.0, wait)
    except (redis.RedisError, OSError, ValueError, TypeError):
        _redis_failed()
        log.warning("Redis rate limiter unavailable; using process-local fallback")
        return _local_check(key, per_min, burst)


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
        log.info("rate limited key_hash=%s scope=%s retry=%.0fs", hashlib.sha256(key.encode()).hexdigest()[:12], what, wait)
        raise too_many(wait, what)


def limiter(scope: str, per_min: float, burst: int, what: str = "요청"):
    async def dep(request: Request) -> None:
        subject = None
        try:
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

_failures: dict[str, tuple[int, float]] = {}
LOGIN_FREE_FAILURES = 5
LOCK_BASE_S = 30.0
LOCK_MAX_S = 15 * 60.0
FAIL_WINDOW_S = 15 * 60.0


def _lock_seconds(failures: int) -> float:
    if failures <= LOGIN_FREE_FAILURES:
        return 0.0
    return min(LOCK_MAX_S, LOCK_BASE_S * (2 ** (failures - LOGIN_FREE_FAILURES - 1)))


def _local_login_locked(email: str) -> float:
    now = time.monotonic()
    with _lock:
        rec = _failures.get(email)
        if not rec:
            return 0.0
        n, last = rec
        if now - last > FAIL_WINDOW_S:
            _failures.pop(email, None)
            return 0.0
        return max(0.0, _lock_seconds(n) - (now - last))


def login_locked(email: str) -> float:
    email = email.strip().lower()
    key = _digest_key("loginfail", email)
    if not _redis_usable():
        return _local_login_locked(email)
    try:
        values = _redis().hmget(key, "count", "last")
        if not values or not values[0] or not values[1]:
            return 0.0
        n, last = int(values[0]), float(values[1])
        age = max(0.0, time.time() - last)
        return max(0.0, _lock_seconds(n) - age)
    except (redis.RedisError, OSError, ValueError, TypeError):
        _redis_failed()
        return _local_login_locked(email)


def login_failed(email: str, ip: str) -> float:
    now_epoch = time.time()
    email = email.strip().lower()
    key = _digest_key("loginfail", email)
    try:
        if not _redis_usable():
            raise redis.RedisError("circuit open")
        pipe = _redis().pipeline(transaction=True)
        pipe.hincrby(key, "count", 1)
        pipe.hset(key, "last", now_epoch)
        pipe.expire(key, int(FAIL_WINDOW_S))
        result = pipe.execute()
        n = int(result[0])
        lock_s = _lock_seconds(n)
    except (redis.RedisError, OSError, ValueError, TypeError):
        _redis_failed()
        now = time.monotonic()
        with _lock:
            n, last = _failures.get(email, (0, now))
            n = n + 1 if now - last <= FAIL_WINDOW_S else 1
            _failures[email] = (n, now)
        lock_s = _lock_seconds(n)
    log.warning("login failed email_hash=%s ip_hash=%s consecutive=%d lock=%.0fs", hashlib.sha256(email.encode()).hexdigest()[:12], hashlib.sha256(ip.encode()).hexdigest()[:12], n, lock_s)
    return lock_s


def login_succeeded(email: str) -> None:
    email = email.strip().lower()
    try:
        if _redis_usable():
            _redis().delete(_digest_key("loginfail", email))
    except (redis.RedisError, OSError):
        _redis_failed()
    with _lock:
        _failures.pop(email, None)


def reset_for_tests() -> None:
    """Reset process fallback state. Redis test fixtures should use an isolated database/prefix."""
    with _lock:
        _buckets.clear()
        _failures.clear()

"""프로세스 경계를 넘는 짧은 임대(lease) 잠금.

API를 여러 인스턴스로 늘려도 같은 응시/대화 턴이 동시에 실행되지 않도록 Redis에
SET NX PX로 소유권을 둔다. 해제는 토큰을 비교한 뒤 DEL하는 Lua 스크립트로 수행해
만료 뒤 다른 프로세스가 얻은 잠금을 예전 요청이 지우지 못하게 한다.

**TTL 은 짧게 잡고, 쥐고 있는 동안 갱신한다.** 턴 하나는 도구 반복 × 공급자 타임아웃으로 몇 분을
갈 수 있는데, 그 길이만큼 TTL 을 길게 잡으면 해제를 못 한 채 프로세스가 사라졌을 때(배포로
컨테이너가 교체되는 경우) 응시자가 그 시간 내내 409 를 받는다. 시험 시간은 그동안에도 흐른다.
갱신은 lease 를 얻은 프로세스의 백그라운드 태스크가 하므로, 프로세스가 죽으면 갱신도 멈추고
표시는 TTL 안에 저절로 사라진다 — 누구의 살아 있는 lease 도 대신 지우지 않는다.
"""

from __future__ import annotations

import asyncio
import logging
import secrets
import time
from dataclasses import dataclass, field

from redis.exceptions import RedisError

from .runqueue import get_redis

log = logging.getLogger("odysseus.locks")
# Redis 가 잠시 없을 때의 프로세스 로컬 폴백 — 단일 인스턴스에서는 main 의 asyncio.Lock 과 같은 보장이다.
# 여러 인스턴스라면 폴백 동안 인스턴스 간 배타는 잃지만, 500 으로 대화를 끊는 것보다 낫다.
_local_held: dict[str, float] = {}

_PREFIX = "odysseus:lease:"

#: 갱신이 멈춘 lease 가 남아 있는 최대 시간(초). 배포로 끊긴 대화가 다시 열리기까지의 시간이다.
LEASE_TTL_S = 60.0

_RELEASE_SCRIPT = """
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0
"""

# 아직 내 것일 때만 만료를 늦춘다. 이미 만료돼 다른 요청이 얻은 lease 를 늘려 주면 안 된다.
_RENEW_SCRIPT = """
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('pexpire', KEYS[1], ARGV[2])
end
return 0
"""


@dataclass(slots=True)
class RedisLease:
    key: str
    token: str
    local: bool = False
    ttl_s: float = LEASE_TTL_S
    #: 갱신을 멈추는 상한(초). 해제가 어떤 이유로도 불리지 않을 때의 마지막 안전장치다.
    max_hold_s: float | None = None
    #: 쥐고 있는 동안 만료를 늦추는 태스크. 이 객체가 강한 참조를 들고 있어야 도중에 수거되지 않는다.
    _renewer: asyncio.Task | None = field(default=None, repr=False)

    def _start_renewal(self) -> None:
        self._renewer = asyncio.get_running_loop().create_task(
            self._renew_forever(), name=f"lease-renew:{self.key}"
        )

    async def _renew_forever(self) -> None:
        # TTL 의 1/4 마다 — Redis 가 한두 번 늦게 답해도 만료 전에 다시 시도할 여유가 있다.
        interval = max(0.2, self.ttl_s / 4)
        ttl_ms = max(1, int(self.ttl_s * 1000))
        give_up_at = None if self.max_hold_s is None else time.monotonic() + self.max_hold_s
        while True:
            await asyncio.sleep(interval)
            if give_up_at is not None and time.monotonic() >= give_up_at:
                log.warning("lease held past its limit; renewal stopped key=%s", self.key)
                return
            if self.local:
                if self.key not in _local_held:
                    return
                _local_held[self.key] = time.monotonic() + self.ttl_s
                continue
            try:
                renewed = await get_redis().eval(_RENEW_SCRIPT, 1, self.key, self.token, ttl_ms)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 — 한 번 실패해도 다음 주기에 다시 시도한다
                log.warning("lease renewal failed key=%s: %s", self.key, type(exc).__name__)
                continue
            if not renewed:
                # 갱신이 늦어 만료됐고 다른 요청이 얻었을 수 있다. 남의 lease 는 건드리지 않고 멈춘다.
                log.warning("lease lost before release key=%s", self.key)
                return

    async def release(self) -> None:
        if self._renewer is not None:
            self._renewer.cancel()
            self._renewer = None
        if self.local:
            if _local_held.get(self.key) is not None:
                _local_held.pop(self.key, None)
            return
        try:
            # 요청 태스크가 취소(클라이언트 이탈)돼도 Redis 쪽 DEL 은 끝까지 간다 — 그렇지 않으면
            # 새로고침 한 번에 이 응시의 다음 턴이 TTL 동안 409 로 막힌다.
            await asyncio.shield(get_redis().eval(_RELEASE_SCRIPT, 1, self.key, self.token))
        except asyncio.CancelledError:
            pass
        except Exception:
            # 해제 실패가 사용자 응답을 깨면 안 된다. 갱신은 이미 멈췄으므로 TTL 안에 풀린다.
            pass


async def acquire_lease(
    name: str, *, ttl_s: float = LEASE_TTL_S, max_hold_s: float | None = None
) -> RedisLease | None:
    """이름의 분산 lease를 얻는다. 이미 누가 가지고 있으면 None.

    얻은 lease 는 :meth:`RedisLease.release` 전까지 스스로 갱신된다. ``ttl_s`` 는 턴의 길이가
    아니라 "해제하지 못한 채 프로세스가 사라졌을 때 얼마 만에 풀리는가" 다. ``max_hold_s`` 를 주면
    그 시간이 지난 뒤로는 갱신하지 않는다 — 턴이 그보다 길 수 없는 곳에서 쓴다.
    """
    token = secrets.token_urlsafe(24)
    key = _PREFIX + name
    ttl = max(1.0, float(ttl_s))
    try:
        ok = await get_redis().set(key, token, nx=True, px=int(ttl * 1000))
    except (RedisError, OSError):
        log.warning("Redis lease unavailable; process-local fallback name=%s", name)
        now = time.monotonic()
        held_until = _local_held.get(key)
        if held_until is not None and held_until > now:
            return None
        _local_held[key] = now + ttl
        lease = RedisLease(key=key, token=token, local=True, ttl_s=ttl, max_hold_s=max_hold_s)
        lease._start_renewal()
        return lease
    if not ok:
        return None
    lease = RedisLease(key=key, token=token, ttl_s=ttl, max_hold_s=max_hold_s)
    lease._start_renewal()
    return lease

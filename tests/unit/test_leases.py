"""대화 lease 가 스스로 풀리는가 — Redis 가 없을 때의 프로세스 로컬 폴백.

lease 는 TTL 을 짧게 잡고 쥐고 있는 동안 갱신한다. 그래서
  · 턴이 TTL 보다 길어도 도는 동안에는 두 번째 턴이 들어오지 못하고,
  · 해제되면 바로, 갱신이 멈추면(프로세스가 사라지면) TTL 안에 다시 열린다.
진짜 Redis 에서의 같은 약속은 tests/integration/test_leases.py 가 본다.
"""

import asyncio
import pathlib
import sys
import unittest
from unittest.mock import patch

REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "apps" / "api"))

from redis.exceptions import ConnectionError as RedisConnectionError  # noqa: E402

from odysseus_api import locks  # noqa: E402


class _NoRedis:
    async def set(self, *_a, **_k):
        raise RedisConnectionError("redis is down")

    async def eval(self, *_a, **_k):
        raise RedisConnectionError("redis is down")


class LocalFallbackLeaseTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        locks._local_held.clear()
        self.no_redis = patch.object(locks, "get_redis", lambda: _NoRedis())
        self.no_redis.start()

    def tearDown(self):
        self.no_redis.stop()
        locks._local_held.clear()

    async def test_a_held_lease_outlives_its_ttl_while_renewed(self):
        first = await locks.acquire_lease("agent-turn:a", ttl_s=1)
        self.assertIsNotNone(first)
        self.assertTrue(first.local)
        await asyncio.sleep(1.6)
        self.assertIsNone(await locks.acquire_lease("agent-turn:a", ttl_s=1), "갱신 중인 lease 를 빼앗았다")
        await first.release()
        second = await locks.acquire_lease("agent-turn:a", ttl_s=1)
        self.assertIsNotNone(second, "해제한 뒤에도 열리지 않는다")
        await second.release()

    async def test_an_abandoned_lease_expires_within_its_ttl(self):
        orphan = await locks.acquire_lease("messenger-turn:a", ttl_s=1)
        orphan._renewer.cancel()  # 해제하지 못한 채 프로세스가 사라진 경우 — 갱신만 멈춘다
        self.assertIsNone(await locks.acquire_lease("messenger-turn:a", ttl_s=1))
        await asyncio.sleep(1.2)
        taken = await locks.acquire_lease("messenger-turn:a", ttl_s=1)
        self.assertIsNotNone(taken, "갱신이 멈춘 lease 가 TTL 뒤에도 남아 있다")
        await taken.release()

    async def test_renewal_stops_at_the_hold_limit(self):
        stuck = await locks.acquire_lease("agent-turn:b", ttl_s=1, max_hold_s=0.5)
        await asyncio.sleep(2.0)
        taken = await locks.acquire_lease("agent-turn:b", ttl_s=1)
        self.assertIsNotNone(taken, "상한을 넘긴 lease 가 계속 갱신됐다")
        self.assertTrue(stuck._renewer.done())
        await taken.release()


if __name__ == "__main__":
    unittest.main()

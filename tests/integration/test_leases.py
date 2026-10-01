"""대화 lease 의 갱신과 만료 — 일회용 Redis 에서만 돈다.

ODYSSEUS_REDIS_INTEGRATION=1 REDIS_URL=redis://... python -m unittest discover -s tests/integration -p 'test_leases.py'

배포로 api 가 교체되면 턴의 finally 가 lease 를 해제하지 못한다. 예전에는 TTL(에이전트 30분)
내내 그 응시자가 409 를 받았고, 기동할 때 전부 지우는 방법은 다른 프로세스의 **살아 있는** lease
까지 지웠다. 지금은 짧은 TTL + 갱신이라, 갱신이 멈춘 lease 만 저절로 사라진다.
"""

import asyncio
import os
import unittest

from odysseus_api import locks, runqueue


@unittest.skipUnless(os.getenv("ODYSSEUS_REDIS_INTEGRATION") == "1", "requires disposable Redis")
class RedisLeaseTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        # 클라이언트는 이벤트 루프에 묶인다 — 테스트마다 새 루프이므로 새로 만든다.
        runqueue._redis = None
        self.redis = runqueue.get_redis()
        await self.redis.ping()
        self.names = []

    async def asyncTearDown(self):
        for name in self.names:
            await self.redis.delete(locks._PREFIX + name)
        await self.redis.aclose()
        runqueue._redis = None

    def name(self, suffix):
        name = f"test-turn:{os.getpid()}:{id(self)}:{suffix}"
        self.names.append(name)
        return name

    async def test_a_held_lease_is_renewed_past_its_ttl(self):
        name = self.name("held")
        lease = await locks.acquire_lease(name, ttl_s=1)
        self.assertIsNotNone(lease)
        self.assertFalse(lease.local)
        await asyncio.sleep(2.5)
        self.assertGreater(await self.redis.pttl(locks._PREFIX + name), 0)
        self.assertIsNone(await locks.acquire_lease(name, ttl_s=1), "갱신 중인 lease 를 빼앗았다")
        await lease.release()
        self.assertEqual(await self.redis.exists(locks._PREFIX + name), 0)

    async def test_an_orphaned_lease_expires_without_touching_the_next_holder(self):
        name = self.name("orphan")
        orphan = await locks.acquire_lease(name, ttl_s=1)
        orphan._renewer.cancel()  # 배포로 프로세스가 사라진 경우 — 해제도 갱신도 없다
        await asyncio.sleep(1.3)
        successor = await locks.acquire_lease(name, ttl_s=1)
        self.assertIsNotNone(successor, "갱신이 멈춘 lease 가 TTL 뒤에도 남아 있다")

        # 뒤늦게 돌아온 옛 소유자가 해제하거나 갱신해도 새 소유자의 lease 는 그대로다
        await orphan.release()
        self.assertEqual(await self.redis.get(locks._PREFIX + name), successor.token)
        renewed = await self.redis.eval(locks._RENEW_SCRIPT, 1, locks._PREFIX + name, orphan.token, 60_000)
        self.assertEqual(renewed, 0)
        self.assertLessEqual(await self.redis.pttl(locks._PREFIX + name), 1000)
        await successor.release()

    async def test_a_lost_lease_stops_renewing(self):
        name = self.name("lost")
        lease = await locks.acquire_lease(name, ttl_s=1)
        # 누군가 만료 뒤에 얻은 상황을 흉내 낸다 — 토큰이 바뀌면 갱신은 멈춰야 한다
        await self.redis.set(locks._PREFIX + name, "someone-else", px=5000)
        await asyncio.sleep(0.8)
        self.assertTrue(lease._renewer.done(), "남의 lease 를 계속 갱신하려 한다")
        self.assertEqual(await self.redis.get(locks._PREFIX + name), "someone-else")
        await lease.release()
        self.assertEqual(await self.redis.get(locks._PREFIX + name), "someone-else")


if __name__ == "__main__":
    unittest.main()

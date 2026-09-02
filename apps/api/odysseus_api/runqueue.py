import json

import redis.asyncio as aioredis

from .config import settings

QUEUE_KEY = "odysseus:run:queue"

_redis: aioredis.Redis | None = None


def get_redis() -> aioredis.Redis:
    global _redis
    if _redis is None:
        _redis = aioredis.from_url(settings.redis_url, decode_responses=True)
    return _redis


async def enqueue_run(execution_id: str, command: str, files: list[dict], timeout_s: int) -> None:
    job = {
        "execution_id": execution_id,
        "command": command,
        "files": files,
        "timeout_s": timeout_s,
    }
    await get_redis().lpush(QUEUE_KEY, json.dumps(job))

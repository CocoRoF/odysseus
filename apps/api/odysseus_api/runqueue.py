import json
import secrets

import redis.asyncio as aioredis

from .config import settings

QUEUE_KEY = "odysseus:run:queue"

_redis: aioredis.Redis | None = None


def get_redis() -> aioredis.Redis:
    global _redis
    if _redis is None:
        _redis = aioredis.from_url(settings.redis_url, decode_responses=True)
    return _redis


def new_callback_token() -> str:
    """실행 1건의 결과 보고에만 쓰이는 토큰 — Execution.callback_token 에 저장하고 큐로 보낸다."""
    return secrets.token_urlsafe(32)


async def enqueue_run(
    execution_id: str,
    command: str,
    files: list[dict],
    timeout_s: int,
    *,
    attempt_id: str = "",
    scenario_id: str = "",
    source: str = "",
    callback_token: str = "",
) -> None:
    # attempt/scenario 를 함께 보내는 이유: 러너의 자원 샘플러가 "누구의 실행인지"를
    # 알아야 응시자 화면과 관리자 대시보드에서 갈라 보여 줄 수 있다.
    job = {
        "execution_id": execution_id,
        "command": command,
        "files": files,
        "timeout_s": timeout_s,
        "attempt_id": attempt_id,
        "scenario_id": scenario_id,
        "source": source,
        # 러너는 이 값을 X-Execution-Token 으로 되돌려 준다 — 없거나 다르면 결과가 접수되지 않는다
        "callback_token": callback_token,
    }
    await get_redis().lpush(QUEUE_KEY, json.dumps(job))

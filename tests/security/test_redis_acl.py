"""ODY-003 검증 — Redis ACL (api 컨테이너 안에서 실행).

  docker cp tests/security/test_redis_acl.py <api>:/tmp/
  docker exec -e REDIS_RUNNER_PASSWORD=... <api> python3 /tmp/test_redis_acl.py

REDIS_URL(api 계정)은 컨테이너 환경에 있고, runner 비밀번호는 인자로 받는다.
"""

import json
import os
import sys
import urllib.parse

import redis

api_url = os.environ["REDIS_URL"]
u = urllib.parse.urlsplit(api_url)
host, port = u.hostname, u.port or 6379
runner_pw = os.environ["REDIS_RUNNER_PASSWORD"]
ok = fail = 0


def check(name, cond, detail=""):
    global ok, fail
    if cond:
        ok += 1
        print(f"  PASS {name}")
    else:
        fail += 1
        print(f"  FAIL {name} {str(detail)[:200]}")


def denied(fn):
    try:
        fn()
        return False, "허용됨"
    except redis.exceptions.NoPermissionError as e:
        return True, str(e)
    except redis.exceptions.AuthenticationError as e:
        return True, str(e)
    except redis.exceptions.ResponseError as e:
        return "NOPERM" in str(e) or "NOAUTH" in str(e) or "WRONGPASS" in str(e), str(e)


print("\n── 무인증 / 기본 사용자 ──")
anon = redis.Redis(host=host, port=port, socket_connect_timeout=3)
d, msg = denied(lambda: anon.ping())
check("인증 없는 PING 거부", d, msg)
d, msg = denied(lambda: redis.Redis(host=host, port=port, username="default", password="anything").ping())
check("default 사용자는 꺼져 있다", d, msg)

print("\n── runner 계정 ──")
r = redis.Redis(host=host, port=port, username="runner", password=runner_pw, decode_responses=True)
check("runner PING", r.ping() is True)
d, msg = denied(lambda: r.lpush("odysseus:run:queue", json.dumps({"execution_id": "forged"})))
check("runner 는 큐에 넣을 수 없다 (LPUSH)", d, msg)
d, msg = denied(lambda: r.keys("*"))
check("runner 는 KEYS 불가", d, msg)
d, msg = denied(lambda: r.flushall())
check("runner 는 FLUSHALL 불가", d, msg)
d, msg = denied(lambda: r.get("some:other:key"))
check("runner 는 자기 prefix 밖 키 불가", d, msg)
d, msg = denied(lambda: r.delete("odysseus:run:queue"))
check("runner 는 큐 DEL 불가", d, msg)
check("runner 는 큐 길이 조회 가능 (LLEN)", isinstance(r.llen("odysseus:run:queue"), int))
check("runner 는 자기 통계 키 SET 가능", r.set("odysseus:runner:acltest", "1", ex=5) is True)
check("runner 는 취소 집합 조회 가능 (SMEMBERS)", isinstance(r.smembers("odysseus:runner:cancel"), set))

print("\n── api 계정 ──")
a = redis.Redis.from_url(api_url, decode_responses=True)
check("api PING", a.ping() is True)
check("api 는 큐 길이 조회", isinstance(a.llen("odysseus:run:queue"), int))
check("api 는 취소 집합 SADD 가능", a.sadd("odysseus:runner:cancel", "acl-test") >= 0)
a.srem("odysseus:runner:cancel", "acl-test")
a.delete("odysseus:runner:acltest")

print(f"\n{ok} passed, {fail} failed")
sys.exit(1 if fail else 0)

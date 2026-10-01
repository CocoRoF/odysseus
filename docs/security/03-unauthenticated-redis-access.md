# ODY-003: 인증 없는 Redis에 응시자 코드가 접근

## 취약점 요약

- **심각도:** 치명적
- **영향:** 실행 큐 열람·변조, 실행 취소, 정보 노출, 러너 서비스 거부
- **원인:** 러너와 Redis가 같은 sandbox 네트워크에 있고 Redis 인증·ACL·TLS가 없다.
- **주요 근거:** `docker-compose.yml:32`, `docker-compose.yml:72`, `apps/api/odysseus_api/runqueue.py:7`, `apps/runner/worker.py:377`

## 상세

응시자 명령은 runner 컨테이너에서 실행되고 runner는 `sandbox` 네트워크의 Redis에 연결되어 있다. 실행 프로세스 역시 이 네트워크 경계를 공유하므로 `redis:6379`에 도달할 수 있다. 이미지에는 Python Redis 클라이언트도 설치되어 있다.

Redis에는 비밀번호와 ACL이 없고 작업 큐, 취소 집합, 활성 실행 통계가 같은 DB에 저장된다. 따라서 네트워크 격리가 인터넷만 차단할 뿐 내부 제어면을 보호하지 못한다.

## 재현 방법(공격 방법)

공용 큐를 변경하지 않도록 읽기와 전용 테스트 키만 사용한다. 본인 테스트 응시 터미널에서 다음 명령을 실행한다.

```bash
python3 - <<'PY'
import redis
r = redis.Redis(host="redis", port=6379, decode_responses=True)
print("PING:", r.ping())
print("queue length:", r.llen("odysseus:run:queue"))
r.set("security:test:owned", "1", ex=30)
print("write/read:", r.get("security:test:owned"))
PY
```

`PING: True`와 쓰기 성공이 확인되면 취약하다. 운영 큐에 `LPUSH`, `DEL`, `FLUSH*`를 실행해서는 안 된다.

## 공격 예시

1. **큐 정보 유출:** `LLEN`/`LRANGE`로 대기 작업의 명령, 파일 내용, attempt/scenario UUID를 읽는다.
2. **작업 주입:** `odysseus:run:queue`에 조작한 JSON을 삽입하여 러너 시간을 소비하거나 특정 execution 결과를 위조하려 시도한다.
3. **실행 강제 종료:** `odysseus:runner:cancel` 집합에 관측한 execution UUID를 넣어 다른 작업을 중단시킨다.
4. **러너 DoS:** 매우 많은 큐 항목이나 큰 값을 삽입해 Redis 메모리와 러너 슬롯을 고갈시킨다.
5. **운영 정보 수집:** runner stats/env 키에서 동시성, 실행 명령, 런타임 및 자원 정보를 읽는다.

## 해결 방법

1. 응시자 프로세스의 네트워크 네임스페이스와 runner 제어 프로세스의 네트워크를 분리한다. 응시자 명령에는 네트워크 인터페이스를 제공하지 않는 구성이 가장 안전하다.
2. Redis에 ACL을 적용하고 API와 runner에 필요한 명령·키 prefix만 허용한 서로 다른 계정을 발급한다.
3. Redis 비밀번호와 TLS를 사용하되, 이것만으로 응시자 프로세스와 runner가 환경을 공유하는 문제를 해결했다고 간주하지 않는다.
4. 큐 메시지에 서버 서명과 nonce를 넣고 runner가 유효한 작업만 소비하도록 한다.
5. 큐 payload에서 전체 파일 내용을 분리해 일회용 객체 저장소나 API fetch 방식으로 전달한다.
6. Redis 명령 감사, 비정상 키 증가, 큐 깊이 급증에 대한 경보를 추가한다.


## 조치 (2026-09-04, 완료)

- **응시자 프로세스에 네트워크가 없다:** 실행마다 `unshare --net` 으로 빈 네트워크 네임스페이스를 만들고 루프백만 올린다 (`apps/runner/sandbox.py`, `iproute2` + `NET_ADMIN`). 응시자 코드는 `redis`·`api` 호스트 이름을 풀지도, 연결하지도 못한다. 로컬 서버(`127.0.0.1`)는 여전히 띄울 수 있다.
- **Redis 인증·ACL:** `default` 사용자는 끄고 서비스별 계정만 둔다 (`docker-compose.yml`). `api` 는 전체 권한, `runner` 는 `odysseus:run:queue`·`odysseus:runner:*`·`odysseus:attempt:*` 키에 `BRPOP/LLEN/SET/HINCRBY/HINCRBYFLOAT/EXPIRE/SMEMBERS/SREM` 만 — 큐 적재(`LPUSH`), `KEYS`, `FLUSH*`, 다른 키 접근이 불가능하다. 비밀번호는 `REDIS_API_PASSWORD`/`REDIS_RUNNER_PASSWORD` 로 필수.
- **큐 작업 서명:** API 가 작업 JSON 을 `INTERNAL_TOKEN` 으로 HMAC-SHA256 서명(`sig`)하고, 러너는 서명이 맞는 작업만 실행하며 나머지는 로그를 남기고 버린다 (`runqueue.sign_job`, `worker.job_is_signed`). 실행별 콜백 토큰(ODY-002)과 합쳐, 큐에 끼워 넣은 작업으로는 실행도 결과 위조도 되지 않는다.
- **검증:** `tests/security/test_sandbox_network.py` (응시자 명령으로 redis/api/DNS 도달 실패, 루프백 정상, 인터페이스 lo 뿐) + `tests/security/test_redis_acl.py` (무인증 거부, runner 계정의 LPUSH/KEYS/FLUSHALL 거부와 BRPOP 허용, api 계정 정상) + 위조 작업 투입 시 러너가 버리는지 로그 확인.
- **미완:** 큐 payload 에서 파일 본문을 분리해 fetch 방식으로 바꾸는 것(#5)과 Redis 감사·경보(#6)는 네트워크 분리로 위험이 사라진 뒤라 우선순위를 낮춰 두었다. TLS 는 내부 브리지 망에서만 오가므로 보류.

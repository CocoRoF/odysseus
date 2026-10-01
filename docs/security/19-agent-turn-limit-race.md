# ODY-019: AI 에이전트 턴 제한 경쟁 조건

## 취약점 요약

- **심각도:** 높음
- **영향:** 설정된 AI 질문 횟수 초과, 응시자 간 불공정, LLM 비용 증가
- **원인:** 현재 사용량 COUNT와 새 user message INSERT 사이에 잠금·원자적 예약이 없다.
- **주요 근거:** `apps/api/odysseus_api/routers/agent.py:24`, `apps/api/odysseus_api/routers/agent.py:91`, `apps/api/odysseus_api/routers/agent.py:111`

## 상세

요청은 먼저 user role의 AgentMessage 수를 조회해 `agent_max_turns`와 비교한다. 통과하면 나중에 user message를 INSERT하고 commit한다. 여러 요청이 거의 동시에 COUNT를 수행하면 각각 같은 이전 사용량을 보고 모두 통과할 수 있다.

AgentMessage 테이블에는 attempt별 순번이나 quota unique constraint가 없으며 한 응시의 동시 agent 요청을 제한하는 분산 잠금도 없다. 단순 UI 버튼 비활성화는 직접 HTTP 요청을 막지 못한다.

## 재현 방법(공격 방법)

mock LLM을 연결한 별도 assessment에서 `agent_max_turns=1`로 설정하고 본인 테스트 응시에 두 요청을 동시에 보낸다.

```bash
for n in 1 2 3; do
  curl -sS -b "$COOKIE_JAR" \
    -H 'Content-Type: application/json' \
    -d '{"content":"concurrency test '"$n"'"}' \
    "$BASE_URL/attempts/$ATTEMPT_ID/scenarios/$SCENARIO_ID/agent/messages" &
done
wait
```

메시지 목록 또는 usage에서 user turn이 1보다 많으면 재현된다. 유료 실제 모델로 테스트하지 않는다.

## 공격 예시

1. **마지막 한 턴 증폭:** 잔여 1회일 때 10개의 병렬 요청을 보내 여러 응답을 받는다.
2. **다중 탭 경쟁:** 같은 계정을 여러 브라우저 탭에서 열고 동시에 전송 버튼을 눌러 quota를 초과한다.
3. **자동 재시도 결합:** 느린 SSE를 실패로 판단한 클라이언트·프록시의 재시도가 중복 유료 호출을 만든다.
4. **도구 실행 증폭:** 각 요청이 여러 agent tool iteration을 수행하도록 하여 단순 턴 수 이상의 runner/DB 비용을 소비한다.

## 해결 방법

1. Attempt 또는 별도 usage row를 `SELECT ... FOR UPDATE`로 잠근 트랜잭션에서 quota를 원자적으로 예약한다.
2. `used_turns < max_turns` 조건부 UPDATE가 성공한 요청만 모델을 호출하도록 한다.
3. attempt별 동시 agent turn을 1개로 제한하는 DB advisory lock 또는 Redis semaphore를 사용한다.
4. 요청별 idempotency key를 저장해 네트워크 재시도를 기존 결과에 연결한다.
5. 모델 호출 실패 시 quota 환불 정책을 명확히 하고 reservation 상태를 `reserved/completed/failed`로 관리한다.
6. DB가 최종 강제 지점이 되도록 순번 또는 reservation에 unique constraint를 둔다.


## 조치 (2026-09-04, 완료)

- **원자적 예약:** `send_agent_message` 가 응시 행을 `SELECT … FOR UPDATE` 로 잠근 채 COUNT → 사용자 메시지 INSERT → COMMIT 을 한다. 잠금이 풀리기 전엔 다른 요청이 같은 COUNT 를 볼 수 없어 한도를 넘는 예약이 생기지 않는다 (`routers/agent.py`).
- **동시 턴 1개:** 응시별 프로세스 내 `asyncio.Lock` 으로 진행 중인 턴이 있으면 409 로 거절하고, 스트림이 끝나면(정상·오류·연결 끊김) 풀린다. api 는 단일 인스턴스라 프로세스 잠금으로 충분하며, 다중 인스턴스가 되면 Redis 세마포어로 옮긴다.
- **기록:** `agent_turn` 이벤트에 `turn`(순번)과 `max` 를 남겨 리뷰에서 순서를 확인할 수 있다.
- **검증:** `tests/security/test_agent_turn_race.py` — 한도 3 에 10개 동시 요청: 200 은 3 이하, 나머지 409/429, 저장된 사용자 턴 ≤ 3; 순차로 채운 뒤 4번째는 429 이고 턴이 늘지 않음; usage 일치; 순번 1..N 겹침 없음.
- **미완:** 모델 호출 실패 시 환불 정책(#5)은 두지 않았다 — 실패한 턴도 소비된 것으로 본다 (응시자 화면에 오류가 표시되고 재시도는 새 턴).

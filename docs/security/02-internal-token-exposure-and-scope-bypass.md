# ODY-002: 내부 토큰 노출과 내부 도구 범위 우회

## 취약점 요약

- **심각도:** 치명적
- **영향:** 러너 결과 위조, 잠긴 시나리오 파일 변경, 내부 API 호출
- **원인:** 알려진 기본 내부 토큰, 외부 라우터에 함께 마운트된 `/internal/*`, 요청 본문의 응시·시나리오 범위 신뢰
- **주요 근거:** `apps/api/odysseus_api/config.py:10`, `docker-compose.yml:50`, `apps/api/odysseus_api/main.py:78`, `apps/api/odysseus_api/routers/internal.py:30`

## 상세

내부 API는 `X-Internal-Token` 하나만 검사한다. 기본값 `odysseus-internal-change-me`가 코드와 Compose에 공개되어 있고, API 컨테이너는 호스트의 8100 포트와 Edge의 `/api` 프록시 양쪽에서 접근 가능하다.

`/internal/agent-tool`은 본문에서 받은 `attempt_id`와 `scenario_id`를 각각 존재 여부만 확인한다. 시나리오가 해당 시험에 속하는지, 현재 잠금이 풀렸는지, 호출자가 누구인지는 확인하지 않는다. `/internal/executions/{id}/result`도 토큰만 맞으면 러너가 보낸 것처럼 결과와 변경 파일을 받아들인다.

## 재현 방법(공격 방법)

반드시 본인 로컬 테스트 응시와 기본 토큰을 사용하는 격리 환경에서만 수행한다.

```bash
curl -i \
  -H 'X-Internal-Token: odysseus-internal-change-me' \
  http://localhost:3100/api/internal/agent-tools
```

200 응답으로 도구 목록이 반환되면 외부 경로에서 내부 인증이 깨진 것이다. 범위 우회 검증은 테스트 응시의 UUID만 사용해 `read_file` 같은 비파괴 도구로 확인한다.

```bash
curl -sS -H 'Content-Type: application/json' \
  -H 'X-Internal-Token: odysseus-internal-change-me' \
  -d '{"attempt_id":"'"$ATTEMPT_ID"'","scenario_id":"'"$SCENARIO_ID"'","name":"list_files","input":{}}' \
  "$BASE_URL/internal/agent-tool"
```

## 공격 예시

1. **잠긴 문제 선행 수정:** 응시자가 다음 시나리오 UUID를 지정해 `write_file`을 호출하여 순차 진행 규칙을 우회한다.
2. **실행 성공 위조:** 본인 실행 API 응답에서 얻은 execution UUID로 내부 result 콜백을 호출해 `exit_code=0`과 조작된 `changed_files`를 제출한다.
3. **다른 응시 오염:** 로그나 다른 취약점으로 타인의 attempt UUID를 얻은 공격자가 그 응시의 워크스페이스 파일을 읽거나 수정한다.
4. **서비스 상태 교란:** queued 실행을 임의로 running/done 상태로 바꾸어 UI와 실제 러너 상태를 불일치시킨다.

## 해결 방법

1. `/internal/*`를 Edge와 호스트 포트에서 라우팅하지 말고 전용 내부 네트워크 리스너로 분리한다.
2. 알려진 기본 토큰을 제거하고 시작 시 충분히 긴 무작위 토큰이 없으면 실패하도록 한다.
3. 단일 공유 토큰 대신 서비스 신원별 mTLS 또는 짧은 수명의 서명된 서비스 토큰을 사용한다.
4. agent-tool에서 assessment-scenario 소속, 현재 ordinal, 활성 응시 상태를 다시 검증한다.
5. 실행 결과 콜백은 execution별 일회용 nonce와 작업 payload 해시를 검증하고 한 번만 소비한다.
6. 토큰 비교·실패·내부 호출을 구조화 감사 로그로 남기되 토큰 값은 절대 기록하지 않는다.


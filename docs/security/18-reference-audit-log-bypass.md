# ODY-018: 참고자료 감사 로그 우회

## 취약점 요약

- **심각도:** 높음
- **영향:** 응시자의 웹·GitHub 참고 활동이 평가 로그에서 사라짐, 시험 외 시간에도 서버 프록시 사용
- **원인:** attempt/scenario 문맥이 선택 사항이고 `_log()`가 누락·오류 문맥을 거부하지 않고 조용히 무시한다.
- **주요 근거:** `apps/api/odysseus_api/routers/reference.py:119`, `apps/api/odysseus_api/routers/reference.py:209`, `apps/api/odysseus_api/routers/reference.py:501`, `apps/api/odysseus_api/routers/reference.py:622`

## 상세

정상 UI는 reference search/render 요청에 attempt_id와 scenario_id를 붙인다. 하지만 서버 endpoint에서 이 값은 선택 사항이다. `_log()`는 attempt_id가 없거나, 사용자 소유가 아니거나, in_progress가 아니면 예외를 내지 않고 반환한다. 외부 조회 자체는 그대로 수행된다.

GitHub tree와 file endpoint는 attempt/scenario 인자와 `_log()` 호출 자체가 없다. 외부 HTTP 오류가 발생하면 웹 요청 로그도 성공 후에만 기록하므로 실패한 내부 탐색·SSRF 시도 또한 감사 로그에 남지 않는다.

## 재현 방법(공격 방법)

정상 UI 요청과 attempt 파라미터를 제거한 요청을 본인 테스트 응시에서 비교한다.

```bash
curl -sS -b "$COOKIE_JAR" --get \
  --data-urlencode 'q=python csv writer' \
  "$BASE_URL/reference/web/search"
```

검색 결과는 반환되지만 리뷰 이벤트에 `reference_search`가 추가되지 않으면 재현된다. GitHub file 조회도 같은 방식으로 확인한다.

## 공격 예시

1. **파라미터 제거:** DevTools의 “Copy as cURL” 결과에서 `attempt_id`와 `scenario_id`를 제거해 기록 없는 웹 검색을 수행한다.
2. **무효 ID 사용:** 존재하지 않는 attempt UUID를 보내 `_log()`가 조용히 반환하게 하고 검색 결과는 그대로 받는다.
3. **GitHub file 직접 호출:** UI 탐색 단계를 건너뛰고 `/reference/github/file`을 호출해 코드 내용을 감사 로그 없이 읽는다.
4. **시험 종료 후 사용:** 로그인 JWT가 남아 있는 동안 active attempt 없이 reference proxy를 계속 사용한다.
5. **실패 시도 은폐:** 연결 실패·redirect 실패가 발생하도록 여러 URL을 탐색해 성공 후 `_log()`까지 도달하지 않게 한다.

## 해결 방법

1. candidate 역할의 reference endpoint에는 active attempt_id와 해당 attempt의 현재 scenario_id를 필수화한다.
2. staff용 일반 조회가 필요하면 별도 route와 별도 감사 정책으로 분리한다.
3. 외부 요청 전에 `reference_request_started`를 기록하고 완료 후 status, 최종 host, byte 수를 update 또는 별도 이벤트로 기록한다.
4. GitHub search/repo/tree/file 및 web search/page/render에 동일한 guard와 logger를 적용한다.
5. 잘못된 감사 문맥은 무시하지 말고 400/403으로 거부한다.
6. 평가 정책이 웹 허용 여부를 시험별로 다르게 요구한다면 전역 setting이 아니라 assessment별 allowlist/policy를 사용한다.


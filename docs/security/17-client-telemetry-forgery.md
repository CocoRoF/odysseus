# ODY-017: 클라이언트 행동 로그 위조·누락

## 취약점 요약

- **심각도:** 높음
- **영향:** 부정행위 판단 근거 오염, 화면 이탈·붙여넣기 은폐, 무고한 이벤트 생성
- **원인:** 적대적으로 제어 가능한 브라우저가 행동 이벤트의 종류·scenario·payload를 스스로 보고하며 서버가 이를 사실로 저장한다.
- **주요 근거:** `apps/web/app/exam/[attemptId]/page.tsx:93`, `apps/api/odysseus_api/schemas.py:240`, `apps/api/odysseus_api/routers/attempts.py:355`

## 상세

시험 페이지 JavaScript는 focus, visibility, clipboard, network 이벤트를 모아 `/attempts/{id}/events`로 보낸다. 그러나 응시자는 DevTools, 브라우저 확장, 로컬 프록시 또는 별도 HTTP 클라이언트로 코드를 중단하거나 요청을 수정할 수 있다.

서버는 event type이 화이트리스트에 있는지만 확인한다. `payload`는 임의 dictionary이고 `scenario_id`가 현재 attempt에 속하는지 확인하지 않는다. Event 모델의 scenario_id에도 Scenario foreign key가 없다. 서버 시각으로 created_at이 찍히더라도 그 시각에 실제 focus loss나 paste가 발생했다는 사실은 증명하지 못한다.

## 재현 방법(공격 방법)

본인 테스트 응시에서만 수행한다.

```bash
curl -sS -b "$COOKIE_JAR" \
  -H 'Content-Type: application/json' \
  -d '{"events":[{"type":"focus_gained","scenario_id":"'"$SCENARIO_ID"'","payload":{"note":"synthetic-test"}}]}' \
  "$BASE_URL/attempts/$ATTEMPT_ID/events"
```

리뷰 이벤트에 실제 focus 변화 없이 `focus_gained`가 나타나면 위조가 확인된다. DevTools에서 해당 endpoint를 Request blocking한 뒤 실제 탭 전환이 기록되지 않는지도 테스트할 수 있다.

## 공격 예시

1. **이탈 이벤트 누락:** `/events` 요청을 차단하거나 activity tracker JavaScript를 비활성화한 상태로 다른 탭을 사용한다.
2. **정상 이벤트 덮기:** 다수의 `focus_gained`, `tab_visible` 이벤트를 보내 의심스러운 이벤트를 긴 목록 속에 묻는다.
3. **payload 조작:** `away_ms`를 0 또는 매우 작은 값으로 보내 실제 이탈 시간을 축소한다.
4. **시나리오 오연결:** 임의 또는 다른 문제의 UUID를 사용해 이벤트가 현재 문제와 관계없는 것처럼 기록되게 한다.
5. **허위 paste 생성:** 계정 공유나 분쟁 상황에서 본인 응시에 paste 이벤트를 만들어 로그의 증거 가치를 훼손한다.

## 해결 방법

1. 클라이언트 이벤트를 `source=client_untrusted`로 명확히 표시하고 징계·실격의 단독 근거로 사용하지 않는다.
2. 파일 저장, 실행, 메시지, 참고자료, 제출은 서버 관측 이벤트만 권위 있는 감사 로그로 사용한다.
3. scenario가 attempt에 포함되고 현재 접근 가능한지 검증한다.
4. 이벤트 종류별 Pydantic payload schema, 크기 제한, 순서 번호, idempotency ID를 적용한다.
5. 누락·재생을 탐지하려면 서버 nonce heartbeat와 monotonic sequence를 사용할 수 있지만, 이것도 focus 상태의 진실성을 보장하지는 못한다.
6. 강한 감독이 필수라면 통제된 kiosk/감독 클라이언트 등 별도 신뢰 경계를 사용하고 개인정보·법적 요건을 검토한다.


## 조치 (2026-09-04, 완료)

- **출처 분리:** `events.source` 컬럼을 추가했다. 서버가 직접 관측한 사실(파일·실행·대화·참고자료·제출·마감·평가)은 `server`, 브라우저가 보고한 행동(포커스·탭·복사·페이지 진입/이탈·네트워크)은 `client_untrusted` 로 저장된다 (`models.Event`, `routers/attempts.post_events`). 리뷰 API 가 출처를 내보내고 리뷰 화면은 브라우저 보고 이벤트에 "브라우저 보고" 배지를 단다.
- **위조 차단:** 클라이언트 종류 화이트리스트에서 `reference_search`/`reference_open` 을 뺐다 — 참고자료 조회는 서버(`reference.py`)만 기록한다. `scenario_id` 는 그 시험에 속한 것만 받고, payload 는 허용 키(`away_ms, chars, text, app, path, page, reason, seq, client_id`)·문자열 500자로 정제한다.
- **순서·중복:** 클라이언트가 `seq`(세션 저장소에 이어짐)와 `client_id` 를 붙인다. 서버는 Redis 에 마지막 seq 를 두고 같은/과거 seq 는 버리며, 건너뛴 구간은 `telemetry_gap`(server) 이벤트로 남긴다. seq 없는 구버전은 그대로 받는다.
- **평가기:** 자동평가 입력에서 화면 이탈 수를 `behavior_client_reported_untrusted` 로 이름 붙이고, 서버 메모로 "부정 신호의 단독 근거로 삼지 말라" 고 지시한다.
- **검증:** `tests/security/test_telemetry.py` — 출처 표시(server/client_untrusted), 참고자료·서버 전용 종류·시험 밖 시나리오 버림, payload 키·길이 정제, seq 중복/재생 버림·gap 기록, 리뷰 API 의 source 필드.
- **한계(문서 #5·#6):** seq 는 누락·재생을 드러낼 뿐 포커스 상태의 진실성은 보장하지 못한다. 강한 감독이 필요하면 별도 감독 클라이언트가 필요하다 — 제품 범위 밖.

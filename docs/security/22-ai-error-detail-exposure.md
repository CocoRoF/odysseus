# ODY-022: AI 내부 오류 상세 노출

## 취약점 요약

- **심각도:** 중간
- **영향:** 내부 endpoint·파일 경로·공급자 진단 정보 노출, 후속 공격 정찰
- **원인:** 예외의 `str(e)`를 정제하지 않고 응시자 SSE와 저장된 message metadata에 반환한다.
- **주요 근거:** `apps/api/odysseus_api/routers/agent.py:127`, `apps/api/odysseus_api/routers/agent.py:161`, `apps/api/odysseus_api/schemas.py:274`

## 상세

에이전트 실행 중 발생하는 모든 Exception은 `str(e)[:600]`으로 변환되어 SSE `error` 이벤트에 포함된다. 동일한 문자열은 assistant AgentMessage의 `meta.error`에 저장되고 메시지 목록 endpoint가 `meta` 전체를 응시자에게 반환한다.

예외 문자열은 사용한 SDK에 따라 base URL, 모델명, 내부 hostname, 파일 경로, subprocess 명령, upstream 응답 일부를 포함할 수 있다. API key가 반드시 포함된다고 단정할 수는 없지만, 어떤 라이브러리가 어떤 내용을 문자열화하는지 중앙에서 통제하지 않으므로 비밀 누출 가능성을 배제할 수 없다.

## 재현 방법(공격 방법)

mock LLM 공급자가 `TEST_INTERNAL_ENDPOINT=http://ai-internal.test/v1`을 포함한 테스트 예외를 던지도록 설정한다.

1. 본인 테스트 응시에서 agent message를 보낸다.
2. SSE의 `data: {"error": ...}`에 marker가 나타나는지 확인한다.
3. 이후 GET message 목록의 `meta.error`에도 marker가 남는지 확인한다.
4. 실제 API key나 운영 endpoint를 marker로 사용하지 않는다.

## 공격 예시

1. **잘못된 tool 입력 반복:** 모델이 도구 오류를 내도록 경계 입력을 보내 내부 validation·경로 정보를 수집한다.
2. **공급자 연결 오류 유도:** 특정 크기·timeout의 요청으로 HTTP client 예외를 발생시켜 내부 base URL이나 DNS 이름을 확인한다.
3. **CLI 오류 유도:** Claude CLI backend에서 처리하지 못하는 입력을 보내 임시 workspace나 executable 경로가 포함된 오류를 얻는다.
4. **영구 조회:** 일시적으로 노출된 상세 오류를 message history의 `meta`에서 반복 열람한다.

## 해결 방법

1. 응시자에게는 `AI_BACKEND_ERROR` 같은 안정된 오류 코드, 일반 설명, correlation ID만 반환한다.
2. 상세 stack trace와 예외는 서버 로그에만 남기고 URL userinfo/query, Authorization, API key, header를 중앙 redaction한다.
3. `AgentMessageOut`에서 `meta`를 제거하거나 사용자 공개용 allowlist 필드만 별도 schema로 반환한다.
4. DB에 저장하는 error도 정제된 code로 제한하고 원본 진단은 보존 기간이 짧은 접근 통제 로그에 둔다.
5. 대표 SDK 예외를 테스트해 public response에 내부 host·path·credential이 포함되지 않는지 회귀 검사한다.
6. 같은 correlation ID의 반복 오류에 rate limit을 적용해 정찰 자동화를 줄인다.


## 조치 (2026-09-04, 완료)

- **중앙 정제:** `ai/errors.py` 의 `describe_error()` 가 예외를 안정된 코드(`AI_TIMEOUT`·`AI_RATE_LIMIT`·`AI_AUTH`·`AI_UNAVAILABLE`·`AI_BAD_RESPONSE`·`AI_BACKEND_ERROR`)로 분류하고, 응시자에게는 코드·일반 설명·상관 ID 만 준다. 상세는 서버 로그에 `redact()`(API 키·Bearer·key=/token=·URL userinfo·쿼리 마스킹)를 거쳐 남긴다.
- **적용:** 에이전트 SSE `error` 이벤트와 저장 `meta.error`(코드만), 메신저 NPC 오류 meta, 스튜디오 author/stream 오류(참조 ID), 관리자 연결 테스트·자동평가 503 은 관리자 대상이라 상세를 주되 키·토큰·쿼리는 가린다.
- **메시지 목록:** `AgentMessageOut.meta` 는 `public_meta()` 로 도구 이름/짧은 detail·오류 코드·상관 ID 만 내보낸다.
- **검증:** `tests/security/test_error_redaction.py` — 닿지 않는 공급자(비밀 호스트·키)로 에이전트/메신저/스튜디오/연결 테스트를 일으켜 SSE·저장 meta·응답에 호스트·키·경로·Traceback 이 없고 코드·상관 ID 가 있음을 확인.
- **미완:** 같은 상관 ID 반복 오류의 속도 제한(#6)은 ODY-010 의 에이전트/메신저 한도가 대신한다.

# Odysseus 보안 점검 문서

이 디렉터리는 코드 정적 분석에서 확인한 보안 문제를 취약점별로 정리한다. 각 문서는 취약점 요약, 상세 원인, 격리 환경에서의 재현 방법, 공격 예시 3개 이상, 해결 방법을 포함한다.

> **안전 원칙:** 재현 절차는 이 저장소를 별도로 실행한 로컬 테스트 환경과 본인이 만든 테스트 계정·응시 데이터에만 사용한다. 운영 서버, 실제 시험, 타인 계정 또는 외부 시스템을 대상으로 실행하지 않는다. Redis 큐 변경, 대량 병렬 요청, 특수 파일 생성, 메모리 고갈 예시는 서비스 중단을 유발할 수 있으므로 전용 테스트 인스턴스에서만 수행한다.

## 공통 테스트 변수

예시에서는 다음 값을 사용한다.

```bash
export BASE_URL="http://localhost:3100/api"
export COOKIE_JAR="/tmp/odysseus-security-cookie.txt"
export ATTEMPT_ID="본인-테스트-응시-UUID"
export SCENARIO_ID="현재-테스트-시나리오-UUID"
```

로그인 예시:

```bash
curl -sS -c "$COOKIE_JAR" \
  -H 'Content-Type: application/json' \
  -d '{"email":"candidate@odysseus.dev","password":"cand1234"}' \
  "$BASE_URL/auth/login"
```

## 문서 목록

| ID | 심각도 | 문제 |
|---|---|---|
| ODY-001 | 치명적 | [기본 데모 관리자 계정 자동 생성](01-default-demo-credentials.md) |
| ODY-002 | 치명적 | [내부 토큰 노출과 내부 도구 범위 우회](02-internal-token-exposure-and-scope-bypass.md) |
| ODY-003 | 치명적 | [인증 없는 Redis에 응시자 코드가 접근](03-unauthenticated-redis-access.md) |
| ODY-004 | 높음 | [러너 변경 수집기의 심볼릭 링크·특수 파일 처리](04-runner-output-file-special-file-abuse.md) |
| ODY-005 | 높음 | [러너 stdout/stderr 무제한 메모리 수집](05-runner-unbounded-output-memory.md) |
| ODY-006 | 높음 | [웹 참고자료 프록시 SSRF](06-reference-proxy-ssrf.md) |
| ODY-007 | 높음 | [마감·제출 이후 결과 변경 가능성](07-post-deadline-and-post-submit-mutation.md) |
| ODY-008 | 높음 | [NPC를 통한 숨은 목표 추출](08-npc-hidden-objective-extraction.md) |
| ODY-009 | 높음 | [LLM 자동평가 프롬프트 인젝션](09-llm-autoevaluation-prompt-injection.md) |
| ODY-010 | 높음 | [요청 속도·동시성·비용 제한 부족](10-missing-rate-and-concurrency-limits.md) |
| ODY-011 | 조건부 높음 | [공용 GitHub 토큰을 통한 비공개 저장소 노출](11-github-token-private-repository-exposure.md) |
| ODY-012 | 높음 | [취약한 xlsx 0.18.5 의존성](12-vulnerable-xlsx-dependency.md) |
| ODY-013 | 높음 | [잠금 없는 의존성과 원격 latest 설치](13-unpinned-build-and-remote-installer.md) |
| ODY-014 | 높음 | [평문 HTTP와 Secure 없는 세션 쿠키](14-plaintext-http-and-insecure-session-cookie.md) |
| ODY-015 | 중간 | [응시 생성 경쟁 조건](15-attempt-creation-race.md) |
| ODY-016 | 높음 | [평문 비밀이 포함된 보호되지 않은 백업](16-unprotected-plaintext-backups.md) |
| ODY-017 | 높음 | [클라이언트 행동 로그 위조·누락](17-client-telemetry-forgery.md) |
| ODY-018 | 높음 | [참고자료 감사 로그 우회](18-reference-audit-log-bypass.md) |
| ODY-019 | 높음 | [AI 에이전트 턴 제한 경쟁 조건](19-agent-turn-limit-race.md) |
| ODY-020 | 중간 | [쿼리스트링과 서명 자산 URL 노출](20-query-string-and-signed-asset-leak.md) |
| ODY-021 | 중간 | [응시자 명령을 이용한 러너 로그 인젝션](21-runner-log-injection.md) |
| ODY-022 | 중간 | [AI 내부 오류 상세 노출](22-ai-error-detail-exposure.md) |
| ODY-023 | 중간 | [로그아웃 후 JWT 재사용과 브라우저 잔존 데이터](23-jwt-logout-replay-and-client-cache.md) |
| ODY-024 | 조건부 중간 | [보안 헤더·클릭재킹·CSRF 방어 부족](24-missing-security-headers-and-csrf.md) |

## 권장 조치 순서

1. 기본 자격증명, 내부 토큰, Redis 네트워크 경계를 즉시 수정한다.
2. 러너 특수 파일·출력 상한과 SSRF를 차단한다.
3. 제출 시점 스냅샷과 원자적 사용량/응시 생성을 적용한다.
4. 클라이언트 행동 로그를 신뢰할 수 없는 보조 신호로 재분류한다.
5. 의존성, TLS, 백업, 로그 및 브라우저 보안 정책을 강화한다.


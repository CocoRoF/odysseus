# ODY-010: 요청 속도·동시성·비용 제한 부족

## 취약점 요약

- **심각도:** 높음
- **영향:** 로그인 brute force, 외부 API/LLM 비용 증가, DB·API·runner 서비스 거부
- **원인:** Edge와 주요 API에 사용자/IP별 rate limit, 동시 요청 제한, 전역 비용 예산이 없다.
- **주요 근거:** `apps/edge/nginx.conf:9`, `apps/api/odysseus_api/main.py:55`, `apps/api/odysseus_api/routers/messenger.py:54`

## 상세

Nginx에는 `limit_req`나 `limit_conn` 설정이 없고 FastAPI에도 rate-limit middleware가 없다. 로그인, 검색, 페이지 렌더, 메신저, 실행 생성 같은 비용이 큰 endpoint를 인증 전 또는 일반 응시자 권한으로 반복 호출할 수 있다.

개별 body 길이와 명령 timeout은 일부 제한하지만 요청 횟수와 병렬성은 제한하지 않는다. 외부 검색 API, GitHub, LLM, runner 큐 등 서로 다른 자원이 한 응시자의 요청 폭주에 영향을 받는다.

## 재현 방법(공격 방법)

전용 스택에서 낮은 동시성으로만 확인한다. 다음은 10개의 건강검사 요청 예이며 운영 환경 부하 시험으로 사용하지 않는다.

```bash
seq 1 10 | xargs -n1 -P5 -I{} \
  curl -sS -o /dev/null -w '%{http_code}\n' http://localhost:3100/api/healthz
```

모든 요청이 지연·429 없이 처리되고 access log에도 제한 이벤트가 없다면 기본 rate limit이 없는 것이다. 로그인이나 LLM endpoint 부하 검증은 mock 공급자를 사용한다.

## 공격 예시

1. **비밀번호 대입:** `/auth/login`에 한 이메일과 다수 비밀번호를 빠르게 전송해 계정 비밀번호를 추측한다.
2. **LLM 비용 소진:** 메신저 캐릭터 여러 명에게 병렬 메시지를 보내 유료 모델 호출과 token 사용량을 증가시킨다.
3. **웹 검색 쿼터 소진:** 서로 다른 검색어로 캐시를 회피하면서 Google/DDG/GitHub API 호출 제한을 소모한다.
4. **runner 큐 포화:** 짧지만 오래 실행되는 명령을 반복 등록해 다른 응시자의 작업을 대기시킨다.
5. **렌더링 자원 고갈:** 서로 다른 URL을 병렬로 열어 DNS, HTTP connection pool, HTML/CSS parsing 자원을 점유한다.

## 해결 방법

1. Edge에서 IP·계정별 `limit_req`와 `limit_conn`을 적용하고 endpoint 비용에 따라 별도 zone을 둔다.
2. 로그인에 지수 backoff, 계정·IP 조합 제한, 실패 경보를 적용한다.
3. 응시별로 실행/LLM/외부 fetch 동시성을 제한하고 분산 semaphore를 사용한다.
4. 모델 token, 호출 횟수, 검색 API 요청 수, runner CPU-seconds에 assessment별 예산을 둔다.
5. 캐시 miss 기준으로 외부 호출 quota를 차감하며 요청 취소·disconnect 시에도 비용을 추적한다.
6. 429 응답에 `Retry-After`를 포함하고 운영 대시보드에 사용자별 소비량과 이상치를 노출한다.


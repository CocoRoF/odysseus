# ODY-020: 쿼리스트링과 서명 자산 URL 노출

## 취약점 요약

- **심각도:** 중간
- **영향:** 검색어·열람 URL·presigned query 유출, 자산 프록시 URL 재사용, 익명 bandwidth 악용
- **원인:** 민감할 수 있는 URL과 서명 token을 GET query에 넣고 자산 endpoint는 쿠키 인증 없이 6시간 서명만 신뢰한다.
- **주요 근거:** `apps/web/components/desktop/apps/BrowserApp.tsx:89`, `apps/api/odysseus_api/web_render.py:34`, `apps/api/odysseus_api/web_render.py:70`, `apps/api/odysseus_api/routers/reference.py:686`

## 상세

검색어는 `q=`, 페이지 주소는 `url=`, 자산 프록시는 `u`, `exp`, `sig` query parameter를 사용한다. `u`는 URL-safe Base64일 뿐 암호화가 아니어서 원래 upstream URL을 복원할 수 있다.

Nginx/Uvicorn의 일반적인 access log는 request target 전체를 기록한다. 브라우저 Network export, 프록시 로그, 관측 도구, 오류 보고서에도 query가 포함될 수 있다. 자산 endpoint는 sandbox iframe을 위해 로그인 쿠키를 요구하지 않으므로 유효한 전체 URL을 얻은 사람은 최대 6시간 재생할 수 있다.

## 재현 방법(공격 방법)

가짜 query secret만 사용한다.

1. 테스트 페이지 URL을 `https://example.test/image.png?token=TEST_ONLY`로 구성한다.
2. render 응답 또는 DevTools Network에서 `/reference/web/asset?u=...&exp=...&sig=...`를 찾는다.
3. `u`를 Base64 URL decoding해 `TEST_ONLY`가 복원되는지 확인한다.
4. 로그아웃한 새 curl 요청으로 전체 asset URL을 호출해 동일 자산이 반환되는지 확인한다.

실제 presigned URL이나 외부 비밀을 재현에 사용하지 않는다.

## 공격 예시

1. **access log 유출:** 응시자가 query token이 포함된 URL을 열어 로그 접근 권한이 있는 운영자·수집 시스템에 원본 token을 남긴다.
2. **HAR 파일 유출:** 지원 요청에 첨부한 브라우저 HAR에 서명 자산 URL과 검색어, attempt/scenario UUID가 포함된다.
3. **서명 URL 공유:** 응시자가 Network 탭에서 자산 URL을 복사해 비로그인 사용자에게 전달하고 만료까지 플랫폼 프록시를 사용하게 한다.
4. **분석 서비스 전파:** request URL을 수집하는 APM/SIEM이 query 전체를 외부 SaaS로 전송한다.
5. **검색어 개인정보 노출:** 응시자가 검색창에 고객명·이메일·사내 식별자를 입력해 접근 로그와 Event payload 양쪽에 남긴다.

## 해결 방법

1. 원본 URL은 서버 측 임시 레코드에 저장하고 브라우저에는 짧은 불투명 asset ID만 반환한다.
2. 서명 자산 TTL을 수분 단위로 줄이고 가능하면 세션/attempt에 binding한다.
3. Edge, API, APM에서 `q`, `url`, `u`, `sig`, token류 query를 allowlist 방식으로 제거한다.
4. credentials 또는 민감 query parameter가 포함된 upstream URL을 거부하거나 명시적으로 정규화한다.
5. 검색·열람 Event에는 전체 값 대신 분류, 허용된 host, salted hash 등 평가에 필요한 최소 정보만 저장한다.
6. 지원용 HAR 수집 전에 Cookie, Authorization, query token을 자동 마스킹하는 절차를 제공한다.


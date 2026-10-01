# ODY-014: 평문 HTTP와 Secure 없는 세션 쿠키

## 취약점 요약

- **심각도:** 높음
- **영향:** 로그인 비밀번호·JWT 탈취, 응시 세션 가로채기, 요청·응답 변조
- **원인:** Edge가 HTTP 80만 제공하고 세션 쿠키에 `Secure`가 없다.
- **주요 근거:** `apps/edge/nginx.conf:9`, `docker-compose.yml:119`, `apps/api/odysseus_api/routers/auth.py:20`

## 상세

기본 배포는 `3100:80`의 평문 HTTP다. 로그인 요청 본문과 이후 `odysseus_token` 쿠키가 암호화되지 않은 네트워크를 통과한다. 쿠키에는 `HttpOnly`와 `SameSite=Lax`가 있지만 `Secure`가 없어 브라우저가 HTTP로도 전송한다.

외부 TLS terminator가 실제 운영에서 사용될 수 있지만 저장소 구성만으로는 강제되지 않으며 HSTS도 없다. TLS가 선택 사항이면 잘못된 배포, 초기 HTTP 접속, 프록시 설정 오류에서 자격증명이 노출된다.

## 재현 방법(공격 방법)

본인 로컬 계정에서만 요청 헤더를 확인한다.

```bash
curl -i \
  -H 'Content-Type: application/json' \
  -d '{"email":"candidate@odysseus.dev","password":"cand1234"}' \
  http://localhost:3100/api/auth/login
```

`Set-Cookie`에 `HttpOnly; SameSite=lax`는 있지만 `Secure`가 없고 서비스가 HTTP로 정상 동작하면 재현된다. 패킷 캡처는 본인 loopback 인터페이스와 테스트 자격증명에만 사용한다.

## 공격 예시

1. **같은 네트워크에서 수동 도청:** 시험장 Wi-Fi 또는 잘못 구성된 스위치에서 로그인 JSON과 Cookie 헤더를 수집한다.
2. **JWT 재전송:** 캡처한 `odysseus_token`을 Cookie 또는 Authorization Bearer로 보내 피해자의 세션을 재사용한다.
3. **활성 MITM:** HTTP 응답의 JavaScript를 변조해 응시 답안, 입력 내용 또는 추가 credential을 외부로 전송한다.
4. **다운그레이드:** 운영 앞단에 HTTPS가 있어도 HTTP가 열려 있고 HSTS가 없으면 사용자를 평문 주소로 유도한다.

## 해결 방법

1. 운영 Edge에서 TLS 1.2/1.3을 강제하고 HTTP는 동일 host의 HTTPS로만 redirect한다.
2. 세션 쿠키에 `secure=True`, `httponly=True`, 적절한 `SameSite`를 적용한다.
3. 충분한 검증 기간 후 `Strict-Transport-Security`와 `includeSubDomains` 정책을 배포한다.
4. 애플리케이션이 production 모드인데 forwarded scheme이 HTTPS가 아니면 로그인과 mutation을 거부한다.
5. 신뢰할 reverse proxy 목록을 설정해 임의 `X-Forwarded-Proto` 위조를 막는다.
6. 평문 환경에서 발급된 기존 JWT와 기본 계정 비밀번호를 폐기·교체한다.


## 조치 (2026-09-04, 완료)

- **세션 쿠키:** `odysseus_token` 에 `Secure` 를 붙인다 (`cookie_secure`, 운영 모드 기본 on·개발 off). `HttpOnly`·`SameSite=Lax` 는 그대로 (`routers/auth.py`, `config.py`).
- **HTTPS 강제:** 운영 모드의 api 미들웨어가 프록시를 거쳐 온 변경 요청(POST/PUT/PATCH/DELETE)에 `X-Forwarded-Proto: https` 가 없으면 403 으로 거부한다 (`main.require_https_behind_proxy`). 프록시 흔적이 없는 직접 호출(러너·MCP 브리지·배포 스크립트)은 대상이 아니다.
- **실제 스킴 판정:** 엣지는 임의의 `X-Forwarded-Proto` 를 믿지 않는다. Cloudflare 뒤에서는 `CF-Visitor` 의 scheme, 아니면 자기 리스너의 스킴으로 `$effective_proto` 를 정해 업스트림에 넘긴다 (`apps/edge/templates/default.conf.template`).
- **리다이렉트·HSTS:** `EDGE_HTTPS_ONLY=on`(운영 .env)이면 평문 요청을 같은 호스트의 HTTPS 로 301 하고, HTTPS 로 온 응답에만 `Strict-Transport-Security: max-age=31536000; includeSubDomains` 를 단다. 개발(off)에서는 둘 다 꺼진다. 엣지 설정은 nginx 공식 이미지의 envsubst 템플릿으로 바뀌었다 (`NGINX_ENVSUBST_FILTER=^EDGE_`).
- **운영 배치:** TLS 종단은 Cloudflare 터널(브라우저↔Cloudflare HTTPS)이 하고, 터널→엣지 구간은 미니PC 로컬 루프백이다. 운영 `.env` 에 `EDGE_HTTPS_ONLY=on` 을 넣었다.
- **검증:** `tests/security/test_tls_cookie.py` — 운영 모드 스택: 평문(프록시 경유) 로그인 403, CF-Visitor https 로그인 200 + `Secure; HttpOnly; SameSite=lax`, https 응답에 HSTS·http 응답에 없음, `EDGE_HTTPS_ONLY=on` 평문 GET 은 301 https, api 직접 호출은 영향 없음. 개발 모드 스택: Secure 없음·403 없음·리다이렉트 없음.
- **미완:** 평문 시절 발급된 JWT 폐기(#6)는 ODY-023 의 세션 폐기 메커니즘과 함께 처리한다 (운영 비밀번호는 ODY-001 에서 이미 교체).

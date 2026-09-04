# ODY-024: 보안 헤더·클릭재킹·CSRF 방어 부족

## 취약점 요약

- **심각도:** 조건부 중간
- **영향:** 같은 site의 침해된 sibling origin을 통한 클릭재킹·상태 변경, 향후 XSS 영향 확대
- **성립 조건:** 공격자가 같은 registrable domain의 다른 origin을 제어하거나 배포의 SameSite/CORS/TLS 경계가 약한 경우
- **원인:** 메인 UI에 `frame-ancestors`/X-Frame-Options가 없고 mutation에 CSRF token이나 Origin 검사가 없다.
- **주요 근거:** `apps/web/next.config.ts:5`, `apps/api/odysseus_api/main.py:55`, `apps/edge/nginx.conf:9`, `apps/api/odysseus_api/routers/attempts.py:418`

## 상세

외부 HTML은 `sandbox="allow-scripts"` iframe과 정제기를 사용하므로 현재 검토에서는 직접 실행 가능한 XSS를 확인하지 못했다. 그러나 메인 시험 UI와 API 응답에는 전역 CSP, `frame-ancestors`, X-Frame-Options, Referrer-Policy, Permissions-Policy, HSTS가 설정되지 않았다.

세션 cookie의 `SameSite=Lax`는 일반적인 cross-site POST를 상당 부분 막지만 동일 site의 다른 subdomain은 same-site로 취급될 수 있다. 그 origin이 침해되면 UI를 iframe에 넣는 클릭재킹이나 body 없는 `/finish`, `/complete` 요청을 통한 CSRF가 가능하다. CORS는 응답 읽기를 막을 뿐 simple request 전송 자체를 CSRF 방어로 보장하지 않는다.

## 재현 방법(공격 방법)

운영 도메인이 아닌 로컬 테스트용 두 hostname을 사용한다. 예: `exam.test`, `sibling.exam.test`.

1. 시험 응답 헤더에 CSP `frame-ancestors`와 X-Frame-Options가 없는지 확인한다.
2. sibling test page에 `<iframe src="http://exam.test:3100/exam/...">`을 두고 로그인 화면/시험 UI가 frame되는지 확인한다.
3. 본인 테스트 attempt의 finish endpoint에 Origin이 다른 simple POST를 보내 Origin/CSRF token 없이 처리되는지 확인한다.

```bash
curl -I http://localhost:3100/
curl -I http://localhost:3100/api/auth/me
```

실제 사용자에게 클릭하게 하거나 타인 attempt를 제출하지 않는다.

## 공격 예시

1. **투명 iframe 클릭재킹:** 같은 site의 침해된 앱이 시험 UI 위에 가짜 버튼을 배치해 사용자가 “다음” 또는 “제출”을 누르게 한다.
2. **자동 form 제출:** 공격 페이지가 알고 있는 attempt UUID의 body 없는 `/finish` POST를 전송해 시험을 조기 제출시킨다.
3. **로그아웃 CSRF:** sibling origin이 `/auth/logout` POST를 보내 시험 도중 사용자를 로그아웃시켜 업무를 방해한다.
4. **향후 XSS 확대:** 새 UI 기능에 injection이 생겼을 때 전역 CSP가 없어 외부 script/connect를 추가 방어하지 못한다.
5. **referrer 정보 노출:** 일반 외부 링크가 추가될 경우 전역 Referrer-Policy 부재로 시험 경로와 UUID가 전송될 수 있다.

## 해결 방법

1. 메인 UI에 `Content-Security-Policy: frame-ancestors 'none'`을 설정하고 호환성을 위해 `X-Frame-Options: DENY`도 적용한다.
2. mutation 요청에 synchronizer token 또는 signed double-submit token을 적용한다.
3. 모든 상태 변경에서 `Origin`을 검사하고 신뢰하는 정확한 origin allowlist만 허용한다.
4. 가능한 경우 session cookie를 `SameSite=Strict; Secure; HttpOnly`로 설정하고 실제 로그인 흐름과 호환성을 테스트한다.
5. 최소 CSP를 `default-src 'self'; object-src 'none'; base-uri 'none'`에서 시작해 nonce 기반 script 정책으로 강화한다.
6. `Referrer-Policy: no-referrer`, 최소 `Permissions-Policy`, `X-Content-Type-Options: nosniff`, HTTPS 환경의 HSTS를 Edge에서 일관되게 설정한다.
7. CSRF 테스트에는 cross-site와 same-site sibling origin을 모두 포함한다.


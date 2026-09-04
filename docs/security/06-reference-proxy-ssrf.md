# ODY-006: 웹 참고자료 프록시 SSRF

## 취약점 요약

- **심각도:** 높음
- **영향:** 내부 HTTP 서비스 조회, 클라우드 메타데이터 접근, 내부 포트 탐색
- **원인:** 최초 DNS 결과만 검사한 뒤 리다이렉트를 자동 추적하고, 검사와 실제 연결 사이에 DNS를 다시 해석한다.
- **주요 근거:** `apps/api/odysseus_api/routers/reference.py:527`, `apps/api/odysseus_api/routers/reference.py:565`, `apps/api/odysseus_api/routers/reference.py:651`, `apps/api/odysseus_api/routers/reference.py:705`

## 상세

`_is_public_url()`은 입력 URL의 호스트를 미리 해석해 사설·loopback·link-local 주소를 거부한다. 그러나 httpx는 별도로 연결하며 `follow_redirects=True`를 사용한다.

`/reference/web/page`는 최초 URL만 검사하고 최종 리다이렉트 목적지를 검사하지 않는다. `/render`는 최종 URL을 검사하지만 응답 내용을 이미 가져온 뒤다. CSS와 자산 fetch에도 동일한 리다이렉트 문제가 있다. DNS rebinding의 경우 검사 시 공인 IP를 반환하고 연결 시 내부 IP를 반환할 수 있다.

## 재현 방법(공격 방법)

외부 인터넷이나 실제 메타데이터 주소를 대상으로 하지 않는다. 테스트 네트워크에 다음 두 서비스를 준비한다.

- `redirect.test`: 검사에서 허용되는 테스트 HTTP 서버. 요청 시 테스트 내부 서비스로 302를 반환한다.
- `internal.test`: `SECRET_TEST_MARKER`만 반환하는 격리된 내부 HTTP 서버.

그 후 본인 계정으로 다음과 같이 요청한다.

```bash
curl -sS -b "$COOKIE_JAR" \
  --get --data-urlencode 'url=http://redirect.test/to-internal' \
  "$BASE_URL/reference/web/page"
```

응답에 `SECRET_TEST_MARKER`가 포함되면 리다이렉트 SSRF가 재현된다. 실제 `169.254.169.254`, localhost, 사내 IP를 사용하지 않는다.

## 공격 예시

1. **리다이렉트 기반 내부 API 조회:** 공인 웹 서버가 `http://api:8000/openapi.json` 같은 내부 주소로 302를 보내게 한다.
2. **클라우드 메타데이터 접근:** 외부 URL에서 link-local 메타데이터 서비스로 리다이렉트해 인스턴스 자격증명을 읽으려 한다.
3. **DNS rebinding:** 동일 호스트가 사전 검사에는 공인 IP, 실제 연결에는 `127.0.0.1` 또는 RFC1918 주소를 반환한다.
4. **자산 프록시 우회:** 서명된 이미지/CSS URL의 공인 서버가 내부 서비스로 리다이렉트해 응답을 프록시하게 한다.

## 해결 방법

1. DNS를 한 번 해석한 뒤 검증된 IP에 직접 연결하고 원래 hostname은 Host/SNI에만 사용한다.
2. 매 리다이렉트 hop마다 scheme, hostname, 해석된 모든 IP를 검사한다. 가능하면 자동 리다이렉트를 끄고 직접 처리한다.
3. HTTP 클라이언트가 프록시 환경변수를 신뢰하지 않도록 `trust_env=False`를 설정한다.
4. IPv4·IPv6의 private, loopback, link-local, multicast, reserved, unspecified 범위를 모두 차단한다.
5. API 컨테이너 egress를 allowlist 프록시로 제한하고 메타데이터·내부 대역을 네트워크 계층에서도 차단한다.
6. 요청 의도와 각 redirect 목적지를 외부 요청 전에 기록하고 실패한 시도도 보안 로그에 남긴다.


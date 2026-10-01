# ODY-023: 로그아웃 후 JWT 재사용과 브라우저 잔존 데이터

## 취약점 요약

- **심각도:** 중간
- **영향:** 로그아웃 후 세션 재사용, 공유 시험 PC에서 답안·대화·출력 잔존
- **원인:** 상태 없는 12시간 JWT를 쿠키에서만 삭제하고 revocation하지 않으며 민감 응답에 `no-store`·`Clear-Site-Data` 정책이 없다.
- **주요 근거:** `apps/api/odysseus_api/security.py:23`, `apps/api/odysseus_api/routers/auth.py:20`, `apps/api/odysseus_api/routers/auth.py:31`, `apps/api/odysseus_api/deps.py:11`

## 상세

로그인은 12시간 유효한 HS256 JWT를 발급한다. 토큰에는 exp만 있고 세션 ID, 발급 버전, revocation 상태가 없다. 로그아웃은 브라우저에 cookie 삭제 응답만 보내므로 로그아웃 전에 복사한 token은 서버 입장에서 계속 유효하다.

인증 dependency는 Cookie가 없으면 Authorization Bearer도 허용한다. 따라서 DevTools, HAR, 평문 네트워크 등으로 얻은 token은 cookie 삭제 후에도 재사용할 수 있다. 또한 답안 파일, 실행 출력, AI 대화 같은 GET 응답에 전역 `Cache-Control: no-store`가 없고 logout 시 browser storage/cache를 지우지 않는다.

## 재현 방법(공격 방법)

본인 로컬 계정에서만 수행한다.

1. 로그인 응답의 테스트 JWT를 cookie jar 또는 DevTools에서 복사한다.
2. `/auth/logout`을 호출한다.
3. 삭제된 cookie 대신 복사한 값을 Bearer로 `/auth/me`에 보낸다.

```bash
curl -i -H "Authorization: Bearer $TEST_JWT" "$BASE_URL/auth/me"
```

로그아웃 후에도 200이 반환되면 재사용이 확인된다. 토큰을 문서·shell history에 저장하지 않고 테스트 후 계정을 비활성화한다.

## 공격 예시

1. **DevTools 복사 후 재사용:** 응시자가 자신의 token을 저장해 로그아웃 이후 reference API와 과거 데이터를 계속 사용한다.
2. **공유 PC의 HAR 탈취:** 이전 사용자가 지원용으로 저장한 HAR에서 token을 얻어 만료 전 세션을 재현한다.
3. **공용 브라우저 뒤로가기:** 다음 응시자가 BFCache나 브라우저 cache에 남은 이전 답안·AI 대화 화면을 본다.
4. **관리자 강제 로그아웃 무력화:** cookie 삭제만 수행하는 클라이언트 조치 후 이미 복사된 token으로 접근을 계속한다.

## 해결 방법

1. JWT에 무작위 `jti`를 넣고 서버 session table에서 active/revoked 상태와 absolute/idle expiry를 관리한다.
2. logout, 비밀번호 변경, 계정 비활성화, 시험 종료 시 관련 session을 서버에서 폐기한다.
3. 시험 세션 token은 짧게 유지하고 refresh token을 사용한다면 rotation과 reuse detection을 적용한다.
4. 답안·대화·실행·평가·사용자 API 응답에 `Cache-Control: no-store, private`와 필요 시 `Pragma: no-cache`를 설정한다.
5. 로그아웃 응답에 배포 검토 후 `Clear-Site-Data: "cache", "cookies", "storage"`를 적용하고 service worker/cache storage도 정리한다.
6. kiosk 또는 임시 browser profile을 사용해 시험 종료 시 프로필 전체를 폐기한다.


## 조치 (2026-09-04, 완료)

- **서버 세션:** `sessions` 테이블(id=jti, user, 생성·마지막 활동·절대 만료·폐기 시각/사유·IP·UA)을 두고 로그인마다 한 행을 만든다. JWT 에 `jti` 를 넣고, `get_current_user` 가 요청마다 세션이 살아 있는지(폐기 아님·절대 만료 전·유휴 4시간 이내)를 확인한다. `jti` 없는 옛 토큰은 거부된다 (`models.Session`, `security.create_token`, `deps.py`).
- **폐기 시점:** 로그아웃(`logout`), 관리자의 비밀번호 변경·역할 변경·비활성화(`users.update_user` → `revoke_user_sessions`). 사용자 삭제는 CASCADE 로 세션이 사라진다.
- **브라우저 잔존 데이터:** 로그아웃 응답에 `Clear-Site-Data: "cache", "cookies", "storage"` 를 붙이고, 웹의 `logout()` 도 `sessionStorage`/`localStorage` 를 지운다. 모든 API 응답은 미들웨어가 `Cache-Control: no-store, private` + `Pragma: no-cache` 를 단다 (서명 자산 프록시만 `private, max-age=300`).
- **검증:** `tests/security/test_session_revocation.py` — 로그아웃 뒤 쿠키·Bearer 재사용 401, 세션 행 revoked(logout), 비밀번호 변경으로 두 기기 세션 401·새 비밀번호 로그인 OK, 비활성화 401, 유휴 5시간·절대 만료 401, no-store 헤더, jti 없는 토큰 401.
- **미완:** refresh token 회전(#3)은 단일 12시간 세션 + 유휴 만료로 대신한다. 시험 종료 시 세션 폐기(#2 일부)는 응시자가 대시보드를 계속 봐야 해 두지 않았다.

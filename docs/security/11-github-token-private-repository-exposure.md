# ODY-011: 공용 GitHub 토큰을 통한 비공개 저장소 노출

## 취약점 요약

- **심각도:** 조건부 높음
- **영향:** 조직 비공개 저장소 검색·파일 열람·시험 워크스페이스로 복제
- **성립 조건:** 관리자 설정의 GitHub 토큰이 private repository 읽기 권한을 가진 경우
- **원인:** 모든 응시자의 GitHub API 요청에 동일한 서버 토큰을 붙이고 repository allowlist를 적용하지 않는다.
- **주요 근거:** `apps/api/odysseus_api/routers/reference.py:92`, `apps/api/odysseus_api/routers/reference.py:99`, `apps/api/odysseus_api/routers/reference.py:209`

## 상세

GitHub 참고 기능은 관리자 설정의 `github_token`을 모든 검색·repository·tree·file·clone 요청에 사용한다. endpoint는 로그인 여부와 전역 `github_enabled`만 확인하고 토큰이 볼 수 있는 저장소 중 응시자에게 허용된 저장소인지 확인하지 않는다.

따라서 편의를 위해 조직용 PAT 또는 GitHub App 토큰을 넣으면 그 토큰이 접근할 수 있는 비공개 코드가 응시자에게 간접 공개된다. 토큰 문자열 자체가 응답되지 않아도 권한 대리(confused deputy)가 발생한다.

## 재현 방법(공격 방법)

실제 회사 토큰을 사용하지 않는다. 별도 테스트 GitHub 조직에 비공개 repository `security-lab/private-sample`을 만들고 read-only 토큰을 설정한다.

```bash
curl -sS -b "$COOKIE_JAR" --get \
  --data-urlencode 'owner=security-lab' \
  --data-urlencode 'name=private-sample' \
  "$BASE_URL/reference/github/repo"
```

일반 candidate 계정에 repository 내용이 반환되면 재현된다. 테스트 후 토큰을 즉시 폐기한다.

## 공격 예시

1. **검색을 통한 발견:** GitHub 검색 쿼리로 조직명, 내부 프로젝트명 또는 `is:private` 조건을 사용해 비공개 저장소를 열거한다.
2. **알려진 저장소 직접 조회:** 사내 문서에서 이름을 아는 private repo의 owner/name을 직접 `/repo`, `/tree`, `/file`에 전달한다.
3. **전체 소스 반입:** `/github/clone`을 호출해 비공개 저장소의 텍스트 파일을 시험 워크스페이스로 복제하고 이후 파일 API로 읽는다.
4. **비밀 탐색:** `.env.example`, CI 설정, 배포 문서, 내부 endpoint 이름이 포함된 파일을 tree/file API로 찾는다.

## 해결 방법

1. 가장 안전하게는 응시자 기능에 인증되지 않은 GitHub API만 사용해 public repository로 범위를 제한한다.
2. 토큰이 필요하면 시험 전용 GitHub App을 만들고 명시적으로 허용한 public/test repository에만 installation 권한을 부여한다.
3. repository ID 기반 allowlist를 적용하고 검색 결과·redirect 후 canonical repository에도 다시 검사한다.
4. `visibility == public`을 서버에서 확인한 후에만 README, tree, file, archive를 반환한다.
5. 기존 토큰의 권한과 접근 로그를 검토하고 광범위한 PAT라면 폐기·교체한다.
6. GitHub 조회를 모두 유효한 active attempt와 연결해 감사 로그에 남긴다.


## 조치 (2026-09-04, 완료)

- **공개 저장소만:** 저장소 단위 엔드포인트(`/reference/github/repo`·`/tree`·`/file`·`/github/clone`)는 먼저 `_require_public_repo()` 로 저장소 메타를 받아 `private == false` 이고 `visibility == "public"` 일 때만 진행한다. 비공개·internal 은 존재 여부를 드러내지 않도록 404 로 답하고 서버 로그에 남긴다 (`routers/reference.py`). 이름이 바뀐 저장소도 정식 이름으로 다시 확인된 메타를 쓴다.
- **검색:** 검색어의 `is:private`/`is:internal` 한정자를 지우고 서버가 `is:public` 을 붙이며, 결과도 `_public_only()` 로 한 번 더 거른다.
- **결과:** 관리자가 넓은 권한의 PAT 를 넣어도 응시자에게는 공개 저장소만 보인다 (confused deputy 차단). 토큰은 여전히 조회 한도(rate limit) 완화에만 쓰인다.
- **검증:** `tests/security/test_github_visibility.py` — 가짜 GitHub 로 private·internal 저장소 404, 없는 저장소와 같은 응답, 검색 결과 필터·`is:private` 무력화, 네 엔드포인트가 헬퍼를 콘텐츠 조회보다 먼저 지나는지(소스 계약), 실제 공개 저장소(octocat/Hello-World)는 통과.
- **권고(운영):** 토큰은 저장소 권한이 없는 fine-grained PAT 로 두는 것이 안전하다 — 설정 화면 안내에 반영.

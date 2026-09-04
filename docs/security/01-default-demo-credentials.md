# ODY-001: 기본 데모 관리자 계정 자동 생성

## 취약점 요약

- **심각도:** 치명적
- **영향:** 관리자·평가자 권한 탈취, 전체 시험·응시 데이터 열람 및 변경
- **원인:** 데모 데이터 생성이 기본 활성화되어 있고 고정 비밀번호가 코드와 로그인 화면, 운영 스크립트에 공개되어 있다.
- **주요 근거:** `apps/api/odysseus_api/config.py:14`, `apps/api/odysseus_api/seed.py:37`, `apps/web/app/login/page.tsx:63`, `README.md:140`

## 상세

`SEED_DEMO_DATA`의 기본값이 `true`이고 DB가 비어 있으면 `admin@odysseus.dev/admin1234`, 평가자 및 응시자 데모 계정이 생성된다. 동일한 비밀번호가 README, 로그인 페이지, 배포·스냅샷 스크립트에도 들어 있다. 운영자가 환경변수를 빠뜨린 새 배포, 임시 복구 환경 또는 스테이징 복제본은 인터넷에 노출되는 즉시 알려진 관리자 자격증명을 갖게 된다.

비밀번호가 해시로 저장되는지는 이 문제를 해결하지 않는다. 공격자는 평문을 이미 알고 있으므로 정상 로그인 절차로 권한을 얻을 수 있다.

## 재현 방법(공격 방법)

로컬 전용 스택에서 DB가 비어 있고 `SEED_DEMO_DATA`를 별도로 끄지 않은 상태로 시작한다.

```bash
docker compose up -d
curl -i -c /tmp/admin-cookie.txt \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@odysseus.dev","password":"admin1234"}' \
  http://localhost:3100/api/auth/login
```

HTTP 200과 관리자 사용자 정보가 반환되면 재현된다. 테스트가 끝나면 해당 로컬 데이터 볼륨을 운영 데이터와 혼동하지 않도록 폐기한다.

## 공격 예시

1. **신규 운영 배포 탈취:** 운영자가 `.env`에 `SEED_DEMO_DATA=false`를 넣지 않아 공격자가 공개된 관리자 계정으로 로그인한다.
2. **재해복구 서버 탈취:** 빈 DB로 복구 리허설을 진행하는 동안 데모 계정이 다시 생성되고 내부 사용자에게 알려지지 않은 관리자 세션이 만들어진다.
3. **평가자 계정 악용:** 공개된 `evaluator@odysseus.dev/eval1234`로 응시 결과, 대화, 파일 및 평가 데이터를 열람한다.
4. **응시자 사칭:** 공용 `candidate@odysseus.dev/cand1234` 계정으로 다른 사람이 시험을 시작하거나 기존 응시 기록을 오염시킨다.

## 해결 방법

1. `seed_demo_data` 기본값을 `False`로 바꾸고 운영 모드에서 `true`이면 애플리케이션 시작을 거부한다.
2. 데모 계정 생성은 별도의 명시적 CLI 명령으로 분리하고, 무작위 일회용 비밀번호를 생성한다.
3. 로그인 화면, README, 배포 스크립트에서 고정 자격증명을 제거한다.
4. 최초 관리자 생성에는 설치 토큰 또는 콘솔 전용 bootstrap 절차를 사용한다.
5. 이미 배포된 환경에서는 세 데모 계정을 삭제 또는 비활성화하고 모든 관련 세션/JWT를 폐기한다.
6. CI에 `admin1234`, `eval1234`, `cand1234` 같은 금지 문자열 검사를 추가한다.


## 조치 (2026-09-04, 완료)

- **기본값 반전:** `seed_demo_data` 기본 `False`, `ODYSSEUS_ENV` 기본 `production`. 운영 모드에서 `SEED_DEMO_DATA=true` 면 `check_startup_security()` 가 기동을 거부한다 (`apps/api/odysseus_api/config.py`, `main.py`).
- **부트스트랩 분리:** 빈 DB 는 `bootstrap_if_empty()` 가 관리자 1명 + 기본 콘텐츠만 만든다. 비밀번호는 `BOOTSTRAP_ADMIN_PASSWORD` 또는 무작위(24자) 생성 후 **로그에 한 번만** 출력하고 저장하지 않는다 (`seed.py`). 데모 계정은 `seed_demo_if_empty()` 로 분리되어 development 에서만 만들어진다.
- **고정 자격증명 제거:** 로그인 화면 안내 문구, README, `scripts/deploy.sh`, `scripts/snapshot.py` 에서 삭제. 배포 스크립트는 `.env` 의 `BOOTSTRAP_ADMIN_EMAIL/PASSWORD` 를 읽는다. `docker-compose.yml` 기본값도 `false`.
- **재발 방지:** `tests/security/check_demo_credentials.py` 가 개발 시드·테스트·이 문서 밖의 `admin1234|eval1234|cand1234` 를 실패로 잡는다.
- **운영 환경:** 세 데모 계정의 비밀번호를 무작위 값으로 교체했다(이전 값으로 로그인 401 확인). 기존 JWT 는 만료(12h)까지 유효하며, 세션 즉시 폐기는 ODY-023 에서 다룬다.
- **검증:** 격리된 compose 프로젝트에서 (1) 운영 기본값 → 배너·무작위 비밀번호·데모 로그인 401, (2) 환경변수 지정 → 그 값으로 로그인, 로그 출력 0회, (3) 운영+데모 시드 → 기동 거부, (4) development+데모 시드 → 데모 계정 생성 을 확인했다.

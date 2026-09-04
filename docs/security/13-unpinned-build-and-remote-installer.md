# ODY-013: 잠금 없는 의존성과 원격 latest 설치

## 취약점 요약

- **심각도:** 높음
- **영향:** 동일 소스의 빌드 결과 변조·불일치, 공급망 침해 시 임의 코드 실행
- **원인:** 프론트엔드 lockfile 부재, 범위 지정 의존성, `curl | bash`와 `latest` 사용, 이미지 digest 미고정
- **주요 근거:** `apps/web/package.json:10`, `apps/api/Dockerfile:9`, `apps/api/Dockerfile:14`, `docker-compose.yml:16`

## 상세

`apps/web`에는 package lockfile이 없고 dependencies는 대부분 caret 범위다. Python requirements도 범위 기반이며 Docker base와 Compose 서비스 이미지는 tag만 사용한다. API 이미지 빌드는 원격 설치 스크립트를 받아 즉시 shell로 실행하고 기본 CLI 버전은 `latest`다.

따라서 빌드 날짜, registry 상태, DNS/CDN 응답에 따라 서로 다른 코드가 설치된다. upstream 계정·패키지·설치 서버가 침해되거나 호환성 문제를 가진 새 버전이 배포되면 애플리케이션 소스 변경 없이 빌드 환경에서 코드가 실행된다.

## 재현 방법(공격 방법)

외부 공급자를 공격하지 않고 재현성만 확인한다.

1. 서로 다른 임시 디렉터리 또는 날짜가 다른 CI 작업에서 `npm install --package-lock-only` 결과를 생성한다.
2. 생성된 resolved version과 integrity가 소스에 고정돼 있지 않은지 확인한다.
3. Docker build log에서 Claude CLI가 `latest`로 설치되고 원격 script checksum 검증이 없는지 확인한다.
4. `docker compose config`에서 image digest 대신 mutable tag가 사용되는지 확인한다.

## 공격 예시

1. **npm 패키지 공급망 침해:** 허용 semver 범위 안에 악성 버전이 게시되어 다음 운영 빌드에 자동 포함된다.
2. **원격 설치 스크립트 변조:** `claude.ai/install.sh` 또는 전달 CDN이 침해되어 Docker build 권한으로 악성 shell이 실행된다.
3. **mutable latest 변경:** 같은 commit을 재빌드했지만 다른 Claude CLI 버전이 설치되어 보안 잠금 옵션의 의미가 달라진다.
4. **container tag 이동:** `postgres:16-alpine`, `redis:7-alpine`, `python:3.12-slim` tag가 새 digest를 가리켜 예기치 않은 변경이나 취약 코드가 도입된다.
5. **의존성 혼동:** 내부에서 기대한 이름과 같은 public package 또는 잘못된 registry 설정이 빌드에 섞인다.

## 해결 방법

1. `package-lock.json` 또는 조직 표준 lockfile을 생성해 소스에 커밋하고 CI에서는 `npm ci`만 사용한다.
2. Python 의존성은 hashes를 포함한 완전 고정 requirements/lock 파일로 설치한다.
3. CLI 버전을 명시적으로 고정하고 검증된 artifact의 SHA-256 또는 공급자 서명을 확인한 뒤 설치한다.
4. `curl | bash`를 제거하고 다운로드·검증·실행 단계를 분리한다.
5. base/service 이미지를 digest로 고정하고 자동 업데이트 PR에서 SBOM·취약점 검사·회귀 테스트를 수행한다.
6. 빌드는 최소 권한, 일시적 credential, 제한된 egress를 가진 격리 builder에서 수행한다.


## 조치 (2026-09-04, 완료)

- **프론트엔드 lockfile:** `apps/web/package-lock.json`(v3) 을 커밋하고 Dockerfile 은 `npm ci --ignore-scripts` 만 쓴다. 범위 지정(`^`)은 lockfile 이 고정한다.
- **Python:** `apps/api/requirements.lock`(운영 이미지의 `pip freeze`, 전 패키지 `==`)을 두고 `pip install --no-deps -r requirements.lock` 으로만 설치한다. `requirements.txt` 는 사람이 읽는 범위 명세로 남긴다. 올릴 때는 새 이미지에서 freeze 를 다시 뜬다.
- **Claude CLI:** `CLAUDE_CLI_VERSION` 기본값을 `latest` 에서 `2.1.260`(운영 설치본)으로 고정. 설치 스크립트는 파일로 받아(`--proto '=https' --tlsv1.2`) 실행하고, 설치 뒤 `claude --version` 이 고정 버전과 같지 않으면 빌드가 실패한다. `curl | bash` 제거.
- **이미지 digest:** `python:3.12-slim`, `node:22-alpine`(3단계 모두), `nginx:1.27-alpine`, `ubuntu:24.04`, compose 의 `postgres:16-alpine`·`redis:7-alpine` 을 `@sha256:…` 로 고정했다. postgres/redis 는 운영이 지금 돌리는 digest 그대로라 배포로 DB 가 바뀌지 않는다.
- **검증:** 격리 스택에서 다섯 이미지를 전부 다시 빌드해 기동하고 핵심 스모크(test_core·test_reference)를 통과시켰다. `npm ci` 는 lockfile 과 package.json 이 어긋나면 실패하므로 그 자체가 검사다.
- **미완:** pip 해시 고정(`--require-hashes`)과 SBOM·취약점 스캔 CI(#5·#6)는 CI 파이프라인이 생길 때 붙인다. Claude CLI 배포판은 공급자 서명이 없어 버전 일치 확인까지만 한다.

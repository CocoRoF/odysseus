# ODY-016: 평문 비밀이 포함된 보호되지 않은 백업

## 취약점 요약

- **심각도:** 높음
- **영향:** 사용자·답안·평가·AI API 키·관리자 설정 전체 유출
- **원인:** repository 내부 `backups/`에 암호화되지 않은 SQL gzip을 만들며 권한을 강제하지 않는다.
- **주요 근거:** `scripts/backup.sh:6`, `scripts/backup.sh:13`, `scripts/backup.sh:14`, `scripts/backup.sh:22`

## 상세

백업 스크립트는 DB 전체를 `pg_dump | gzip`으로 저장한다. 주석에 명시된 것처럼 여기에는 계정, 시나리오, 응시 기록, 워크스페이스 파일, AI 공급자 키와 관리자 설정이 포함된다.

gzip은 압축일 뿐 암호화가 아니다. 스크립트는 `umask 077`이나 `chmod 600`을 설정하지 않아 실행 환경의 umask에 따라 다른 로컬 사용자가 읽을 수 있다. 경로가 소스 트리 안이므로 Git add, CI artifact, 일반 파일 백업에 우연히 포함될 가능성도 크다.

## 재현 방법(공격 방법)

실제 운영 백업을 열지 않는다. 가짜 키만 포함된 로컬 테스트 DB에서 백업을 만든다.

```bash
umask 022
./scripts/backup.sh security-test
ls -l backups/*security-test.sql.gz
gzip -cd backups/*security-test.sql.gz | grep -F 'TEST_ONLY_FAKE_KEY'
```

권한이 `-rw-r--r--`처럼 넓거나 압축 해제한 SQL에 가짜 키가 평문으로 보이면 재현된다. 테스트 파일은 확인 후 안전하게 폐기한다.

## 공격 예시

1. **로컬 사용자 열람:** 같은 서버의 다른 계정이 world/group-readable backup을 복사해 비밀번호 해시와 API 키를 추출한다.
2. **Git 유출:** 운영자가 `git add .`를 실행해 backup 파일을 원격 저장소에 커밋한다.
3. **CI artifact 유출:** 배포 작업이 workspace 전체를 artifact로 수집하면서 backup을 접근 권한이 넓은 저장소에 올린다.
4. **서버 백업의 2차 유출:** 호스트 파일 백업이나 스냅샷을 탈취한 공격자가 별도 복호화 없이 SQL을 읽는다.
5. **오래된 credential 재사용:** 최근 20개 backup 중 과거에 유효했던 장수 API 토큰을 발견해 재사용한다.

## 해결 방법

1. 스크립트 시작 시 `umask 077`을 설정하고 전용 root 소유 디렉터리에 mode 0700으로 저장한다.
2. 백업을 repository 밖으로 이동하고 `.gitignore`만을 보안 통제로 의존하지 않는다.
3. KMS 또는 검증된 age/GPG 수신자 키로 client-side 암호화한 뒤 저장한다.
4. AI/API 비밀은 가능하면 DB에 평문 저장하지 말고 secret manager 참조만 저장한다.
5. 백업 접근·복원·다운로드를 감사하고 보존 기간과 자동 폐기를 정책화한다.
6. 정기 복원 테스트에서 권한, 암호화, key rotation, 폐기된 키 무효화를 함께 검증한다.


## 조치 (2026-09-04, 완료)

- **위치·권한:** 백업은 저장소 밖 `/var/backups/odysseus`(`ODYSSEUS_BACKUP_DIR`)에만 쓴다. 스크립트가 `umask 077` 로 시작해 폴더 0700·파일 0600 이 강제된다 (`scripts/backup.sh`). 소스 트리의 `backups/` 는 더 이상 쓰지 않는다.
- **암호화:** `pg_dump | gzip` 뒤에 바로 암호화한다. `BACKUP_AGE_RECIPIENT` 와 `age` 가 있으면 공개키(age)로, 아니면 `openssl enc -aes-256-cbc -pbkdf2 -iter 200000` 과 호스트 키 파일 `/etc/odysseus/backup.key`(0600 root, 첫 실행에 생성)로. 평문 덤프는 디스크에 닿지 않는다.
- **복원:** `scripts/restore.sh` 가 `.enc`/`.age`/`.sql.gz` 를 구분해 열고, 앱을 내리기 **전에** 먼저 열리는지 검사한다(키가 틀리면 아무것도 건드리지 않음). 자동화용 `--yes`.
- **감사:** 백업 생성·복원 시작/완료를 `logger -t odysseus-backup` 으로 syslog 에 남긴다 (누가, 어느 파일).
- **보존:** 최근 20개(`ODYSSEUS_BACKUP_KEEP`)만 남긴다.
- **운영 이관:** 미니PC 의 기존 평문 백업 5개를 새 위치로 옮겨 암호화하고 평문은 지웠다. 키 파일 사본은 별도 보관이 필요하다 (아래 운영 메모).
- **검증:** 격리 스택에서 `COMPOSE_PROJECT_NAME` 으로 backup→(파일 권한 0600·폴더 0700·gzip 아님·openssl 로 열림)→데이터 변경→restore --yes→원복 확인, 틀린 키로는 복원이 시작조차 안 됨.
- **미완:** AI 키를 secret manager 참조로 바꾸는 것(#4)은 단일 호스트 배포라 보류 — 대신 백업이 암호화된다. 키 회전·정기 복원 훈련(#6)은 운영 절차로 남긴다.

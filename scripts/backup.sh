#!/usr/bin/env bash
# 데이터베이스 백업 — 배포 전에 자동으로 돌고, 손으로도 부를 수 있다.
#
#   sudo ./scripts/backup.sh [설명]
#
# 여기에 담기는 것: 계정·시나리오·시험·응시 기록·워크스페이스 파일,
# 그리고 **AI 공급자 키와 관리자 설정**. 이것들이 날아가면 되돌릴 방법이 없고,
# 새어 나가면 되돌릴 수도 없다. 그래서 (ODY-016):
#   · 저장소 밖의 root 전용 폴더(0700)에, 파일은 0600 으로만 쓴다 (umask 077)
#   · 저장 전에 암호화한다 — BACKUP_AGE_RECIPIENT 가 있고 age 가 깔려 있으면 age(공개키),
#     아니면 openssl AES-256-CBC(PBKDF2) + 호스트의 키 파일(0600 root)
#   · 백업·복원은 syslog 에 남긴다
#
# 환경변수: ODYSSEUS_BACKUP_DIR (기본 /var/backups/odysseus), ODYSSEUS_BACKUP_KEY (기본 /etc/odysseus/backup.key),
#          BACKUP_AGE_RECIPIENT (age1…), ODYSSEUS_BACKUP_KEEP (기본 20)
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."

LABEL="${1:-manual}"
STAMP="$(date +%Y%m%d-%H%M%S)"
DIR="${ODYSSEUS_BACKUP_DIR:-/var/backups/odysseus}"
KEYFILE="${ODYSSEUS_BACKUP_KEY:-/etc/odysseus/backup.key}"
KEEP="${ODYSSEUS_BACKUP_KEEP:-20}"

mkdir -p "${DIR}"
chmod 700 "${DIR}"

if ! docker compose ps --status running --format '{{.Service}}' | grep -qx postgres; then
  echo "postgres 가 떠 있지 않습니다 — 백업할 수 없습니다." >&2
  exit 1
fi

# 암호화 방식 결정
if [[ -n "${BACKUP_AGE_RECIPIENT:-}" ]] && command -v age >/dev/null 2>&1; then
  MODE="age"; OUT="${DIR}/${STAMP}-${LABEL}.sql.gz.age"
else
  MODE="openssl"; OUT="${DIR}/${STAMP}-${LABEL}.sql.gz.enc"
  if [[ ! -s "${KEYFILE}" ]]; then
    mkdir -p "$(dirname "${KEYFILE}")"
    chmod 700 "$(dirname "${KEYFILE}")"
    openssl rand -hex 32 > "${KEYFILE}"
    chmod 600 "${KEYFILE}"
    echo "▸ 새 백업 키를 만들었습니다: ${KEYFILE} — 이 파일이 없으면 백업을 열 수 없습니다. 안전한 곳에 사본을 두세요." >&2
  fi
fi

echo "▸ 백업 중 (${MODE}) → ${OUT}"
if [[ "${MODE}" == "age" ]]; then
  docker compose exec -T postgres pg_dump -U odysseus -d odysseus --clean --if-exists \
    | gzip | age -r "${BACKUP_AGE_RECIPIENT}" -o "${OUT}"
else
  docker compose exec -T postgres pg_dump -U odysseus -d odysseus --clean --if-exists \
    | gzip | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass "file:${KEYFILE}" -out "${OUT}"
fi
chmod 600 "${OUT}"

SIZE="$(du -h "${OUT}" | cut -f1)"
echo "▸ 완료 (${SIZE})"
logger -t odysseus-backup "backup created file=${OUT} size=${SIZE} mode=${MODE} by=${SUDO_USER:-$(id -un)}" 2>/dev/null || true

# 오래된 백업 정리 — 최근 KEEP 개만 남긴다
ls -1t "${DIR}"/*.sql.gz.* 2>/dev/null | tail -n +"$((KEEP + 1))" | xargs -r rm -f --
echo "${OUT}"

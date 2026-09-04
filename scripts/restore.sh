#!/usr/bin/env bash
# 백업 복원 — 현재 데이터를 **덮어쓴다**. 되돌릴 수 없으므로 두 번 묻는다.
#
#   sudo ./scripts/restore.sh /var/backups/odysseus/20260903-120000-predeploy.sql.gz.enc
#   sudo ./scripts/restore.sh <파일> --yes      # 자동화(검증 스크립트)용 — 확인 생략
#
# 암호화된 백업(.enc = openssl 키 파일, .age = age 개인키)과 예전 평문(.sql.gz)을 모두 연다 (ODY-016).
# 환경변수: ODYSSEUS_BACKUP_KEY (기본 /etc/odysseus/backup.key), BACKUP_AGE_IDENTITY (age 개인키 파일)
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."

FILE="${1:-}"
ASSUME_YES=0
[[ "${2:-}" == "--yes" ]] && ASSUME_YES=1
DIR="${ODYSSEUS_BACKUP_DIR:-/var/backups/odysseus}"
KEYFILE="${ODYSSEUS_BACKUP_KEY:-/etc/odysseus/backup.key}"

if [[ -z "${FILE}" || ! -f "${FILE}" ]]; then
  echo "사용법: $0 <백업파일> [--yes]" >&2
  echo "" >&2
  echo "있는 백업 (${DIR}):" >&2
  ls -1t "${DIR}"/*.sql.gz* 2>/dev/null | head -10 >&2 || echo "  (없음)" >&2
  exit 1
fi

decrypt() {
  case "${FILE}" in
    *.age)
      [[ -n "${BACKUP_AGE_IDENTITY:-}" ]] || { echo "BACKUP_AGE_IDENTITY(age 개인키 파일)가 필요합니다" >&2; exit 1; }
      age -d -i "${BACKUP_AGE_IDENTITY}" "${FILE}" | gunzip -c ;;
    *.enc)
      [[ -s "${KEYFILE}" ]] || { echo "백업 키 파일이 없습니다: ${KEYFILE}" >&2; exit 1; }
      openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass "file:${KEYFILE}" -in "${FILE}" | gunzip -c ;;
    *.gz)
      gunzip -c "${FILE}" ;;
    *)
      echo "알 수 없는 백업 형식: ${FILE}" >&2; exit 1 ;;
  esac
}

# 먼저 열리는지만 확인한다 — 키가 틀렸는데 앱을 내리는 일은 없어야 한다.
# (head 가 파이프를 일찍 닫으면 pipefail 이 성공을 실패로 만들므로, 그 서브셸에서만 pipefail 을 끈다)
HEAD="$( (set +o pipefail; decrypt 2>/dev/null | head -c 200) || true)"
if ! printf '%s' "${HEAD}" | grep -q "PostgreSQL database dump\|SET statement_timeout"; then
  echo "백업을 열 수 없습니다 (키가 다르거나 손상됨): ${FILE}" >&2
  exit 1
fi

if [[ "${ASSUME_YES}" != "1" ]]; then
  echo "!! 현재 데이터베이스를 '${FILE}' 내용으로 완전히 덮어씁니다."
  echo "!! 지금 있는 응시 기록·설정·AI 공급자 키는 모두 사라집니다."
  read -rp "정말 진행하려면 'restore' 를 입력하세요: " CONFIRM
  [[ "${CONFIRM}" == "restore" ]] || { echo "취소했습니다."; exit 1; }
fi

logger -t odysseus-backup "restore started file=${FILE} by=${SUDO_USER:-$(id -un)}" 2>/dev/null || true
# 복원 중 쓰기가 섞이지 않게 앱을 먼저 멈춘다 (DB 는 살려 둔다)
docker compose stop api web edge runner >/dev/null
decrypt | docker compose exec -T postgres psql -U odysseus -d odysseus -q
docker compose start postgres redis api web edge runner >/dev/null
logger -t odysseus-backup "restore finished file=${FILE}" 2>/dev/null || true
echo "▸ 복원 완료 — 서비스를 다시 시작했습니다."

#!/usr/bin/env bash
# 백업 복원 — 현재 데이터를 **덮어쓴다**. 되돌릴 수 없으므로 두 번 묻는다.
#
#   sudo ./scripts/restore.sh backups/20260903-120000-predeploy.sql.gz
set -euo pipefail
cd "$(dirname "$0")/.."

FILE="${1:-}"
if [[ -z "${FILE}" || ! -f "${FILE}" ]]; then
  echo "사용법: $0 <백업파일.sql.gz>" >&2
  echo "" >&2
  echo "있는 백업:" >&2
  ls -1t backups/*.sql.gz 2>/dev/null | head -10 >&2 || echo "  (없음)" >&2
  exit 1
fi

echo "!! 현재 데이터베이스를 '${FILE}' 내용으로 완전히 덮어씁니다."
echo "!! 지금 있는 응시 기록·설정·AI 공급자 키는 모두 사라집니다."
read -rp "정말 진행하려면 'restore' 를 입력하세요: " CONFIRM
[[ "${CONFIRM}" == "restore" ]] || { echo "취소했습니다."; exit 1; }

# 복원 중 쓰기가 섞이지 않게 앱을 먼저 멈춘다 (DB 는 살려 둔다)
docker compose stop api web edge runner >/dev/null
gunzip -c "${FILE}" | docker compose exec -T postgres psql -U odysseus -d odysseus -q
docker compose start postgres redis api web edge runner >/dev/null
echo "▸ 복원 완료 — 서비스를 다시 시작했습니다."

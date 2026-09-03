#!/usr/bin/env bash
# 데이터베이스 백업 — 배포 전에 자동으로 돌고, 손으로도 부를 수 있다.
#
#   sudo ./scripts/backup.sh [설명]
#
# 여기에 담기는 것: 계정·시나리오·시험·응시 기록·워크스페이스 파일,
# 그리고 **AI 공급자 키와 관리자 설정**. 이것들이 날아가면 되돌릴 방법이 없다.
set -euo pipefail
cd "$(dirname "$0")/.."

LABEL="${1:-manual}"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="backups/${STAMP}-${LABEL}.sql.gz"
mkdir -p backups

if ! docker compose ps --status running --format '{{.Service}}' | grep -qx postgres; then
  echo "postgres 가 떠 있지 않습니다 — 백업할 수 없습니다." >&2
  exit 1
fi

echo "▸ 백업 중 → ${OUT}"
docker compose exec -T postgres pg_dump -U odysseus -d odysseus --clean --if-exists \
  | gzip > "${OUT}"

SIZE="$(du -h "${OUT}" | cut -f1)"
echo "▸ 완료 (${SIZE})"

# 오래된 백업 정리 — 최근 20개만 남긴다
ls -1t backups/*.sql.gz 2>/dev/null | tail -n +21 | xargs -r rm --
echo "${OUT}"

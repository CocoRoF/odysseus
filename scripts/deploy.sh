#!/usr/bin/env bash
# 배포 — 데이터를 지키면서 코드를 올린다.
#
#   sudo ./scripts/deploy.sh            # 전체
#   sudo ./scripts/deploy.sh api web    # 일부 서비스만
#   sudo ./scripts/deploy.sh --yes      # 확인 없이 (자동화용)
#
# 순서: 상태 스냅샷 → DB 백업 → 이미지 빌드 → 기동 → 헬스체크 → 보존 검증.
# 보존 검증이 실패하면 백업 파일 위치와 복원 방법을 알려 준다.
#
# ※ `docker compose down -v` 는 **절대 쓰지 말 것**. -v 는 pgdata 볼륨을 지워
#   계정·응시 기록·AI 공급자 키를 통째로 날린다. 이 스크립트는 컨테이너를
#   교체(up -d)만 하므로 볼륨은 그대로 남는다.
set -euo pipefail
cd "$(dirname "$0")/.."

ASSUME_YES=0
SERVICES=()
for arg in "$@"; do
  case "${arg}" in
    -y|--yes) ASSUME_YES=1 ;;
    *) SERVICES+=("${arg}") ;;
  esac
done
# API and its durable dialogue worker share schemas/provider code; deploy them together.
for service in "${SERVICES[@]}"; do
  if [[ "${service}" == "api" && " ${SERVICES[*]} " != *" office-worker "* ]]; then
    SERVICES+=("office-worker")
  fi
done
STAMP="$(date +%Y%m%d-%H%M%S)"
SNAP="/tmp/odysseus-snapshot-${STAMP}.json"

say() { printf "\n\033[1m▸ %s\033[0m\n" "$*"; }

# 관리자 자격증명은 .env 의 BOOTSTRAP_ADMIN_EMAIL / BOOTSTRAP_ADMIN_PASSWORD 에서 읽는다 (코드에 두지 않는다)
if [[ -f .env ]]; then set -a; source ./.env; set +a; fi
if [[ -z "${BOOTSTRAP_ADMIN_EMAIL:-}" || -z "${BOOTSTRAP_ADMIN_PASSWORD:-}" ]]; then
  echo ".env 에 BOOTSTRAP_ADMIN_EMAIL / BOOTSTRAP_ADMIN_PASSWORD 가 필요합니다 (배포 전후 보존 검증에 사용)." >&2
  exit 1
fi
# 기본 시크릿으로도 배포는 된다(배포판 기본값). 다만 공개된 값이므로 조용히 넘어가지 않는다.
if grep -qE '^(JWT_SECRET|INTERNAL_TOKEN|DATA_ENCRYPTION_KEY)=odysseus-default-' .env 2>/dev/null; then
  say "주의: .env 가 아직 공개된 기본 시크릿을 쓰고 있습니다"
  echo "  실제 응시자 데이터를 받기 전에 바꾸세요 — 각각 \`openssl rand -hex 32\`."
  echo "  (DATA_ENCRYPTION_KEY 를 바꾸면 그 전에 저장한 AI 공급자 키를 다시 입력해야 합니다.)"
fi

# ── 0. 지금 무엇이 도는 중인지 알린다 ──────────────────────────
if docker compose ps --status running --format '{{.Service}}' | grep -qx api; then
  ACTIVE="$(python3 - <<'PY' 2>/dev/null || echo "?"
import sys
sys.path.insert(0, "scripts")
from snapshot import ADMIN, call, loopback_client
op = loopback_client()
status, _ = call(op, "POST", "/auth/login", ADMIN)
assert status == 200
status, d = call(op, "GET", "/admin/resources")
assert status == 200
print(f"{len(d['sessions'])}/{len(d['active'])}")
PY
)"
  IN_PROGRESS="${ACTIVE%%/*}"
  RUNNING="${ACTIVE##*/}"
  if [[ "${IN_PROGRESS}" != "0" && "${IN_PROGRESS}" != "?" ]]; then
    say "주의: 진행 중인 응시 ${IN_PROGRESS}건, 실행 중인 명령 ${RUNNING}건"
    echo "  응시 기록과 파일은 보존되지만, 지금 돌고 있는 명령은 끊깁니다."
    echo "  (응시자는 다시 실행하면 됩니다.)"
    echo "  진행 중이던 AI 대화(메신저·에이전트)는 답이 끊기고, 그 대화방은 1분 안에"
    echo "  다시 열립니다."
    if [[ "${ASSUME_YES}" == "1" ]]; then
      echo "  (--yes) 계속합니다."
    else
      read -rp "  계속할까요? [y/N] " GO
      [[ "${GO}" == "y" || "${GO}" == "Y" ]] || { echo "취소했습니다."; exit 1; }
    fi
  fi

  say "배포 전 상태 기록"
  python3 scripts/snapshot.py > "${SNAP}"
  echo "  ${SNAP}"

  say "데이터베이스 백업"
  BACKUP="$(./scripts/backup.sh predeploy | tail -1)"
else
  say "서비스가 떠 있지 않습니다 — 백업/검증을 건너뛰고 기동만 합니다"
  SNAP=""
  BACKUP=""
fi

# ── 1. 빌드 & 기동 (볼륨은 건드리지 않는다) ────────────────────
say "이미지 빌드"
docker compose build ${SERVICES[@]+"${SERVICES[@]}"}

say "서비스 기동"
docker compose up -d ${SERVICES[@]+"${SERVICES[@]}"}

# ── 2. 헬스체크 ────────────────────────────────────────────────
say "기동 대기"
for i in $(seq 1 60); do
  if curl -fsS -o /dev/null "http://localhost:8100/healthz" 2>/dev/null; then
    echo "  api 준비됨 (${i}초)"
    break
  fi
  sleep 1
  [[ "${i}" == "60" ]] && { echo "  api 가 60초 안에 올라오지 않았습니다." >&2; exit 1; }
done
for i in $(seq 1 60); do
  if curl -fsS -o /dev/null "http://localhost:3100/" 2>/dev/null; then
    echo "  web 준비됨 (${i}초)"
    break
  fi
  sleep 1
  [[ "${i}" == "60" ]] && { echo "  web 가 60초 안에 올라오지 않았습니다." >&2; exit 1; }
done

if [[ -n "$(docker compose ps -q office-worker)" ]]; then
  for i in $(seq 1 60); do
    WORKER_ID="$(docker compose ps -q office-worker)"
    if [[ "$(docker inspect --format '{{.State.Health.Status}}' "${WORKER_ID}")" == "healthy" ]]; then
      echo "  office worker 준비됨 (${i}초)"
      break
    fi
    sleep 1
    [[ "${i}" == "60" ]] && { echo "  office worker 가 준비되지 않았습니다." >&2; exit 1; }
  done
fi

# ── 3. 데이터가 그대로인지 확인 ────────────────────────────────
if [[ -n "${SNAP}" ]]; then
  say "데이터 보존 검증"
  if python3 scripts/snapshot.py "${SNAP}"; then
    rm -f "${SNAP}"
  else
    echo ""
    echo "  배포 전 백업: ${BACKUP}"
    echo "  되돌리려면: sudo ./scripts/restore.sh ${BACKUP}"
    exit 1
  fi
fi

say "배포 완료"
docker compose ps --format '  {{.Service}}\t{{.Status}}'

#!/usr/bin/env bash
# 운영 서버(hr-mini-gmktec, ssh -p 2224)에 배포 — 이 워크스페이스에서 한 줄로.
#
#   ./scripts/remote-deploy.sh            # main 을 pull 하고 전체 배포
#   ./scripts/remote-deploy.sh api web    # 일부 서비스만
#
# 서버에서는 scripts/deploy.sh 가 돈다: 스냅샷 → DB 백업 → 빌드 → 기동 → 헬스체크 →
# 보존 검증. 로컬에서 docker compose 를 직접 올리지 말 것 — 운영은 서버다.
set -euo pipefail
HOST="${ODYSSEUS_HOST:-hrjang@116.47.69.209}"
PORT="${ODYSSEUS_PORT:-2224}"
DIR="${ODYSSEUS_DIR:-~/docker_web/odysseus}"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "커밋되지 않은 변경이 있습니다 — 먼저 커밋·푸시하세요." >&2
  exit 1
fi
LOCAL="$(git rev-parse --short HEAD)"
REMOTE_MAIN="$(git ls-remote -q origin main | cut -c1-7)"
if [[ "${LOCAL}" != "${REMOTE_MAIN}" ]]; then
  echo "HEAD(${LOCAL})가 origin/main(${REMOTE_MAIN})과 다릅니다 — 푸시하세요." >&2
  exit 1
fi

echo "▸ ${HOST}:${PORT} ${DIR} 에 ${LOCAL} 배포"
# sudo 비밀번호는 서버에서 한 번 묻는다 (SUDO_PW 환경변수로 넘길 수도 있다)
ssh -t -p "${PORT}" "${HOST}" "cd ${DIR} && git fetch -q origin && git checkout -q main && git reset -q --hard origin/main && git log --oneline -1 && \
  if [[ -n \"\${SUDO_PW:-${SUDO_PW:-}}\" ]]; then echo \"\${SUDO_PW:-${SUDO_PW:-}}\" | sudo -S -p '' -v; fi; sudo ./scripts/deploy.sh --yes $*"

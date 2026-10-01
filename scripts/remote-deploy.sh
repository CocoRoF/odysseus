#!/usr/bin/env bash
# 운영 서버에 배포 — 이 워크스페이스에서 한 줄로.
#
# 접속 대상(호스트·계정·포트·경로)은 저장소에 두지 않는다. scripts/.deploy.env (gitignore) 나
# 환경변수로 준다:
#   ODYSSEUS_HOST=user@host  ODYSSEUS_PORT=22  ODYSSEUS_DIR=~/path/to/odysseus
#
#   ./scripts/remote-deploy.sh            # main 을 pull 하고 전체 배포
#   ./scripts/remote-deploy.sh api web    # 일부 서비스만
#
# 서버에서는 scripts/deploy.sh 가 돈다: 스냅샷 → DB 백업 → 빌드 → 기동 → 헬스체크 →
# 보존 검증. 로컬에서 docker compose 를 직접 올리지 말 것 — 운영은 서버다.
set -euo pipefail
LOCAL_ENV="$(dirname "$0")/.deploy.env"
# shellcheck disable=SC1090
[[ -f "${LOCAL_ENV}" ]] && source "${LOCAL_ENV}"
HOST="${ODYSSEUS_HOST:-}"
PORT="${ODYSSEUS_PORT:-22}"
DIR="${ODYSSEUS_DIR:-}"
if [[ -z "${HOST}" || -z "${DIR}" ]]; then
  echo "ODYSSEUS_HOST·ODYSSEUS_DIR 가 없습니다 — scripts/.deploy.env 에 적거나 환경변수로 주세요." >&2
  exit 1
fi

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
# sudo 비밀번호: SUDO_PW 환경변수가 있으면 표준입력으로 넘긴다(TTY 없이도 동작), 없으면 서버가 묻는다.
# 로컬에 TTY 가 없는 자동화에서는 `SUDO_PW=... sshpass -p ... ./scripts/remote-deploy.sh` 로 쓴다.
SUDO_CMD="sudo ./scripts/deploy.sh --yes $*"
if [[ -n "${SUDO_PW:-}" ]]; then
  SUDO_CMD="printf '%s\\n' '${SUDO_PW//\'/\'\\\'\'}' | sudo -S -p '' ./scripts/deploy.sh --yes $*"
fi
ssh -t -p "${PORT}" "${HOST}" "cd ${DIR} && git fetch -q origin && git checkout -q main && git reset -q --hard origin/main && git submodule sync -q && git submodule update -q --init --recursive && git log --oneline -1 && ${SUDO_CMD}"

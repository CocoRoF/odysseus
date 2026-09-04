# 베이스 이미지는 digest 로 고정 (ODY-013). 올릴 때는 digest 를 함께 바꾼다.
FROM python:3.12-slim@sha256:78387bc3881b8273120a12ebe6c1ab22b018ccc2c9adf565ae1ac9b536e184ea

WORKDIR /app
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1

# Claude Code CLI — 'Claude Code (CLI)' LLM 공급자용 (순수 LLM 잠금 모드로만 구동).
# 폐쇄망 등 CLI가 필요 없는 빌드는 --build-arg INSTALL_CLAUDE_CLI=false 로 생략.
ARG INSTALL_CLAUDE_CLI=true
# 'latest' 를 쓰지 않는다 — 버전을 고정하고, 설치 후 실제 버전이 같은지 확인한다 (ODY-013).
# 설치 스크립트는 파일로 받아 두고 실행한다 (curl | bash 금지). 올릴 때는 이 값을 바꾼다.
ARG CLAUDE_CLI_VERSION=2.1.260
RUN if [ "$INSTALL_CLAUDE_CLI" = "true" ]; then \
      apt-get update \
      && apt-get install -y --no-install-recommends curl ca-certificates \
      && rm -rf /var/lib/apt/lists/* \
      && curl -fsSL --proto '=https' --tlsv1.2 -o /tmp/claude-install.sh https://claude.ai/install.sh \
      && test -s /tmp/claude-install.sh \
      && bash /tmp/claude-install.sh "$CLAUDE_CLI_VERSION" \
      && rm -f /tmp/claude-install.sh \
      && /root/.local/bin/claude --version | grep -q "^$CLAUDE_CLI_VERSION " ; \
    fi
ENV PATH="/root/.local/bin:${PATH}" \
    DISABLE_AUTOUPDATER=1

# requirements.txt 는 사람이 읽는 범위 명세, requirements.lock 은 빌드가 쓰는 정확한 버전 (pip freeze)
COPY requirements.txt requirements.lock ./
RUN pip install --no-cache-dir --no-deps -r requirements.lock

COPY odysseus_api ./odysseus_api

EXPOSE 8000
# 접근 로그는 엣지가 쿼리 없이 남긴다 — 여기서 전체 URL 을 또 찍지 않는다 (ODY-020)
CMD ["uvicorn", "odysseus_api.main:app", "--host", "0.0.0.0", "--port", "8000", "--no-access-log"]

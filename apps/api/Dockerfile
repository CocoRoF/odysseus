FROM python:3.12-slim

WORKDIR /app
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1

# Claude Code CLI — 'Claude Code (CLI)' LLM 공급자용 (순수 LLM 잠금 모드로만 구동).
# 폐쇄망 등 CLI가 필요 없는 빌드는 --build-arg INSTALL_CLAUDE_CLI=false 로 생략.
ARG INSTALL_CLAUDE_CLI=true
ARG CLAUDE_CLI_VERSION=latest
RUN if [ "$INSTALL_CLAUDE_CLI" = "true" ]; then \
      apt-get update \
      && apt-get install -y --no-install-recommends curl ca-certificates \
      && rm -rf /var/lib/apt/lists/* \
      && curl -fsSL https://claude.ai/install.sh | bash -s "$CLAUDE_CLI_VERSION"; \
    fi
ENV PATH="/root/.local/bin:${PATH}" \
    DISABLE_AUTOUPDATER=1

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY odysseus_api ./odysseus_api

EXPOSE 8000
CMD ["uvicorn", "odysseus_api.main:app", "--host", "0.0.0.0", "--port", "8000"]

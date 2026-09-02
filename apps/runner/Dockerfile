FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# 실행 툴체인 — python3 중심 (jq/curl 등 순수 CLI 도구 일부 포함, 네트워크는 없음)
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 \
        python3-redis \
        python3-requests \
        jq \
        tini \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# 응시 코드를 실행할 비특권 사용자
RUN useradd --system --no-create-home --shell /usr/sbin/nologin sandbox \
    && mkdir -p /work \
    && chmod 777 /work

WORKDIR /app
COPY worker.py sandbox.py ./

ENTRYPOINT ["tini", "--"]
CMD ["python3", "worker.py"]

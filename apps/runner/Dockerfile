FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# 실행 툴체인 — python3 중심. 이 컨테이너는 internal 네트워크에만 붙어
# 외부 인터넷과 데이터베이스에 닿지 않는다 (docker-compose.yml 참조).
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 \
        python3-redis \
        python3-requests \
        python3-yaml \
        jq \
        tini \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# 작업 루트 — 0711 이라 경로 통과는 되지만 목록은 볼 수 없다.
# 실행마다 그 안에 0700 폴더를 만들고 실행 전용 UID 에게 넘긴다 (worker.py 참조).
RUN mkdir -p /work && chmod 711 /work

WORKDIR /app
COPY worker.py sandbox.py ./

ENTRYPOINT ["tini", "--"]
CMD ["python3", "worker.py"]

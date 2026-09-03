FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# 실행 툴체인 — 실무 시뮬레이션이므로 "평범한 개발 워크스테이션"이 되어야 한다.
# 이 컨테이너는 internal 네트워크에만 붙어 외부 인터넷과 데이터베이스에 닿지
# 않으므로(docker-compose.yml 참조), 필요한 것은 전부 미리 깔아 둔다.
RUN apt-get update && apt-get install -y --no-install-recommends \
        # 셸·기본 유틸
        bash coreutils findutils grep sed gawk diffutils procps util-linux \
        less vim-tiny nano file tree bc unzip zip xz-utils time \
        ca-certificates locales tini \
        # 버전 관리
        git \
        # 데이터·문서 도구
        jq sqlite3 ripgrep \
        # Python + 자주 쓰는 스택 (네트워크가 없으므로 사전 설치)
        python3 python3-pip python3-venv python3-dev \
        python3-numpy python3-pandas python3-yaml python3-requests \
        python3-dateutil python3-tabulate python3-pytest python3-redis \
        # Node.js
        nodejs npm \
        # 컴파일 툴체인
        gcc g++ make cmake pkg-config \
        # JVM / Go
        openjdk-21-jdk-headless golang-go \
    && rm -rf /var/lib/apt/lists/*

RUN sed -i 's/# C.UTF-8/C.UTF-8/' /etc/locale.gen 2>/dev/null || true

# git 은 신원이 없으면 커밋이 막힌다 — 시험 환경 기본값을 시스템 수준에 둔다
RUN git config --system user.name "Candidate" \
    && git config --system user.email "candidate@odysseus.local" \
    && git config --system init.defaultBranch main \
    && git config --system --add safe.directory '*'

# 작업 루트 — 0711 이라 경로 통과는 되지만 목록은 볼 수 없다.
# 실행마다 그 안에 0700 폴더를 만들고 실행 전용 UID 에게 넘긴다 (worker.py 참조).
RUN mkdir -p /work && chmod 711 /work

WORKDIR /app
COPY worker.py sandbox.py probe.py resources.py ./

ENTRYPOINT ["tini", "--"]
CMD ["python3", "worker.py"]

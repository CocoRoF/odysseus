"""S02 — vLLM 추론 서비스가 GPU 노드에서 죽는다 (docker compose · 고난도).

정보 분포: SRE는 증상/마감만, 모델 요구사항은 ML 엔지니어, GPU/컨테이너 런타임은
인프라 엔지니어가 안다. 셋을 다 만나야 정답이 모인다.
"""

COMPOSE = """services:
  vllm:
    image: vllm/vllm-openai:v0.6.3
    container_name: llm-inference
    command: >
      --model /models/qwen2.5-14b-instruct
      --served-model-name qwen2.5-14b
      --max-model-len 32768
      --gpu-memory-utilization 0.98
      --port 8000
    volumes:
      - /data/models:/models:ro
    ports:
      - "8000:8000"
    restart: unless-stopped

  gateway:
    image: nginx:1.27-alpine
    container_name: llm-gateway
    ports:
      - "80:80"
    volumes:
      - ./gateway.conf:/etc/nginx/conf.d/default.conf:ro
    depends_on:
      - vllm
    restart: unless-stopped
"""

GATEWAY_CONF = """upstream llm_backend {
    server vllm:8000;
}

server {
    listen 80;

    location /v1/ {
        proxy_pass http://llm_backend;
        proxy_set_header Host $host;
        proxy_read_timeout 30s;
        proxy_send_timeout 30s;
        proxy_buffering on;
    }

    location /healthz {
        return 200 'gateway ok';
    }
}
"""

VLLM_LOG = """[2026-09-01 21:04:11] INFO Starting vLLM API server v0.6.3
[2026-09-01 21:04:12] INFO args: model=/models/qwen2.5-14b-instruct max_model_len=32768 gpu_memory_utilization=0.98
[2026-09-01 21:04:13] ERROR Traceback (most recent call last):
[2026-09-01 21:04:13] ERROR   File "/usr/local/lib/python3.12/site-packages/vllm/engine/llm_engine.py", line 268, in from_engine_args
[2026-09-01 21:04:13] ERROR   File "/usr/local/lib/python3.12/site-packages/torch/cuda/__init__.py", line 305, in _lazy_init
[2026-09-01 21:04:13] ERROR RuntimeError: No CUDA GPUs are available
[2026-09-01 21:04:14] INFO Container exited with code 1, restarting (restart: unless-stopped)

--- 인프라팀이 런타임 설정을 손본 뒤 재기동 ---

[2026-09-01 22:41:02] INFO Starting vLLM API server v0.6.3
[2026-09-01 22:41:05] INFO Detected 1 CUDA device(s): NVIDIA A10 (22.5 GiB free)
[2026-09-01 22:41:09] INFO Loading model weights (bfloat16)...
[2026-09-01 22:41:41] ERROR torch.OutOfMemoryError: CUDA out of memory. Tried to allocate 1.98 GiB.
[2026-09-01 22:41:41] ERROR GPU 0 has a total capacity of 22.50 GiB of which 108.00 MiB is free.
[2026-09-01 22:41:41] ERROR Model weights take 27.51 GiB; this is more than the total GPU memory.
[2026-09-01 22:41:42] INFO Container exited with code 1, restarting (restart: unless-stopped)

--- 두 장을 쓰도록 바꿔본 뒤 ---

[2026-09-02 00:12:33] INFO Starting vLLM API server v0.6.3
[2026-09-02 00:12:36] INFO Detected 2 CUDA device(s)
[2026-09-02 00:12:37] INFO Initializing distributed environment (tensor_parallel_size=2)
[2026-09-02 00:12:52] ERROR NCCL WARN Cuda failure 'out of memory'
[2026-09-02 00:12:52] ERROR ncclSystemError: System call (e.g. socket, malloc) or external library call failed.
[2026-09-02 00:12:52] ERROR NCCL WARN Error: failed to open shared memory segment (/dev/shm too small: 64MB)
[2026-09-02 00:12:53] INFO Container exited with code 1
"""

GATEWAY_LOG = """172.19.0.1 - - [01/Sep/2026:21:05:02 +0000] "POST /v1/chat/completions HTTP/1.1" 502 157 "-" "python-httpx/0.28"
2026/09/01 21:05:02 [error] 31#31: *14 connect() failed (111: Connection refused) while connecting to upstream, upstream: "http://172.19.0.3:8000/v1/chat/completions"
172.19.0.1 - - [02/Sep/2026:00:31:44 +0000] "POST /v1/chat/completions HTTP/1.1" 504 167 "-" "python-httpx/0.28"
2026/09/02 00:31:44 [error] 31#31: *22 upstream timed out (110: Connection timed out) while reading response header from upstream
"""

NVIDIA_SMI = """Mon Sep  2 09:12:04 2026
+-----------------------------------------------------------------------------------------+
| NVIDIA-SMI 550.90.07              Driver Version: 550.90.07      CUDA Version: 12.4     |
|-----------------------------------------+------------------------+----------------------+
| GPU  Name                 Persistence-M  | Bus-Id          Disp.A | Volatile Uncorr. ECC |
| Fan  Temp   Perf          Pwr:Usage/Cap  |           Memory-Usage | GPU-Util  Compute M. |
|=========================================+========================+======================|
|   0  NVIDIA A10                      On  |   00000000:AF:00.0 Off |                    0 |
|  0%   34C    P8             18W /  150W  |       1MiB /  23028MiB |      0%      Default |
+-----------------------------------------+------------------------+----------------------+
|   1  NVIDIA A10                      On  |   00000000:D8:00.0 Off |                    0 |
|  0%   33C    P8             17W /  150W  |       1MiB /  23028MiB |      0%      Default |
+-----------------------------------------+------------------------+----------------------+
"""

NODE_MD = """# GPU 노드 (llm-gpu-01)

- CPU: AMD EPYC 7443P 24C/48T
- RAM: 128 GiB
- GPU: NVIDIA A10 24GB x 2 (PCIe, NVLink 없음)
- Driver 550.90.07 / CUDA 12.4
- Docker 27.1, nvidia-container-toolkit 1.16 설치됨
- 모델 저장소: /data/models (qwen2.5-14b-instruct, bfloat16)
- 컨테이너 기본 /dev/shm: 64MB (docker 기본값)
"""

README = """# llm-inference 스택

사내 LLM 추론 서비스. `docker compose up -d` 로 GPU 노드에 배포한다.

- `vllm` — vLLM OpenAI 호환 서버 (:8000)
- `gateway` — nginx 리버스 프록시 (:80)

배포 후 `curl localhost/v1/models` 로 확인.
"""

SCENARIO = {
    "title": "LLM 추론 서비스가 GPU 노드에서 계속 죽는다",
    "summary": "vLLM + docker compose 배포 장애 — GPU 미할당·OOM·NCCL 공유메모리·게이트웨이 타임아웃이 겹친 고난도 인프라 문제",
    "difficulty": "hard",
    "briefing_md": (
        """**새벽 3시 40분. 당직 알림이 열두 번째 울립니다.**

당신은 이번 분기에 합류한 플랫폼 엔지니어입니다. 어젯밤 팀은 새로 들여온 GPU 노드에 사내 LLM 추론 서비스를 처음으로 올렸습니다. 여덟 달을 기다린 장비였고, 오늘 오후에는 전사 데모가 예정되어 있습니다.

그런데 서비스가 뜨자마자 죽고, 다시 뜨고, 또 죽습니다. 로그는 매번 다른 말을 합니다.

온콜 SRE가 당신을 찾았습니다."""
    ),
    "agent_enabled": True,
    "characters": [
        {
            "key": "sre_haneul",
            "name": "정하늘",
            "role": "온콜 SRE",
            "color": "#ef4444",
            "persona": (
                "밤샘 대응으로 지쳐 있고 급하다. 짧게 말한다. 컨테이너/GPU 내부 사정은 잘 모르며, "
                "모델 쪽은 박지훈, 노드/런타임은 김도연에게 물어보라고 안내한다. 진행 상황 공유를 좋아한다."
            ),
            "knowledge": (
                "어젯밤 llm-gpu-01 노드에 LLM 추론 스택(docker compose)을 처음 배포했는데 서비스가 계속 죽는다. "
                "게이트웨이는 502, 나중에는 504를 뱉었다. 오늘 오후 3시 사내 데모가 있어 그 전까지 살려야 한다. "
                "산출물은 두 가지다: (1) 워크스페이스의 docker-compose.yml(과 필요하면 gateway.conf)을 고쳐 둘 것, "
                "(2) output/postmortem.md 에 원인과 재발 방지책을 정리할 것. "
                "로그는 logs/vllm.log, logs/gateway.log 에 있고 노드 정보는 infra/ 아래에 있다. "
                "모델 쪽 요구사항(컨텍스트 길이, 병렬 설정)은 박지훈(ML 플랫폼)이 제일 잘 안다. "
                "GPU를 컨테이너에 어떻게 붙이는지, /dev/shm 같은 런타임 설정은 김도연(인프라)이 안다."
            ),
        },
        {
            "key": "ml_jihoon",
            "name": "박지훈",
            "role": "ML 플랫폼 엔지니어",
            "color": "#0ea5e9",
            "persona": (
                "정확하고 수치로 말한다. 물어본 것에는 스펙 수준으로 답하지만 묻지 않은 것을 먼저 알려주지는 않는다. "
                "두루뭉술하게 물으면 '어느 부분이 궁금하세요? 모델 스펙인가요, 서빙 옵션인가요?'라고 되묻는다."
            ),
            "knowledge": (
                "서빙 모델은 Qwen2.5-14B-Instruct, bfloat16이다. 가중치만 약 27.5GB라 A10 24GB 한 장에는 절대 올라가지 않는다. "
                "두 장을 쓰려면 vLLM 옵션 --tensor-parallel-size 2 가 필요하다(이 옵션이 없으면 vLLM은 GPU 한 장만 쓴다). "
                "--gpu-memory-utilization 은 0.90 으로 둔다. 0.95 이상은 KV 캐시/단편화 여유가 없어 첫 롱컨텍스트 요청에서 OOM 난다. "
                "컨텍스트 길이는 서비스 요구상 8192 토큰이면 충분하다. 지금 설정된 32768 은 KV 캐시를 4배로 잡아먹어 유효 동시성이 무너진다. "
                "vLLM 헬스 엔드포인트는 GET /health 이고 200을 준다. 모델이 다 뜨기 전에는 응답하지 않으므로 헬스체크로 쓰기 좋다. "
                "모델 로딩에는 2~4분 걸린다. 서빙 이름(--served-model-name)이나 포트(8000)는 지금 값 그대로 두면 된다."
            ),
        },
        {
            "key": "infra_doyeon",
            "name": "김도연",
            "role": "인프라 엔지니어",
            "color": "#f59e0b",
            "persona": (
                "차분하고 근거 중심. 로그 라인을 인용해 설명한다. 모델 쪽 파라미터는 자기 소관이 아니라며 박지훈을 가리킨다."
            ),
            "knowledge": (
                "llm-gpu-01 에는 A10 24GB 두 장(0000:af:00.0, 0000:d8:00.0)이 있고 드라이버 550, nvidia-container-toolkit 1.16 이 설치돼 있다. "
                "그런데 compose 파일에 GPU 예약이 없으면 컨테이너는 GPU를 아예 못 본다 — 첫 로그의 'No CUDA GPUs are available' 이 그 증상이다. "
                "compose 에서는 서비스에 deploy.resources.reservations.devices 로 driver: nvidia, count: 2, capabilities: [gpu] 를 줘야 한다. "
                "텐서 병렬을 쓰면 NCCL 이 프로세스 간 통신에 공유 메모리를 쓰는데, 도커 컨테이너 기본 /dev/shm 은 64MB 뿐이라 세 번째 로그처럼 "
                "'failed to open shared memory segment' 로 죽는다. 서비스에 shm_size: \"8gb\" 정도를 줘야 한다. "
                "게이트웨이 502는 vLLM 이 아직 안 떴는데 nginx 가 먼저 트래픽을 보내서 생긴다. compose 의 depends_on 은 기본적으로 "
                "'컨테이너가 시작됐는가'만 보므로, vllm 에 healthcheck 를 달고 gateway 의 depends_on 을 condition: service_healthy 로 바꿔야 한다. "
                "504는 nginx proxy_read_timeout 이 30초라서다. 생성 요청은 1~2분도 걸리므로 300초 이상으로 올려야 한다. "
                "헬스체크 명령은 컨테이너 안에서 도는 것이라 wget/curl 중 이미지에 있는 걸 쓰면 된다."
            ),
        },
    ],
    "opening_messages": [
        {
            "character_key": "sre_haneul",
            "content": (
                "안녕하세요, 새벽부터 붙잡고 있는데 도저히 안 잡혀서요 🙏\n"
                "어제 GPU 노드에 새로 올린 LLM 추론 서비스가 계속 죽습니다. 게이트웨이는 502 뱉다가 지금은 504도 나와요.\n"
                "오후 3시 데모라 그 전까지는 살려야 합니다. 워크스페이스에 compose랑 로그 넣어놨어요.\n"
                "저는 컨테이너 GPU 쪽은 잘 몰라서... 모델 설정은 박지훈님, 노드/런타임은 김도연님이 잘 아세요."
            ),
        }
    ],
    "initial_files": [
        {"path": "docker-compose.yml", "content": COMPOSE},
        {"path": "gateway.conf", "content": GATEWAY_CONF},
        {"path": "README.md", "content": README},
        {"path": "logs/vllm.log", "content": VLLM_LOG},
        {"path": "logs/gateway.log", "content": GATEWAY_LOG},
        {"path": "infra/nvidia-smi.txt", "content": NVIDIA_SMI},
        {"path": "infra/node.md", "content": NODE_MD},
    ],
    "objectives_md": """## 실제 요구사항 (응시자는 대화 + 로그로 파악해야 함)

세 개의 장애가 겹쳐 있다. 로그 세 구간이 각각 다른 원인이다.

### 1) GPU가 컨테이너에 붙지 않음 — "No CUDA GPUs are available"
`docker-compose.yml` 의 `vllm` 서비스에 GPU 예약이 없다. 다음을 추가해야 한다:
```yaml
deploy:
  resources:
    reservations:
      devices:
        - driver: nvidia
          count: 2
          capabilities: [gpu]
```

### 2) 단일 GPU OOM — 모델이 A10 한 장에 안 들어감
Qwen2.5-14B bf16 가중치 ≈ 27.5GB > A10 23GB. 따라서:
- `--tensor-parallel-size 2` 추가 (없으면 vLLM은 GPU 1장만 사용)
- `--gpu-memory-utilization 0.90` (0.98 → 0.90, 0.95 초과 금지)
- `--max-model-len 8192` (32768 → 8192, KV 캐시 과다)

### 3) NCCL 공유 메모리 부족 — "/dev/shm too small: 64MB"
텐서 병렬 시 NCCL이 /dev/shm 을 쓴다. `vllm` 서비스에 `shm_size: "8gb"` (8GB 이상) 필요.

### 4) 게이트웨이 502/504
- 502: vLLM 준비 전 트래픽. `vllm` 에 healthcheck(`/health`) 추가 +
  `gateway` 의 `depends_on: {vllm: {condition: service_healthy}}`
- 504: `gateway.conf` 의 `proxy_read_timeout 30s` → **300s 이상**

### 5) 산출물
`output/postmortem.md` 에 원인 3가지 이상과 재발 방지책. 텐서 병렬/GPU 예약/shm 이 언급되어야 한다.

### 정보 분포
- 정하늘(SRE): 증상·마감·산출물 경로만. 세부는 모름.
- 박지훈(ML): 모델 크기 27.5GB, TP 2 필요, utilization 0.90, max-model-len 8192, /health.
- 김도연(인프라): GPU 2장·deploy.reservations 문법, /dev/shm 64MB → shm_size, healthcheck+service_healthy, proxy_read_timeout.
""",
    "checks": [
        {
            "label": "GPU 예약 (nvidia, count 2, gpu capability)",
            "type": "command",
            "command": (
                "python3 -c \"import yaml;d=yaml.safe_load(open('docker-compose.yml'));"
                "r=d['services']['vllm']['deploy']['resources']['reservations']['devices'][0];"
                "assert r['driver']=='nvidia';assert int(r['count'])==2;"
                "assert 'gpu' in r['capabilities'];print('OK')\""
            ),
            "expected_stdout": "OK",
            "points": 15,
        },
        {
            "label": "텐서 병렬 2",
            "type": "file_contains",
            "path": "docker-compose.yml",
            "pattern": r"--tensor-parallel-size[ =]+2\b",
            "points": 12,
        },
        {
            "label": "컨텍스트 길이 8192로 축소",
            "type": "file_contains",
            "path": "docker-compose.yml",
            "pattern": r"--max-model-len[ =]+8192\b",
            "points": 10,
        },
        {
            "label": "GPU 메모리 사용률 0.90 이하",
            "type": "file_contains",
            "path": "docker-compose.yml",
            "pattern": r"--gpu-memory-utilization[ =]+0\.9(0)?\b",
            "points": 10,
        },
        {
            "label": "NCCL용 공유 메모리 (shm_size 8g 이상)",
            "type": "file_contains",
            "path": "docker-compose.yml",
            "pattern": r"shm_size:\s*[\"']?(8|9|[1-9][0-9]+)\s*g",
            "points": 12,
        },
        {
            "label": "헬스체크 + service_healthy 의존",
            "type": "command",
            "command": (
                "python3 -c \"import yaml;d=yaml.safe_load(open('docker-compose.yml'));"
                "assert d['services']['vllm'].get('healthcheck');"
                "assert d['services']['gateway']['depends_on']['vllm']['condition']=='service_healthy';"
                "print('OK')\""
            ),
            "expected_stdout": "OK",
            "points": 13,
        },
        {
            "label": "게이트웨이 읽기 타임아웃 300s 이상",
            "type": "file_contains",
            "path": "gateway.conf",
            "pattern": r"proxy_read_timeout\s+([3-9][0-9]{2,}|[1-9][0-9]{3,})s",
            "points": 10,
        },
        {"label": "포스트모템 작성", "type": "file_exists", "path": "output/postmortem.md", "points": 8},
        {
            "label": "포스트모템에 핵심 원인 기재",
            "type": "file_contains",
            "path": "output/postmortem.md",
            "pattern": r"(tensor[- ]?parallel|텐서\s*병렬)",
            "points": 10,
        },
    ],
}

"""기본 시나리오의 **참조 해답** — 시나리오가 실제로 풀리는지 증명하는 기준.

각 항목은 {경로: 내용} 이며, 응시자가 해당 파일을 그렇게 만들었을 때
시나리오의 자동 체크가 전부 통과해야 한다 (tests/smoke/test_scenarios.py).
"""

# ── S02 vLLM docker compose ──────────────────────────────────

S02_COMPOSE = """services:
  vllm:
    image: vllm/vllm-openai:v0.6.3
    container_name: llm-inference
    command: >
      --model /models/qwen2.5-14b-instruct
      --served-model-name qwen2.5-14b
      --tensor-parallel-size 2
      --max-model-len 8192
      --gpu-memory-utilization 0.90
      --port 8000
    volumes:
      - /data/models:/models:ro
    ports:
      - "8000:8000"
    shm_size: "8gb"
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: 2
              capabilities: [gpu]
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8000/health"]
      interval: 15s
      timeout: 5s
      retries: 40
      start_period: 60s
    restart: unless-stopped

  gateway:
    image: nginx:1.27-alpine
    container_name: llm-gateway
    ports:
      - "80:80"
    volumes:
      - ./gateway.conf:/etc/nginx/conf.d/default.conf:ro
    depends_on:
      vllm:
        condition: service_healthy
    restart: unless-stopped
"""

S02_GATEWAY = """upstream llm_backend {
    server vllm:8000;
}

server {
    listen 80;

    location /v1/ {
        proxy_pass http://llm_backend;
        proxy_set_header Host $host;
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
        proxy_buffering off;
    }

    location /healthz {
        return 200 'gateway ok';
    }
}
"""

S02_POSTMORTEM = """# 포스트모템 — LLM 추론 서비스 배포 장애

## 원인 (3가지가 순차적으로 드러남)
1. **GPU 미할당**: compose 에 `deploy.resources.reservations.devices` 가 없어 컨테이너가 GPU를 보지 못함
   (`No CUDA GPUs are available`).
2. **단일 GPU OOM**: Qwen2.5-14B bf16 가중치 27.5GB > A10 23GB. tensor-parallel 미설정으로 1장만 사용.
   `--tensor-parallel-size 2` 로 2장 분할, `--gpu-memory-utilization` 0.98 → 0.90,
   `--max-model-len` 32768 → 8192 (KV 캐시 과다).
3. **NCCL 공유 메모리 부족**: 텐서 병렬 시 NCCL 이 /dev/shm 사용. 도커 기본 64MB → `shm_size: "8gb"`.

## 게이트웨이 오류
- 502: vLLM 준비 전 트래픽. healthcheck(/health) + `depends_on: condition: service_healthy` 로 해결.
- 504: `proxy_read_timeout 30s` 가 생성 시간보다 짧음 → 600s.

## 재발 방지
- GPU 워크로드 compose 템플릿에 reservations/shm_size/healthcheck 를 기본 포함.
- 배포 파이프라인에 `--tensor-parallel-size` 와 모델 크기 대비 GPU 총량 검증 단계 추가.
- 게이트웨이 타임아웃을 모델 최대 생성 시간 기준으로 설정.
"""

# ── S03 Kubernetes ───────────────────────────────────────────

S03_DEPLOYMENT = """apiVersion: apps/v1
kind: Deployment
metadata:
  name: llm-inference
  namespace: ml-serving
  labels:
    app: llm-inference
spec:
  replicas: 2
  selector:
    matchLabels:
      app: llm-inference
  template:
    metadata:
      labels:
        app: llm-inference
    spec:
      nodeSelector:
        accelerator: nvidia-a10
      tolerations:
        - key: nvidia.com/gpu
          operator: Exists
          effect: NoSchedule
      volumes:
        - name: model-cache
          persistentVolumeClaim:
            claimName: model-cache
      containers:
        - name: vllm
          image: registry.internal/vllm-openai:v0.6.3
          args:
            - --model=/models/qwen2.5-7b-instruct
            - --served-model-name=qwen2.5-7b
            - --max-model-len=8192
            - --port=8000
          ports:
            - name: http
              containerPort: 8000
          volumeMounts:
            - name: model-cache
              mountPath: /models
              readOnly: true
          resources:
            requests:
              cpu: "4"
              memory: 24Gi
              nvidia.com/gpu: 1
            limits:
              cpu: "8"
              memory: 32Gi
              nvidia.com/gpu: 1
          readinessProbe:
            httpGet:
              path: /health
              port: 8000
            initialDelaySeconds: 60
            periodSeconds: 10
            failureThreshold: 30
          livenessProbe:
            httpGet:
              path: /health
              port: 8000
            initialDelaySeconds: 120
            periodSeconds: 20
"""

S03_SERVICE = """apiVersion: v1
kind: Service
metadata:
  name: llm-inference
  namespace: ml-serving
spec:
  type: ClusterIP
  selector:
    app: llm-inference
  ports:
    - name: http
      port: 80
      targetPort: 8000
"""

S03_REPORT = """# 조치 보고 — 추론 파드 스케줄 실패

## 원인
1. GPU 노드 taint `nvidia.com/gpu=present:NoSchedule` 에 대한 toleration 없음 → Pending.
2. `nodeSelector` 미지정으로 CPU 노드에도 후보가 잡힘 (해당 노드엔 GPU 없음).
3. `resources.limits` 에 `nvidia.com/gpu` 미요청 → 디바이스 플러그인이 GPU 미할당.
4. replicas 3 이지만 GPU 노드 2대 × 1장 = 최대 2 → 1개는 영구 Pending.
5. readiness/liveness 프로브가 `/`(404), 포트 80 → 컨테이너는 8000 에서 `/health` 제공.
6. 메모리 limit 8Gi → 모델 로딩 중 OOMKilled(137). 24Gi 이상 필요.
7. Service selector `app: llm` 이 파드 레이블 `app: llm-inference` 와 불일치 → 엔드포인트 비어 있음.
   targetPort 도 80 → 8000 으로 수정.
8. model-cache PVC 미마운트 → 콜드스타트 20분. `/models` 에 마운트.

## 조치
위 8개 항목을 deployment.yaml / service.yaml 에 반영.

## 재발 방지
- GPU 워크로드 매니페스트 템플릿(toleration + nodeSelector + gpu limits) 표준화.
- CI 에서 Service selector ↔ Deployment labels 일치 검사.
"""

# ── S04 KVM ──────────────────────────────────────────────────

S04_DOMAIN = """<domain type='kvm'>
  <name>inference-node-01</name>
  <memory unit='GiB'>96</memory>
  <currentMemory unit='GiB'>96</currentMemory>
  <memoryBacking>
    <hugepages>
      <page size='1' unit='G' nodeset='0'/>
    </hugepages>
  </memoryBacking>
  <vcpu placement='static' cpuset='16-31'>16</vcpu>
  <numatune>
    <memory mode='strict' nodeset='1'/>
  </numatune>
  <os>
    <type arch='x86_64' machine='q35'>hvm</type>
    <boot dev='hd'/>
  </os>
  <features>
    <acpi/>
    <apic/>
  </features>
  <cpu mode='host-passthrough' check='none'/>
  <clock offset='utc'/>
  <devices>
    <emulator>/usr/bin/qemu-system-x86_64</emulator>
    <disk type='file' device='disk'>
      <driver name='qemu' type='qcow2' cache='none' io='native'/>
      <source file='/var/lib/libvirt/images/inference-node-01.qcow2'/>
      <target dev='vda' bus='virtio'/>
    </disk>
    <interface type='bridge'>
      <source bridge='br0'/>
      <model type='virtio'/>
    </interface>
    <hostdev mode='subsystem' type='pci' managed='yes'>
      <source>
        <address domain='0x0000' bus='0xaf' slot='0x00' function='0x0'/>
      </source>
    </hostdev>
    <hostdev mode='subsystem' type='pci' managed='yes'>
      <source>
        <address domain='0x0000' bus='0xaf' slot='0x00' function='0x1'/>
      </source>
    </hostdev>
    <console type='pty'/>
  </devices>
</domain>
"""

S04_REPORT = """# 튜닝 리포트 — GPU 패스스루 추론 VM

## 1) 부팅 실패: IOMMU 그룹 불완전 패스스루
`vfio 0000:af:00.0: group 42 is not viable`. GPU 는 af:00.0(3D) + af:00.1(Audio) 두 함수이며
둘 다 IOMMU 그룹 42 에 속한다. 그룹 내 장치를 모두 vfio 로 넘겨야 하므로 hostdev 를 두 개로 확장.

## 2) 성능 41%: 크로스 NUMA
GPU(af:00.0)의 numa_node 는 1(CPU 16-31)인데 vCPU/메모리는 노드 0 에서 잡히고 있었다.
- `<vcpu placement='static' cpuset='16-31'>`
- `<numatune><memory mode='strict' nodeset='1'/></numatune>`
게스트의 numa_miss/numa_foreign 이 높았던 것과 일치.

## 3) 휴지페이지 미사용
호스트에 1GiB 휴지페이지 96장이 예약돼 있으나 도메인이 사용하지 않아 4K 페이지로 잡히고 TLB 미스 증가.
`<memoryBacking><hugepages><page size='1' unit='G'/></hugepages></memoryBacking>` 추가.

## 4) CPU 모델 제약
`Haswell-noTSX-IBRS` → 최신 벡터 명령 미노출로 전처리/토크나이즈 지연. `host-passthrough` 로 변경.

## 기대 효과
NUMA 로컬리티 확보 + 휴지페이지 + 네이티브 CPU 명령으로 베어메탈 대비 90% 수준 회복 예상.
"""

# ── S05 게이트웨이 분석 ───────────────────────────────────────

S05_ANALYZE_PY = '''"""로그 분석 — output/analysis.json 생성 (참조 해답)."""

import csv
import json
import math
import os

rows = [json.loads(line) for line in open("data/requests.jsonl") if line.strip()]
ok = [r for r in rows if r["status"] == 200]

pricing = {}
for row in csv.DictReader(open("pricing.csv")):
    pricing[row["model"]] = (float(row["input_usd_per_1k"]), float(row["output_usd_per_1k"]))


def p95(values):
    v = sorted(values)
    return v[math.ceil(0.95 * len(v)) - 1]


out = {
    "total_requests": len(rows),
    "error_requests": len([r for r in rows if r["status"] != 200]),
    "slow_requests": len([r for r in ok if r["latency_ms"] > 2500]),
    "cache_hits": len([r for r in rows if r["cached"]]),
    "p95_latency_ms": {},
    "cost_usd": {},
    "small_eligible": len(
        [r for r in ok if r["route"] in ("chat", "extract") and r["prompt_tokens"] < 512 and not r["cached"]]
    ),
}
for model, (pin, pout) in pricing.items():
    sub = [r for r in ok if r["model"] == model]
    out["p95_latency_ms"][model] = p95([r["latency_ms"] for r in sub])
    billable = [r for r in sub if not r["cached"]]
    out["cost_usd"][model] = round(
        sum(r["prompt_tokens"] / 1000 * pin + r["completion_tokens"] / 1000 * pout for r in billable), 4
    )

os.makedirs("output", exist_ok=True)
with open("output/analysis.json", "w") as f:
    json.dump(out, f, ensure_ascii=False, indent=2)
print(json.dumps(out, ensure_ascii=False))
'''

S05_ROUTING = """# LLM 게이트웨이 라우팅 규칙
version: 1

models:
  llm-large:
    endpoint: http://vllm-large:8000/v1
  llm-small:
    endpoint: http://vllm-small:8000/v1

default_model: llm-large

rules:
  # 짧은 요청은 소형 모델로 — p95 지연과 비용을 동시에 낮춘다
  - name: short-requests-to-small
    match:
      route: [chat, extract]
      max_prompt_tokens: 512
    model: llm-small

  - name: legacy-extract-sample
    match:
      route: extract
      sample_rate: 0.14
    model: llm-small

cache:
  enabled: true
  routes: [extract]
  ttl_seconds: 900
"""

S05_REPORT = """# 추론 게이트웨이 지연·비용 분석

## 결론
- 대형 모델(llm-large) **p95 지연이 SLO(2,500ms)를 크게 초과**한다. 성공 요청의 상당수가 2.5초를 넘긴다.
- 비용의 거의 전부가 llm-large 에서 발생한다. 소형 모델 비중은 사실상 없다.
- 짧은 요청(prompt_tokens < 512, chat·extract)이 소형 모델로 옮길 수 있는 후보 물량이다.

## 근거
`output/analysis.json` 참고 — 전체/오류/지연초과/캐시 히트 수, 모델별 p95(nearest-rank),
모델별 과금 비용(캐시 히트 제외), 소형 모델 전환 후보 수.

## 조치
`config/routing.yaml` 에 `short-requests-to-small` 규칙을 레거시 규칙보다 위에 추가해
route ∈ {chat, extract} 이고 prompt_tokens ≤ 512 인 요청을 llm-small 로 보낸다.

## 기대 효과
- 후보 물량이 소형 모델로 이동하면서 대형 모델 큐 압력이 줄어 p95 와 503 이 함께 감소.
- 소형 모델 단가가 입력 1/12, 출력 1/12 수준이라 해당 물량 비용이 크게 감소.
"""

# ── S06 동시성 ───────────────────────────────────────────────

S06_WORKER = '''"""배치 임베딩 워커 (수정본).

계약: run(items) 은 입력과 같은 순서로, 같은 개수의 결과를 돌려준다.
"""

import hashlib
import random
import time
from concurrent.futures import ThreadPoolExecutor

MAX_WORKERS = 8
CHUNK_SIZE = 64


def embed(text: str) -> list[float]:
    """임베딩 서비스 호출 (모의) — 응답 시간이 들쭉날쭉하다."""
    time.sleep(random.uniform(0.0002, 0.0016))
    h = hashlib.sha256(text.encode()).digest()
    return [b / 255.0 for b in h[:8]]


def process_chunk(indexed_chunk):
    """(index, item) 목록을 처리해 (index, 결과) 목록으로 돌려준다.

    전역 상태를 건드리지 않으므로 경쟁 조건이 생기지 않는다.
    """
    out = []
    for idx, item in indexed_chunk:
        out.append((idx, {"id": item["id"], "vector": embed(item["text"])}))
    return out


def chunks(items, size):
    for i in range(0, len(items), size):
        yield items[i : i + size]


def run(items):
    """items 를 임베딩해 **입력과 같은 순서**로 결과 리스트를 돌려준다."""
    indexed = list(enumerate(items))
    results = [None] * len(items)
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        futures = [pool.submit(process_chunk, c) for c in chunks(indexed, CHUNK_SIZE)]
        for fut in futures:
            for idx, value in fut.result():
                results[idx] = value
    return results


if __name__ == "__main__":
    import json

    with open("data/items.jsonl") as f:
        data = [json.loads(line) for line in f if line.strip()]
    out = run(data)
    print(f"입력 {len(data)}건 / 출력 {len(out)}건")
'''

S06_ROOT_CAUSE = """# 원인 분석 — 야간 임베딩 배치 결과 유실

## 1) 청크 경계 off-by-one (결정적 누락)
`chunks()` 가 `items[i : i + size - 1]` 을 잘라 청크마다 1건씩 빠뜨렸다.
1,000건 / 64 → 16청크 × 1건 = **16건 상시 누락**. 8/29 개수 부족의 직접 원인.

## 2) 공유 상태 경쟁 조건 (비결정적 중복/유실)
`processed_ids` 에 대한 '확인 후 추가'와 `results.append` 가 원자적이지 않다.
여러 스레드가 동시에 같은 검사를 통과하거나, 완료 순서대로 결과가 쌓여
**입력 순서가 보장되지 않는다**. 8/30 의 "벡터가 다른 문서 것" 은 순서 뒤섞임 때문이다.
날마다 결과가 달랐던 것도 스레드 스케줄링에 의존했기 때문(레이스).

## 3) 완료 대기 누락
`pool.submit()` 결과(future)를 기다리지 않고 `with` 블록 안에서 `results` 를 반환해
미완료 상태가 반환될 수 있었다.

## 조치
- 청크를 `items[i : i + size]` 로 수정.
- 워커는 전역 상태를 건드리지 않고 (index, 결과) 를 반환하도록 변경, 호출자가
  미리 크기를 잡은 리스트에 인덱스로 채워 **순서를 보장**.
- 모든 future 의 `result()` 를 받아 완료를 명시적으로 대기.
- 병렬(8 스레드)은 유지 — 1,000건 처리 시간은 SLA(10초) 내.
"""

REFERENCE_SOLUTIONS: dict[str, dict[str, str]] = {
    "LLM 추론 서비스가 GPU 노드에서 계속 죽는다": {
        "docker-compose.yml": S02_COMPOSE,
        "gateway.conf": S02_GATEWAY,
        "output/postmortem.md": S02_POSTMORTEM,
    },
    "쿠버네티스 추론 파드가 스케줄되지 않는다": {
        "k8s/deployment.yaml": S03_DEPLOYMENT,
        "k8s/service.yaml": S03_SERVICE,
        "output/fix-report.md": S03_REPORT,
    },
    "GPU 패스스루 추론 VM이 느리고 가끔 부팅에 실패한다": {
        "vm/inference-node.xml": S04_DOMAIN,
        "output/tuning-report.md": S04_REPORT,
    },
    "추론 게이트웨이가 SLO를 못 맞추고 비용도 넘겼다": {
        "analyze.py": S05_ANALYZE_PY,
        "config/routing.yaml": S05_ROUTING,
        "output/report.md": S05_REPORT,
    },
    "야간 임베딩 배치가 결과를 흘린다": {
        "worker.py": S06_WORKER,
        "output/root-cause.md": S06_ROOT_CAUSE,
    },
}

#: 해답 적용 후 실행해야 하는 명령 (산출물을 코드로 만들어야 하는 시나리오)
REFERENCE_COMMANDS: dict[str, list[str]] = {
    "추론 게이트웨이가 SLO를 못 맞추고 비용도 넘겼다": ["python3 analyze.py"],
    "주간 매출 리포트 이상": ["python3 report.py"],
}

#: S01 은 스크립트 자체를 고쳐야 한다 (참조 해답)
REFERENCE_SOLUTIONS["주간 매출 리포트 이상"] = {
    "report.py": '''import csv
import os

START, END = "2026-08-24", "2026-08-30"


def main():
    total_by_date = {}
    count_by_date = {}
    with open("data/orders.csv") as f:
        for row in csv.DictReader(f):
            if row["status"] != "paid":
                continue
            d = row["date"]
            if d < START or d > END:
                continue
            total_by_date[d] = total_by_date.get(d, 0) + int(row["amount"])
            count_by_date[d] = count_by_date.get(d, 0) + 1
    os.makedirs("output", exist_ok=True)
    with open("output/weekly_report.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["date", "total_amount", "order_count"])
        for d in sorted(total_by_date):
            w.writerow([d, total_by_date[d], count_by_date[d]])
    print("리포트 생성 완료: output/weekly_report.csv")


if __name__ == "__main__":
    main()
'''
}

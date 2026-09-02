"""S03 — Kubernetes 추론 배포가 스케줄되지 않는다 (k8s · 고난도)."""

DEPLOYMENT = """apiVersion: apps/v1
kind: Deployment
metadata:
  name: llm-inference
  namespace: ml-serving
  labels:
    app: llm-inference
spec:
  replicas: 3
  selector:
    matchLabels:
      app: llm-inference
  template:
    metadata:
      labels:
        app: llm-inference
    spec:
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
          resources:
            requests:
              cpu: "4"
              memory: 8Gi
            limits:
              cpu: "8"
              memory: 8Gi
          readinessProbe:
            httpGet:
              path: /
              port: 80
            initialDelaySeconds: 5
            periodSeconds: 5
          livenessProbe:
            httpGet:
              path: /
              port: 80
            initialDelaySeconds: 10
"""

SERVICE = """apiVersion: v1
kind: Service
metadata:
  name: llm-inference
  namespace: ml-serving
spec:
  type: ClusterIP
  selector:
    app: llm
  ports:
    - name: http
      port: 80
      targetPort: 80
"""

PVC = """apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: model-cache
  namespace: ml-serving
spec:
  accessModes:
    - ReadOnlyMany
  storageClassName: nfs-models
  resources:
    requests:
      storage: 200Gi
"""

DESCRIBE = """Name:             llm-inference-7c9f4d8b6-2xk4p
Namespace:        ml-serving
Status:           Pending
Events:
  Type     Reason            Age    From               Message
  ----     ------            ----   ----               -------
  Warning  FailedScheduling  2m14s  default-scheduler  0/5 nodes are available:
             3 node(s) didn't match Pod's node affinity/selector,
             2 node(s) had untolerated taint {nvidia.com/gpu: present},
             preemption: 0/5 nodes are available.

Name:             llm-inference-7c9f4d8b6-9wq7m
Namespace:        ml-serving
Status:           CrashLoopBackOff
Last State:       Terminated
  Reason:         OOMKilled
  Exit Code:      137
Events:
  Warning  Unhealthy  40s (x8 over 2m)  kubelet  Readiness probe failed:
             HTTP probe failed with statuscode: 404
  Warning  BackOff    12s               kubelet  Back-off restarting failed container
"""

NODES = """NAME            STATUS   ROLES    AGE   VERSION   LABELS
worker-cpu-01   Ready    <none>   88d   v1.30.4   kubernetes.io/os=linux
worker-cpu-02   Ready    <none>   88d   v1.30.4   kubernetes.io/os=linux
worker-cpu-03   Ready    <none>   88d   v1.30.4   kubernetes.io/os=linux
worker-gpu-01   Ready    <none>   41d   v1.30.4   kubernetes.io/os=linux,accelerator=nvidia-a10
worker-gpu-02   Ready    <none>   41d   v1.30.4   kubernetes.io/os=linux,accelerator=nvidia-a10

$ kubectl describe node worker-gpu-01 | grep -A3 Taints
Taints:  nvidia.com/gpu=present:NoSchedule

$ kubectl get nodes -o custom-columns=NAME:.metadata.name,GPU:.status.allocatable.'nvidia\\.com/gpu'
NAME            GPU
worker-cpu-01   <none>
worker-cpu-02   <none>
worker-cpu-03   <none>
worker-gpu-01   1
worker-gpu-02   1
"""

ENDPOINTS = """$ kubectl get endpoints llm-inference -n ml-serving
NAME            ENDPOINTS   AGE
llm-inference   <none>      2m

$ kubectl get pods -n ml-serving --show-labels
NAME                             READY   STATUS             LABELS
llm-inference-7c9f4d8b6-2xk4p    0/1     Pending            app=llm-inference,pod-template-hash=7c9f4d8b6
llm-inference-7c9f4d8b6-9wq7m    0/1     CrashLoopBackOff   app=llm-inference,pod-template-hash=7c9f4d8b6
llm-inference-7c9f4d8b6-lm2vt    0/1     Pending            app=llm-inference,pod-template-hash=7c9f4d8b6
"""

RUNBOOK = """# ml-serving 네임스페이스 운영 메모

- 배포: `kubectl apply -f k8s/`
- 모델 캐시는 NFS PVC(model-cache)로 공유한다. 마운트하지 않으면 파드마다
  200GB를 다시 내려받아 콜드스타트가 20분 넘게 걸린다.
- GPU 노드는 전용 노드풀이며 일반 워크로드가 올라오지 못하게 막아 두었다.
"""

SCENARIO = {
    "title": "쿠버네티스 추론 파드가 스케줄되지 않는다",
    "summary": "k8s GPU 워크로드 배포 실패 — taint/toleration·GPU 리소스·프로브·서비스 셀렉터·PVC가 모두 얽힌 고난도 문제",
    "difficulty": "hard",
    "briefing_md": (
        "스테이징 쿠버네티스에 추론 서비스를 올렸는데 파드가 뜨지 않습니다.\n\n"
        "**메신저**를 확인하세요. 매니페스트와 `kubectl` 출력은 워크스페이스에 있습니다."
    ),
    "agent_enabled": True,
    "characters": [
        {
            "key": "sre_sera",
            "name": "오세라",
            "role": "온콜 SRE",
            "color": "#ef4444",
            "persona": (
                "실무적이고 빠르다. kubectl 출력은 붙여줄 수 있지만 GPU 노드풀 정책이나 모델 요구사항은 모른다. "
                "클러스터 정책은 한지민, 컨테이너/모델 쪽은 박지훈에게 물어보라고 안내한다."
            ),
            "knowledge": (
                "스테이징 클러스터 ml-serving 네임스페이스에 추론 서비스를 배포했는데 파드 3개 중 2개는 Pending, 1개는 CrashLoopBackOff 다. "
                "서비스 엔드포인트도 비어 있어서 호출이 아예 안 된다. 관련 출력은 logs/ 아래에 넣어뒀다(kubectl-describe-pod.txt, "
                "kubectl-get-nodes.txt, kubectl-endpoints.txt). 매니페스트는 k8s/ 아래에 있다. "
                "고쳐야 할 대상은 k8s/deployment.yaml 과 k8s/service.yaml 이고, 정리는 output/fix-report.md 에 남겨달라. "
                "내일 오전 QA 가 붙어야 해서 오늘 안에 끝내야 한다. "
                "GPU 노드풀 정책(테인트/레이블)은 한지민(플랫폼)이, 컨테이너 헬스 경로나 메모리 요구량은 박지훈(ML)이 안다."
            ),
        },
        {
            "key": "platform_jimin",
            "name": "한지민",
            "role": "플랫폼(쿠버네티스) 관리자",
            "color": "#8b5cf6",
            "persona": (
                "정책에 엄격하다. '왜 그렇게 해야 하는지'까지 짧게 덧붙인다. 매니페스트를 대신 써주지는 않는다."
            ),
            "knowledge": (
                "GPU 노드는 worker-gpu-01, worker-gpu-02 두 대뿐이고 각각 nvidia.com/gpu 할당 가능 수량이 1이다. "
                "즉 이 서비스는 최대 replicas 2 까지만 뜬다(3은 영원히 Pending). "
                "GPU 노드에는 taint 'nvidia.com/gpu=present:NoSchedule' 이 걸려 있어서 파드에 대응하는 toleration 이 없으면 스케줄되지 않는다. "
                "또 GPU 노드에만 올라가도록 nodeSelector 로 accelerator: nvidia-a10 을 지정해야 한다(CPU 노드에는 이 레이블이 없다). "
                "GPU 를 실제로 할당받으려면 컨테이너 resources.limits 에 nvidia.com/gpu: 1 을 명시해야 한다 — 이게 없으면 "
                "디바이스 플러그인이 GPU 를 붙여주지 않는다. "
                "서비스 엔드포인트가 비는 건 십중팔구 셀렉터 불일치다. 파드 레이블은 app=llm-inference 인데 서비스 셀렉터가 다르면 아무것도 안 잡힌다. "
                "모델 캐시 PVC(model-cache)는 이미 만들어 뒀으니 파드에 마운트만 하면 된다 — 마운트 경로는 박지훈에게 확인해라."
            ),
        },
        {
            "key": "ml_jihoon",
            "name": "박지훈",
            "role": "ML 플랫폼 엔지니어",
            "color": "#0ea5e9",
            "persona": "정확하고 수치로 말한다. 물어본 것만 답한다.",
            "knowledge": (
                "이미지의 vLLM 서버는 8000 포트에서 뜨고 헬스 엔드포인트는 GET /health 다. 루트(/)는 404 라서 프로브로 쓰면 안 된다. "
                "readiness/liveness 프로브는 path /health, port 8000 으로 잡아야 한다. 모델 로딩이 오래 걸리므로 "
                "initialDelaySeconds 는 60 이상, failureThreshold 를 넉넉히 주는 편이 좋다. "
                "Qwen2.5-7B 는 GPU 메모리 외에 호스트 메모리도 쓴다 — 모델 로딩/토크나이저/워커 때문에 컨테이너 메모리 limit 은 최소 24Gi 가 필요하다. "
                "현재 8Gi 라서 로딩 중 OOMKilled(exit 137) 가 난다. "
                "모델 캐시 PVC 는 컨테이너의 /models 경로에 마운트해야 한다. args 의 --model 경로가 /models/qwen2.5-7b-instruct 이기 때문이다. "
                "서비스 포트는 80 으로 두되 targetPort 는 컨테이너 포트 8000 이어야 한다."
            ),
        },
    ],
    "opening_messages": [
        {
            "character_key": "sre_sera",
            "content": (
                "스테이징 k8s에 추론 서비스 올렸는데 파드가 안 떠요 😵\n"
                "3개 중 2개는 Pending, 1개는 CrashLoopBackOff고 서비스 엔드포인트도 비어 있습니다.\n"
                "k8s/ 아래 매니페스트랑 logs/ 아래 kubectl 출력 넣어놨어요. 내일 오전 QA라 오늘 안엔 끝내야 합니다.\n"
                "클러스터 정책은 한지민님, 컨테이너 쪽은 박지훈님이 잘 아세요."
            ),
        }
    ],
    "initial_files": [
        {"path": "k8s/deployment.yaml", "content": DEPLOYMENT},
        {"path": "k8s/service.yaml", "content": SERVICE},
        {"path": "k8s/pvc.yaml", "content": PVC},
        {"path": "logs/kubectl-describe-pod.txt", "content": DESCRIBE},
        {"path": "logs/kubectl-get-nodes.txt", "content": NODES},
        {"path": "logs/kubectl-endpoints.txt", "content": ENDPOINTS},
        {"path": "RUNBOOK.md", "content": RUNBOOK},
    ],
    "objectives_md": """## 실제 요구사항

`k8s/deployment.yaml` 과 `k8s/service.yaml` 을 고쳐야 한다. 문제는 6가지다.

1. **GPU 리소스 미요청** — 컨테이너 `resources.limits` 에 `nvidia.com/gpu: 1` 추가.
2. **taint 미허용** — GPU 노드 taint `nvidia.com/gpu=present:NoSchedule` 에 대응하는 `tolerations` 추가
   (key `nvidia.com/gpu`, operator Exists 또는 Equal+value present, effect NoSchedule).
3. **노드 선택 없음** — `nodeSelector: {accelerator: nvidia-a10}`.
4. **replicas 과다** — GPU 노드 2대 × GPU 1장 = 최대 2. `replicas: 2` (또는 그 이하).
5. **프로브 경로/포트 오류** — readiness/liveness `path: /health`, `port: 8000` (현재 `/`, 80 → 404).
6. **메모리 부족** — `limits.memory` 8Gi → **24Gi 이상** (OOMKilled exit 137).
7. **서비스 셀렉터 불일치** — `service.yaml` 의 `selector` 를 `app: llm-inference` 로, `targetPort: 8000`.
8. **모델 캐시 PVC 미마운트** — `model-cache` PVC 를 `/models` 에 마운트(volumes + volumeMounts).

산출물: `output/fix-report.md` 에 원인과 조치를 정리.

### 정보 분포
- 오세라(SRE): 증상·산출물 경로·마감. 정책/스펙은 모름.
- 한지민(플랫폼): GPU 노드 2대·각 1장, taint/toleration, nodeSelector 레이블, nvidia.com/gpu limits, 셀렉터 불일치, PVC 존재.
- 박지훈(ML): /health·8000, 메모리 24Gi, PVC 마운트 경로 /models, targetPort 8000.
""",
    "checks": [
        {
            "label": "GPU 리소스 + toleration + nodeSelector",
            "type": "command",
            "command": (
                "python3 -c \"import yaml;d=yaml.safe_load(open('k8s/deployment.yaml'));"
                "s=d['spec']['template']['spec'];c=s['containers'][0];"
                "assert str(c['resources']['limits']['nvidia.com/gpu'])=='1';"
                "assert any(t.get('key')=='nvidia.com/gpu' for t in s.get('tolerations',[]));"
                "assert s['nodeSelector']['accelerator']=='nvidia-a10';print('OK')\""
            ),
            "expected_stdout": "OK",
            "points": 16,
        },
        {
            "label": "프로브 경로/포트 + replicas + 메모리",
            "type": "command",
            "command": (
                "python3 -c \"import yaml;d=yaml.safe_load(open('k8s/deployment.yaml'));"
                "sp=d['spec'];c=sp['template']['spec']['containers'][0];p=c['readinessProbe']['httpGet'];"
                "assert p['path']=='/health';assert int(p['port'])==8000;assert int(sp['replicas'])<=2;"
                "assert int(str(c['resources']['limits']['memory']).replace('Gi',''))>=24;print('OK')\""
            ),
            "expected_stdout": "OK",
            "points": 16,
        },
        {
            "label": "서비스 셀렉터/타깃포트 일치",
            "type": "command",
            "command": (
                "python3 -c \"import yaml;d=yaml.safe_load(open('k8s/deployment.yaml'));"
                "s=yaml.safe_load(open('k8s/service.yaml'));L=d['spec']['template']['metadata']['labels'];"
                "sel=s['spec']['selector'];assert sel and all(L.get(k)==v for k,v in sel.items());"
                "assert int(s['spec']['ports'][0]['targetPort'])==8000;print('OK')\""
            ),
            "expected_stdout": "OK",
            "points": 14,
        },
        {
            "label": "모델 캐시 PVC 마운트 (/models)",
            "type": "command",
            "command": (
                "python3 -c \"import yaml;d=yaml.safe_load(open('k8s/deployment.yaml'));"
                "s=d['spec']['template']['spec'];v=s['volumes'][0];"
                "assert v['persistentVolumeClaim']['claimName']=='model-cache';"
                "assert any(m['mountPath']=='/models' for m in s['containers'][0]['volumeMounts']);print('OK')\""
            ),
            "expected_stdout": "OK",
            "points": 14,
        },
        {"label": "조치 보고서 작성", "type": "file_exists", "path": "output/fix-report.md", "points": 8},
        {
            "label": "보고서에 스케줄링 원인 기재",
            "type": "file_contains",
            "path": "output/fix-report.md",
            "pattern": r"(toleration|테인트|taint)",
            "points": 10,
        },
    ],
}

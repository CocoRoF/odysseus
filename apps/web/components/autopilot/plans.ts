/** 자동 진행 계획 — 사람이 하듯 묻고, 읽고, 고치고, 확인하고, 보고하는 순서.
 *
 *  계획은 화면 조작의 목록이다. 실행은 Autopilot.tsx 가 한다: 커서를 움직여 누르고, 사람 속도로 치고,
 *  동료의 답장과 에이전트의 작업이 끝나기를 기다린다. 동료의 답은 매번 다르므로 계획은 답의 내용에 기대지 않는다.
 *
 *  쿠버네티스 시나리오(s03_k8s_inference)의 고친 매니페스트는 그 시나리오의 자동 체크 6개를 모두 통과하는지
 *  로컬에서 체크 명령 그대로 돌려 확인했다(2026-10-17). 시나리오의 매니페스트가 바뀌면 이 계획도 함께 고친다.
 */
import { AUTOPILOT_EXAM_TITLE } from "./catalog";

export type Step =
  /** 시작 브리핑(시네마틱 또는 카드)을 읽고 업무를 시작한다. 이미 데스크톱이면 건너뛴다. */
  | { kind: "intro"; say: string }
  /** 메신저로 한 사람에게 묻고 답장을 기다린다 */
  | { kind: "ask"; say: string; who: string; text: string }
  /** IDE 에서 파일들을 차례로 연다 */
  | { kind: "read"; say: string; files: string[] }
  /** IDE 에서 파일 하나를 고쳐 쓰고 저장한다 */
  | { kind: "edit"; say: string; path: string; content: string }
  /** 터미널에서 명령을 차례로 실행한다 */
  | { kind: "term"; say: string; cmds: string[] }
  /** AI 에이전트에게 맡기고 끝나기를 기다린다 */
  | { kind: "agent"; say: string; text: string }
  /** 문서 앱에서 새 문서를 만들어 쓰고 저장한다 */
  | { kind: "doc"; say: string; path: string; content: string }
  /** 시험을 종료하고 제출한다 */
  | { kind: "submit"; say: string };

export type Plan = { title: string; steps: Step[] };

const K8S_DEPLOYMENT = `apiVersion: apps/v1
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
          operator: Equal
          value: present
          effect: NoSchedule
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
              memory: 24Gi
            limits:
              cpu: "8"
              memory: 24Gi
              nvidia.com/gpu: 1
          volumeMounts:
            - name: model-cache
              mountPath: /models
              readOnly: true
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
            failureThreshold: 6
      volumes:
        - name: model-cache
          persistentVolumeClaim:
            claimName: model-cache
            readOnly: true
`;

const K8S_SERVICE = `apiVersion: v1
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
`;

const K8S_REPORT = `# 조치 보고: ml-serving 추론 배포 장애

- 증상: 파드 3개 중 2개 Pending, 1개 CrashLoopBackOff(OOMKilled), 서비스 엔드포인트 비어 있음
- 범위: k8s/deployment.yaml, k8s/service.yaml

## 원인
1. 스케줄링: GPU 노드에 taint nvidia.com/gpu=present:NoSchedule 이 걸려 있는데 파드에 toleration 이 없었고, GPU 노드를 고르는 nodeSelector 도, GPU 요청(limits nvidia.com/gpu)도 없었다.
2. 용량: GPU 노드는 2대이고 각각 GPU 1장이라 replicas 3 가운데 하나는 끝내 Pending 이다.
3. 재시작: 컨테이너 메모리 limit 8Gi 가 모델 로딩에 모자라 OOMKilled(exit 137) 가 났다.
4. 프로브: readiness·liveness 가 경로 / 와 포트 80 을 봤다. vLLM 의 헬스 경로는 8000 포트의 /health 라 404 로 실패했다.
5. 서비스: 셀렉터가 app: llm 이라 파드 레이블(app: llm-inference)을 잡지 못했고, targetPort 도 80 이었다.
6. 모델 캐시: model-cache PVC 를 마운트하지 않아 파드마다 모델을 다시 받아야 했다.

## 조치
- deployment.yaml: replicas 2, nodeSelector accelerator: nvidia-a10, toleration 추가, limits nvidia.com/gpu: 1, 메모리 24Gi, 프로브 /health:8000(initialDelaySeconds 60·120, failureThreshold 넉넉히), model-cache PVC 를 /models 에 마운트
- service.yaml: selector app: llm-inference, targetPort 8000

## 확인 방법
- kubectl apply -f k8s/ 뒤 kubectl get pods -n ml-serving 에서 2개가 Running
- kubectl get endpoints llm-inference -n ml-serving 에 파드 IP 2개
`;

const K8S: Plan = {
  title: AUTOPILOT_EXAM_TITLE,
  steps: [
    { kind: "intro", say: "브리핑을 읽고 업무를 시작합니다" },
    {
      kind: "ask",
      say: "온콜 SRE 오세라에게 고칠 대상과 남길 결과물을 확인합니다",
      who: "오세라",
      text:
        "세라님, 지금 바로 볼게요. 고칠 대상이 k8s/deployment.yaml 과 service.yaml 맞을까요? " +
        "따로 남겨야 할 결과물이 있으면 어디에 어떤 형식으로 두면 될지도 알려 주세요.",
    },
    {
      kind: "read",
      say: "IDE 에서 kubectl 출력과 매니페스트를 읽습니다",
      files: [
        "logs/kubectl-describe-pod.txt",
        "logs/kubectl-get-nodes.txt",
        "logs/kubectl-endpoints.txt",
        "k8s/deployment.yaml",
        "k8s/service.yaml",
      ],
    },
    {
      kind: "ask",
      say: "플랫폼 관리자 한지민에게 GPU 노드 정책을 묻습니다",
      who: "한지민",
      text:
        "지민님, ml-serving 추론 파드가 Pending 이라 여쭤봅니다. 이벤트에 GPU 노드의 taint 를 허용하지 않았다는 것과 " +
        "node affinity/selector 가 맞지 않는다는 메시지가 함께 나옵니다. GPU 노드에 올리려면 매니페스트에 무엇이 있어야 하는지, " +
        "GPU 노드가 몇 대인지, 서비스 엔드포인트가 비어 있는 이유도 짚어 주실 수 있을까요?",
    },
    {
      kind: "ask",
      say: "ML 엔지니어 박지훈에게 컨테이너 요구사항을 묻습니다",
      who: "박지훈",
      text:
        "지훈님, 떠 있는 파드 하나가 OOMKilled(exit 137)로 재시작하고 readiness 프로브는 404 로 실패합니다. " +
        "vLLM 컨테이너의 헬스 경로와 포트, 필요한 메모리, 모델 캐시 PVC 를 어느 경로에 마운트해야 하는지 알려 주실 수 있을까요?",
    },
    {
      kind: "edit",
      say: "deployment.yaml 을 고칩니다 (GPU 요청·toleration·nodeSelector·replicas·프로브·메모리·PVC)",
      path: "k8s/deployment.yaml",
      content: K8S_DEPLOYMENT,
    },
    {
      kind: "edit",
      say: "service.yaml 의 셀렉터와 타깃 포트를 고칩니다",
      path: "k8s/service.yaml",
      content: K8S_SERVICE,
    },
    {
      kind: "term",
      say: "터미널에서 고친 값을 확인합니다",
      cmds: [
        "python3 -c \"import yaml;d=yaml.safe_load(open('k8s/deployment.yaml'))['spec'];s=d['template']['spec'];c=s['containers'][0];" +
          "print('replicas',d['replicas']);print('limits',c['resources']['limits']);print('toleration',s['tolerations'][0]['key']);" +
          "print('probe',c['readinessProbe']['httpGet'])\"",
        "grep -n -A2 'selector\\|targetPort' k8s/service.yaml",
      ],
    },
    {
      kind: "agent",
      say: "AI 에이전트에게 로그와 대조해 빠진 것이 없는지 맡깁니다",
      text:
        "k8s/deployment.yaml 과 k8s/service.yaml 을 logs/ 아래 kubectl 출력과 대조해서, Pending·OOMKilled·프로브 404·빈 엔드포인트가 " +
        "이번 수정으로 모두 해결되는지 점검해 줘. 빠진 게 있으면 알려 줘.",
    },
    {
      kind: "doc",
      say: "output/fix-report.md 에 원인과 조치를 정리합니다",
      path: "output/fix-report.md",
      content: K8S_REPORT,
    },
    {
      kind: "ask",
      say: "오세라에게 결과를 보고합니다",
      who: "오세라",
      text:
        "세라님, 수정 끝났습니다. 원인은 GPU 노드 taint 를 허용하는 toleration 과 nodeSelector, GPU 요청이 빠진 것, GPU 가 2장인데 replicas 3, " +
        "메모리 8Gi 로 인한 OOMKilled, 프로브 경로와 포트 오류, 서비스 셀렉터 불일치였습니다. deployment.yaml 과 service.yaml 을 고쳤고 " +
        "정리는 output/fix-report.md 에 있습니다. apply 하신 뒤 파드 2개가 Running 이고 엔드포인트가 잡히는지 확인 부탁드립니다.",
    },
    { kind: "submit", say: "시험을 종료하고 제출합니다" },
  ],
};

export const PLANS: Plan[] = [K8S];

export function planFor(title: string | null | undefined): Plan | null {
  return PLANS.find((p) => p.title === title) ?? null;
}

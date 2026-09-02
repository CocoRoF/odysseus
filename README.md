# Odysseus

**실무 시뮬레이션 기반 개발자 평가 플랫폼** — 문제는 지문으로 주어지지 않습니다. 응시자는 OS 데스크톱을 닮은 시험 환경에서 **메신저로 관계자와 대화하며 스스로 요구사항을 파악**하고, IDE·터미널·AI 에이전트로 실제 산출물을 만들어야 합니다.

```
git clone https://github.com/CocoRoF/odysseus.git
cd odysseus
docker compose up -d --build
# → http://localhost:3100  (admin@odysseus.dev / admin1234)
```

## 컨셉

전통적 코딩 테스트는 "정리된 문제"를 줍니다. 실제 업무는 그렇지 않습니다 — 요구사항은 흩어져 있고, 물어봐야 나오고, 산출물로 증명해야 합니다. Odysseus의 시험은 하나의 **시나리오(가상 업무 상황)**입니다:

```
[메신저를 연다] → PM의 다급한 메시지가 와 있다
   ↓ 대화로 증상·마감·담당자를 파악
[데이터 엔지니어에게 스키마와 집계 규칙을 캐묻는다]
[QA의 재현 사례로 가설을 검증한다]
   ↓
[IDE에서 버그난 스크립트를 고치고, 터미널로 실행해 확인]
[필요하면 AI 에이전트에게 파일 작업을 맡긴다]
   ↓
[산출물 파일 생성 → PM에게 완료 보고]
```

전 과정(대화·파일 편집·실행·에이전트 사용·화면 이탈)이 기록되고, **자동 체크 + LLM 루브릭 평가**로 채점됩니다. 핵심 평가축은 "요구사항을 얼마나 정확히 파악해 냈는가"입니다.

## 시험 환경 (데스크톱)

응시 화면은 4개의 앱을 가진 웹 데스크톱입니다 (창 드래그/리사이즈/최소화/최대화):

| 앱 | 역할 |
|---|---|
| **메신저** | 등장인물(NPC)별 스레드. 각 인물은 페르소나와 **자신이 아는 것**만 가진 LLM — 좋은 질문이 좋은 정보를 얻는다 |
| **IDE** | VSCode풍 — 파일 트리 + Monaco 에디터 + 터미널(샌드박스 실행, 산출물 파일이 워크스페이스에 반영) |
| **AI 에이전트** | 파일을 읽고·쓰고·실행할 수 있는 어시스턴트. 시나리오 정보는 모름(제로 컨텍스트) — 무엇을 어떻게 시켰는지가 그대로 평가 데이터 |
| **폴더** | 워크스페이스 탐색기 + 미리보기(CSV 표·Markdown·코드) |

## 시나리오 스튜디오 (관리자)

문제 상황 전체를 설계하는 편집기:

- **등장인물** — 이름/직함/페르소나 + `knowledge`(물어보면 답할 수 있는 정보의 전부). 요구사항을 인물별로 분산 배치
- **오프닝 메시지** — 응시 시작 시 도착해 있는 메시지 (응시자의 유일한 출발점)
- **초기 파일** — 워크스페이스 초기 상태 (데이터·버그 코드·문서)
- **숨은 요구사항(objectives)** — 정답 정의. NPC의 배경 지식 + 자동평가 기준으로만 쓰이며 응시자에게 절대 노출되지 않음
- **자동 체크** — `file_exists` / `file_contains`(정규식) / `command`(샌드박스 실행) 로 산출물 검증
- **루브릭** — 과정(요구사항 파악·커뮤니케이션·작업 과정) / 결과(요구 충족·구현 품질) LLM 평가 기준

## 아키텍처

```
            ┌──────────┐
 :3100 ───► │   edge   │ ── /api (SSE 무버퍼) ──► ┌──────────┐   LPUSH    ┌───────────┐
            │  nginx   │ ── /                ──► │   api    │ ─────────► │  runner   │
            └──────────┘      ┌──────────┐       │ FastAPI  │   Redis    │ (sandbox) │
                              │   web    │       └────┬─────┘ ◄───────── └───────────┘
                              │ Next.js  │            │      콜백(HTTP, 파일 diff 포함)
                              └──────────┘       PostgreSQL
```

| 서비스 | 스택 | 역할 |
|---|---|---|
| `edge` | nginx | 단일 오리진 — `/api`(SSE 무버퍼)와 웹 라우팅 |
| `web` | Next.js 15, Tailwind v4, Monaco | 데스크톱 시험 환경 / 스튜디오 / 리뷰 UI |
| `api` | FastAPI, SQLAlchemy(async), geny-executor llm_client | 인증, 시나리오/시험 CRUD, NPC·에이전트 LLM, 워크스페이스(단일 진실=DB), 자동평가 |
| `runner` | Python + rlimit 샌드박스 | 워크스페이스를 물질화해 명령 실행, **파일 변경분을 되돌려 반영** |
| `postgres` / `redis` | 16-alpine / 7-alpine | 저장소 / 실행 큐 |

- **워크스페이스** = DB가 단일 진실. IDE 저장·에이전트 도구·실행 결과 파일 반영이 한 곳에서 만나 전부 이벤트 로그로 남는다.
- **LLM 공급자**: OpenAI / Anthropic / Gemini / vLLM / Ollama / LM Studio / OpenAI 호환 / **Claude Code CLI(순수 LLM 잠금)** — 관리자 설정에서 관리하고, 시험별로 NPC·에이전트 공급자를 따로 지정 가능.

## 설정

```bash
cp .env.example .env   # 필요 시 수정 (없어도 기본값으로 기동)
```

| 변수 | 설명 |
|---|---|
| `AI_BASE_URL` / `AI_API_KEY` | OpenAI 호환 폴백 (관리자 설정에서 공급자 등록을 권장) |
| `JWT_SECRET` / `INTERNAL_TOKEN` | 운영 배포 시 반드시 교체 (`openssl rand -hex 32`) |
| `SEED_DEMO_DATA` | 최초 기동 시 데모 계정/시나리오/시험 생성 (기본 true) |
| `WEB_PORT` / `API_PORT` | 기본 3100 / 8100 |

데모 계정: `admin@odysseus.dev/admin1234`, `evaluator@odysseus.dev/eval1234`, `candidate@odysseus.dev/cand1234`

## 스모크 테스트

```bash
python3 tests/smoke/mock_llm.py &     # :18011 모의 LLM (NPC/에이전트/평가)
# 게이트웨이: docker network inspect odysseus_default -f '{{(index .IPAM.Config 0).Gateway}}'
python3 tests/smoke/test_core.py "http://<gateway>:18011/v1"
```

## License

MIT

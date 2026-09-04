# Odysseus — 개발·운영 안내

제품 소개는 [README](../README.md)에 있습니다. 여기는 만들고 굴리는 사람을 위한 문서입니다.

## 격리

러너 컨테이너 하나를 모든 응시자가 공유하지만, 실행 한 건은 세 겹으로 가둡니다.

| 층 | 방법 | 확인된 효과 |
|---|---|---|
| 네임스페이스 | `unshare --pid --mount --ipc --uts` + `/proc` 재마운트 + 실행 전용 tmpfs `/tmp` | `ps` 에 자기 프로세스만, `/tmp` 는 실행마다 다른 파일시스템 |
| UID | 실행마다 다른 UID 로 강등, 작업 폴더 0700 | 동시에 도는 남의 워크스페이스를 읽을 수 없다 |
| 네트워크 | 러너는 internal 네트워크에만 — 외부·DB 도달 불가 | `git clone` 과 웹 조회는 서버가 대리하고 기록한다 |

툴체인은 Python(numpy·pandas) · Node.js · Go · Java 21 · GCC · git · make/cmake · sqlite3 · jq · ripgrep 입니다. 인터넷 앱은 페이지를 허용 목록으로 정제하고 이미지·CSS·폰트를 **서명된 프록시**로 재작성해 샌드박스 iframe 에 넣습니다 — 스크립트는 우리가 심은 nonce 하나뿐이고 CSP 가 나머지를 막습니다. 관리자 [자원 관리]에서 러너 CPU·메모리 추이, 실행 중인 명령, 진행 중인 세션을 보고 끊을 수 있습니다.

## 시나리오 스튜디오

문제 상황 전체를 설계하는 편집기입니다. 왼쪽이 편집기, 오른쪽이 **AI 설계자 대화**입니다.

"커머스 데이터플랫폼팀. 주간 매출 리포트 숫자가 이상하다는 CS 제보, medium" 한 줄이면 AI 가 제목·서사형 브리핑·인물(성격·지식·태도)·오프닝·초기 데이터·숨은 정답·자동 체크를 설계해 **필드 단위로 실시간** 채우고, "QA 를 하나 더", "데이터를 40행으로" 를 이어 가며 고도화합니다. 받은 것은 검증·정규화(인물 키·발신자·경로·정규식·배점)를 거치고, 저장은 사람이 합니다.

- **등장인물** — 이름/직함/성격(무례한 상대를 대하는 방식 포함) + `knowledge`(물어보면 답할 수 있는 정보의 전부). 요구사항을 인물별로 분산
- **오프닝 메시지** — 응시 시작 시 도착해 있는 메시지. 응시자의 유일한 출발점
- **초기 파일** — 워크스페이스 초기 상태(데이터·버그 코드·문서)
- **숨은 요구사항** — 정답 정의. NPC 의 배경 지식과 자동평가 기준으로만 쓰이며 응시자에게 노출되지 않음
- **자동 체크** — `file_exists` / `file_contains`(정규식) / `command`(샌드박스 실행)
- **루브릭** — 과정(요구사항 파악·커뮤니케이션·작업 과정) / 결과(요구 충족·구현 품질)

기본 제공 시나리오 6종(집계 버그 · docker compose GPU 서빙 · Kubernetes 스케줄링 · KVM GPU 패스스루 · 게이트웨이 로그 분석 · 배치 경쟁 조건)은 모두 **참조 해답으로 만점이 검증**되어 있습니다.

## 아키텍처

```
            ┌──────────┐
 :3100 ───► │   edge   │ ── /api (SSE 무버퍼) ──► ┌──────────┐   LPUSH    ┌───────────┐
            │  nginx   │ ── /                ──► │   api    │ ─────────► │  runner   │
            └──────────┘      ┌──────────┐       │ FastAPI  │   Redis    │ (sandbox) │
                              │   web    │       └────┬─────┘ ◄───────── └───────────┘
                              │ Next.js  │            │      콜백(파일 diff) · 자원 스냅샷(1s)
                              └──────────┘       PostgreSQL
```

| 서비스 | 스택 | 역할 |
|---|---|---|
| `edge` | nginx | 단일 오리진 — `/api`(SSE 무버퍼)와 웹 |
| `web` | Next.js 15, Tailwind v4, Monaco | 데스크톱 시험장 / 스튜디오 / 리뷰 / 자원 관리 |
| `api` | FastAPI, SQLAlchemy(async), lxml | 인증, 시나리오·시험, NPC·에이전트·설계자 LLM, 워크스페이스(단일 진실=DB), 참고 자료 프록시, 자동평가 |
| `runner` | Python + unshare/setpriv/rlimit | 워크스페이스를 물질화해 격리 실행, 파일 변경분 회수, 자원 계측 |
| `postgres` / `redis` | 16 / 7 | 저장소 / 실행 큐·스냅샷 |

- **워크스페이스 = DB 가 단일 진실.** IDE 저장·에이전트 도구·실행 결과·clone 이 한 곳에서 만나고 전부 이벤트로 남습니다.
- **LLM 공급자**: OpenAI / Anthropic / Gemini / vLLM / Ollama / LM Studio / OpenAI 호환 / **Claude Code CLI**. Claude 구독 계정은 설정 화면의 **브라우저 로그인**(장수명 토큰 자동 발급)으로 연결합니다.
- **Claude Code 도구 브리지**: CLI 내장 도구·스킬·세션은 전부 차단하고 우리 워크스페이스 도구 8종만 **stdio MCP** 로 노출합니다. CLI 도 다른 공급자와 **동일한 도구 집합**으로 같은 샌드박스에서 실행합니다.

## 운영

```bash
./scripts/remote-deploy.sh [api web ...]         # 워크스페이스 → 운영 서버: pull + 아래 deploy.sh
sudo ./scripts/deploy.sh [--yes] [api web ...]   # 스냅샷 → 백업 → 빌드 → 기동 → 헬스체크 → 보존 검증
sudo ./scripts/backup.sh [설명]                   # pg_dump.gz (최근 20개 보관)
sudo ./scripts/restore.sh /var/backups/odysseus/ (암호화, root 전용)<file>.sql.gz  # 되돌릴 수 없으므로 두 번 묻는다
```

`docker compose down -v` 는 **절대 쓰지 마세요** — `pgdata` 볼륨에 계정·응시 기록·워크스페이스 파일·AI 공급자 키·관리자 설정이 전부 있습니다. `.env` 의 `POSTGRES_PASSWORD` 는 볼륨이 처음 만들어질 때 고정된 값이라 바꾸면 접속이 끊깁니다.

| 변수 | 설명 |
|---|---|
| `JWT_SECRET` / `INTERNAL_TOKEN` | **필수.** 각각 `openssl rand -hex 32`. 운영 모드에서는 자리표시자·32자 미만이면 기동 거부, 개발 모드는 경고 |
| `POSTGRES_PASSWORD` | 기존 볼륨에 묶인 값 — 바꾸지 말 것 |
| `RUNNER_CONCURRENCY` / `RUNNER_MEM_MB` | 동시 실행 수 / 러너 메모리 상한 (기본 2 / 4096) |
| `REDIS_API_PASSWORD` / `REDIS_RUNNER_PASSWORD` | **필수.** Redis ACL 계정(api=전체, runner=큐 소비·자기 통계만) |
| `ODYSSEUS_ENV` | `production`(기본) 또는 `development` |
| `BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD` | 빈 DB 최초 기동 시 만들 관리자. 비밀번호를 비우면 무작위 생성 후 api 로그에 한 번 출력 |
| `SEED_DEMO_DATA` | **개발 전용.** 고정 비밀번호의 데모 계정 3개를 만든다. `ODYSSEUS_ENV=development` 가 아니면 기동 거부 (기본 false) |

데모 계정(개발 시드에서만 생성, 스모크 테스트가 사용): `admin@odysseus.dev` · `evaluator@odysseus.dev` · `candidate@odysseus.dev` — 비밀번호는 `apps/api/odysseus_api/seed.py` 의 `DEMO_ACCOUNTS`. 운영 데이터에 이 계정이 남아 있으면 안 된다 (`docs/security/01`).

## 테스트

전부 **실행해서** 확인합니다 — 격리는 실제로 남의 파일을 읽어 보고, 강제 종료는 프로세스가 정말 사라졌는지 보고, 백업은 임시 DB 에 실제로 복원해 봅니다.

```bash
python3 tests/smoke/mock_llm.py &                       # 모의 LLM (NPC·에이전트·평가·설계자)
GW=$(docker network inspect odysseus_backplane -f '{{(index .IPAM.Config 0).Gateway}}')

python3 tests/smoke/test_core.py "http://$GW:18011/v1"  # 핵심 흐름 54
python3 tests/smoke/test_scenarios.py                   # 기본 시나리오 참조 해답 14
python3 tests/smoke/test_sequential.py                  # 순차 진행 잠금 18
python3 tests/smoke/test_isolation.py                   # 샌드박스 격리·툴체인·적대적 입력 35
python3 tests/smoke/test_resources.py                   # 자원 계측·강제 종료·고아 정리 24
python3 tests/smoke/test_scenario_author_stream.py "http://$GW:18011/v1"  # AI 설계자 21
python3 tests/smoke/test_npc_prompt.py                  # NPC 프롬프트 계약 48
sudo python3 tests/smoke/test_persistence.py            # 백업·복원·보존 39

# api 컨테이너 안에서
docker cp tests/smoke/test_reference.py odysseus-api-1:/tmp/ && docker exec -e PYTHONPATH=/app odysseus-api-1 python3 /tmp/test_reference.py     # GitHub·웹 41
docker cp tests/smoke/test_web_render.py odysseus-api-1:/tmp/ && docker exec -e PYTHONPATH=/app odysseus-api-1 python3 /tmp/test_web_render.py  # 렌더러 39
docker cp tests/smoke/test_mcp_bridge.py odysseus-api-1:/tmp/ && docker exec -e PYTHONPATH=/app odysseus-api-1 python3 /tmp/test_mcp_bridge.py  # MCP·격리 전파 18
docker cp tests/smoke/test_cli_lockdown.py odysseus-api-1:/tmp/ && docker exec -e PYTHONPATH=/app odysseus-api-1 python3 /tmp/test_cli_lockdown.py  # CLI 잠금 19

# 브라우저 (Playwright)
python3 tests/smoke/ui_polish.py    # 마크다운 누수·깨진 값·넘침·콘솔 오류
python3 tests/smoke/ui_intro.py     # 시네마틱 인트로 → 부팅 → 데스크톱
```

## License

MIT

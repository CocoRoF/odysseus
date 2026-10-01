# Odysseus 평가 신뢰성·실행 안정성 운영 가이드

이 문서는 PR #2에서 도입한 평가 정의 고정, Requirement Graph, 자동평가 점수 엔진, 실행 큐 복구,
샌드박스 자원 제한, 비밀값 암호화, multi-replica 동시성, schema migration 운영 규칙을 설명합니다.
특히 **배포 전에 반드시 준비해야 하는 값**과 롤백 제약을 명확하게 기록합니다.

## 1. 평가 정의는 응시 시작 시 고정됩니다

`Scenario`, `Assessment`, `AiProvider` 행은 관리자가 편집하는 최신 authoring state입니다.
반면 응시가 시작되면 API가 그 시점의 시험 정의 전체를 `Attempt.snapshot._definition`에 저장하고
`_definition_hash`를 함께 남깁니다. 현재 definition format은 v3입니다.

고정되는 항목:

- 시험 제목/설명/제한 시간/AI 에이전트 턴 수
- 시나리오 순서와 배점
- briefing, 등장인물 persona/knowledge, 오프닝 메시지
- 초기 파일
- 숨은 요구사항(`objectives_md`)
- 자동 checks와 rubric
- Requirement Graph
- agent 사용 가능 여부
- NPC/Agent 공급자의 비밀이 아닌 실행 설정(provider/model/base URL/temperature/max tokens)

API key나 인증 header 같은 비밀값은 Attempt snapshot에 복제하지 않습니다. 자격증명은 암호화된
`AiProvider` 저장소에서 읽고, 모델 동작을 결정하는 비밀 아닌 설정만 응시 시점 값으로 덮어씁니다.
따라서 시험 도중 provider credential을 회전하는 것은 가능하지만, 해당 provider를 삭제하거나 disable하면
그 provider에 고정된 진행 중 응시의 NPC/Agent는 fail-closed합니다. 운영 중인 시험이 있을 때 provider를
삭제/비활성화하지 않는 것을 권장합니다.

관리자가 이후 시나리오나 시험을 수정하면 **새 응시/재응시에만** 반영됩니다. 과거 응시는 당시
`definition_hash`와 당시 grading criteria를 계속 사용합니다. 사용 이력이 있는 Assessment 자체의 hard delete는
막고, 사용 이력이 있는 Scenario 삭제 요청은 archive로 바꿉니다.

기존 PR 이전에 만들어진 legacy Attempt에는 definition snapshot이 없을 수 있습니다. 이 경우 최초
조회/평가 시 현재 definition을 한 번 바인딩하고 이후부터 고정합니다. 이미 과거에 정의가 변경된
legacy Attempt는 원래 당시 정의를 완벽하게 복원할 수 없으므로 감사 시 별도 구분해야 합니다.

## 2. Requirement Graph

Odysseus의 핵심은 “문제가 요구사항을 직접 말해 주지 않는다”는 점입니다. 이 철학을 평가 가능한 구조로
만들기 위해 각 frozen scenario에는 Requirement Graph가 포함됩니다.

기본 구조:

```text
Requirement
  ├─ statement
  ├─ critical / weight
  ├─ discoverable_from -> NPC knowledge fact
  └─ validated_by      -> deterministic check
```

두 가지 모드를 지원합니다.

- `explicit`: rubric의 `requirements`에 출제자가 명시한 연결을 그대로 사용합니다.
- `derived`: 기존 시나리오 호환을 위해 `objectives_md`, NPC `knowledge`, check label에서 보수적으로 연결을 추론합니다.

Derived 연결은 어디까지나 heuristic입니다. 따라서 Evaluation 결과에도 `graph_mode`가 남고, 리뷰 화면에서
frozen graph를 확인할 수 있습니다.

서버는 다음 보조 지표를 계산합니다.

- `source_contact_pct`: 요구사항 정보를 가진 NPC 중 실제로 후보자가 대화를 건 source의 가중 비율
- `validation_pct`: check와 연결된 요구사항 중 검증을 통과한 가중 비율
- `critical_validation_pct`: critical requirement의 검증 통과 비율

중요하게도 **`source_contact_pct`는 요구사항을 이해했다는 뜻이 아닙니다.** 단지 정보 보유자에게 접근했다는
관측 사실입니다. 실제 요구사항 파악 평가는 메신저 대화 내용, 작업 과정, 산출물 검증과 함께 판단합니다.

## 3. 자동평가 점수 엔진 v2

LLM은 과정/품질 판단과 설명을 담당하지만 deterministic check 결과를 임의로 무시할 수 없습니다.
서버가 최종 점수를 다시 계산합니다.

기본 result score:

```text
result_pct = deterministic_check_pct * 0.70
           + qualitative_result_pct   * 0.30
```

시나리오 rubric에 `deterministic_check_weight`를 넣으면 0~100 범위에서 변경할 수 있습니다.
checks가 없는 시나리오는 qualitative result 100%로 자동 fallback합니다.

최종 점수는 기존 rubric의 `process_weight` / `result_weight`로 합산합니다. Evaluation에는 다음
provenance가 함께 저장됩니다.

- attempt definition hash / definition version
- 제출 시 workspace digest
- evaluator provider/model/name
- evaluation prompt SHA-256
- score engine version
- deterministic / qualitative 세부 점수와 실제 적용 weight
- Requirement Graph mode와 server-derived metrics

진행 중인 Attempt에는 auto/human evaluation을 실행할 수 없습니다. 재평가를 다른 모델로 수행할 수는 있지만,
각 Evaluation은 실제 사용한 evaluator metadata를 별도 보존합니다.

## 4. 실행 입력은 PostgreSQL에 먼저 고정됩니다

Redis는 delivery layer이고, PostgreSQL `Execution`이 durable source of truth입니다. 명령을 요청할 때 현재
workspace를 `Execution.input_files`에 먼저 저장한 뒤 DB commit을 완료합니다. 따라서 Redis 장애 뒤 재전송해도
**명령 요청 당시와 정확히 같은 파일 입력**을 사용합니다.

IDE 실행뿐 아니라 Agent `run_command`와 auto-check command도 같은 input snapshot 규칙을 사용합니다.
기존 버전에서 이미 `queued` 상태였던 legacy execution에 `input_files`가 없다면 reconciler가 현재 workspace를
한 번 사용하는 compatibility path가 있습니다. 새 execution에는 적용되지 않습니다.

## 5. 실행 큐 전달 보장

실행 요청 흐름:

```text
PostgreSQL queued row + exact input snapshot commit
        ↓
Redis idempotent enqueue (execution-id marker + LPUSH in one Lua script)
        ↓
pending queue
        ↓ BRPOPLPUSH
runner-specific processing queue
        ↓
execute + API callback accepted
        ↓
LREM ACK
```

API가 DB commit 직후 죽거나 Redis가 잠시 내려가도 `queue_recovery`가 15초마다 `queued` 행을 찾아
idempotent enqueue를 다시 시도합니다. 이미 Redis에 들어간 execution은 marker 때문에 중복 enqueue되지
않습니다. 최초 enqueue가 지연되면 `run_enqueue_delayed` telemetry도 남깁니다.

Runner가 작업을 꺼낸 뒤 죽으면 raw job은 `odysseus:run:processing:<RUNNER_ID>`에 남습니다.
같은 `RUNNER_ID`로 재시작하면 시작 시 processing list를 pending queue로 되돌립니다.

`queued` 인 채로 30분 넘게 아무 runner 도 받아가지 않은 execution(서명 불일치로 버려졌거나 `RUNNER_ID` 변경으로 processing
리스트에 고아가 된 경우)도 `run_stale_reaped(from_status=queued)` 로 닫고 enqueue marker 를 지웁니다. 같은 execution 이
5번 넘게 전달되면(결과 콜백이 결정적으로 5xx 인 경우) runner 는 더 실행하지 않고 error 로 보고한 뒤 ACK 합니다.

Runner가 `running` callback까지 보낸 뒤 영구적으로 사라지는 경우도 처리합니다. API watchdog은 서버가 기록한
`run_started` 이벤트 기준으로 정상 sandbox timeout + callback retry 시간을 충분히 넘긴 execution을
`run_stale_reaped`로 종료하고 callback token을 폐기하며 cancellation tombstone을 남깁니다. 따라서 고아
`running` 행이 응시자의 동시 실행 슬롯을 영구 점유하지 않습니다.

### RUNNER_ID 규칙

- 단일 runner: 기본값 `runner-main` 사용 가능
- runner replica 여러 개: **각 replica에 서로 다른 ID**를 지정해야 함
- 같은 replica가 재시작할 때는 **이전과 같은 ID**를 사용해야 미완료 processing job을 회수함

오케스트레이터를 사용한다면 StatefulSet ordinal 또는 고정 instance identity를 권장합니다.

응시 제출/만료 시 queued/running execution에는 6시간 cancellation tombstone을 남기고 callback token을
즉시 폐기합니다. 따라서 오래된 worker가 뒤늦게 결과를 보내도 제출된 workspace를 바꿀 수 없습니다.

## 6. Runner 격리와 자원 제한

운영 기본값은 `RUNNER_REQUIRE_ISOLATION=true`입니다. 기동 시 실제로 `unshare` 로 PID/mount/IPC/UTS/net namespace 를
만들어 보고(바이너리 존재 여부가 아니라 실행 성공 여부), 만들 수 없는 환경에서는 candidate code를 **비격리 상태로
실행하는 대신 runner 기동 자체를 거부**합니다.

기존 container `mem_limit`에 더해 실행별 descendant 메모리(Pss, 공유 페이지 중복 없이) watchdog이 있습니다.

- `RUNNER_MEM_MB`: runner container 전체 메모리 상한
- `RUNNER_EXEC_MEM_MB`: execution 한 건의 process-tree RSS 상한
- 미지정 시 `max(512MB, RUNNER_MEM_MB * 0.8 / RUNNER_CONCURRENCY)`

Go/JVM이 큰 virtual address space를 reserve하는 특성 때문에 `RLIMIT_AS`는 사용하지 않습니다.
CPU, file size, fd, process count, wall time, output hard cap은 기존 sandbox 제한을 계속 사용합니다.

이 PR은 per-execution cgroup 생성기를 추가하지 않았습니다. 현재의 실행별 메모리 제한은 process-tree RSS
watchdog이고, container cgroup이 최종 hard boundary입니다. 더 강한 kernel-level tenant isolation이 필요한
환경은 아래 gVisor와 별도 runner/container-per-job 구조를 검토해야 합니다.

### gVisor 선택 적용

호스트에 `runsc` runtime이 설치·등록되어 있다면:

```bash
RUNNER_RUNTIME=runsc
```

로 runner container 자체를 gVisor 위에서 실행할 수 있습니다. 설치되어 있지 않은 서버에서 값을 바꾸면
container가 시작되지 않으므로 먼저 staging에서 isolation/toolchain smoke test를 수행해야 합니다.
기본은 `runc`입니다. PR이 호스트에 gVisor 자체를 설치하지는 않습니다.

## 7. DB 비밀값 AES-GCM 암호화

운영 환경에는 새 필수 변수 `DATA_ENCRYPTION_KEY`가 필요합니다.

배포 전에 **한 번만 생성하고 안전하게 보관**합니다.

```bash
openssl rand -hex 32
```

`.env` 예시:

```text
DATA_ENCRYPTION_KEY=<생성한 값>
```

`JWT_SECRET`, `INTERNAL_TOKEN`과 다른 값을 사용하십시오. development mode는 빈 값을 허용하지만 startup에
경고를 출력하며, production mode는 충분한 키가 없으면 기동을 거부합니다.

암호화 대상:

- `AiProvider.api_key`
- `AiProvider.default_headers`
- `AppSetting.value` 전체 (GitHub token, 검색 API key, legacy AI 설정 포함 가능)

AES-256-GCM + random nonce를 사용하며, 같은 평문도 저장할 때 서로 다른 ciphertext가 생성됩니다.
기존 plaintext row는 새 버전 최초 기동 시 자동으로 encrypted envelope로 다시 저장됩니다 (원문 컬럼을 직접 읽어 아직
평문인 행만 — 이후 기동에서는 다시 쓰지 않습니다).

### 매우 중요한 백업/롤백 규칙

`DATA_ENCRYPTION_KEY`는 DB backup과 한 세트입니다. 키를 잃으면 저장된 provider/reference credential을
복호화할 수 없습니다. backup 정책에 키 자체를 DB dump 안에 넣지 말고 별도 secret store에서 동일한
retention 정책으로 보관하십시오.

또한 **평문 DB를 읽던 구버전 애플리케이션으로 코드만 롤백하면 안 됩니다.** 새 버전이 한 번 기동해
plaintext secret을 암호화한 뒤에는 구버전이 ciphertext를 API key로 오해합니다.

롤백은 다음 둘 중 하나여야 합니다.

1. 암호화 지원이 포함된 버전으로만 롤백
2. 배포 직전 DB backup + 당시 `DATA_ENCRYPTION_KEY`/환경 설정을 함께 복원

## 8. Multi-replica API

다음 상태는 이제 단일 API 프로세스 메모리에 의존하지 않습니다.

- Agent turn mutex: Redis owner-token lease
- Messenger NPC thread ordering: Redis owner-token lease
- rate limit token bucket: Redis Lua + Redis server time
- login failure backoff: Redis
- terminal run admission: PostgreSQL `Attempt FOR UPDATE`
- agent quota reservation: PostgreSQL `Attempt FOR UPDATE`
- startup schema migration: PostgreSQL transaction advisory lock

Redis가 순간적으로 unavailable할 때 rate limiter와 agent/messenger lease 는 제한 자체를 없애지 않고 process-local
fallback 을 사용합니다 (API 의 Redis 클라이언트는 연결 2s/명령 5s 타임아웃이라 멈춘 Redis 가 요청을 매달지 못합니다). 큐는 DB `queued` 상태와 exact input snapshot을 보존하고 Redis가 돌아오면 reconciler가 복구합니다.

## 9. Versioned schema migration ledger

기존에는 `main.py`의 raw DDL 목록을 모든 부팅마다 재실행했습니다. 이제 `migrations.py`와
`schema_migrations` ledger를 사용합니다.

- migration은 정수 version + name + statements로 순서가 고정됩니다.
- 적용된 version은 PostgreSQL에 기록합니다.
- 여러 API replica가 동시에 기동해도 transaction advisory lock 아래 한 번씩 적용합니다.
- 이미 과거 버전에서 일부 DDL이 적용된 설치를 위해 초기 migration은 `IF NOT EXISTS`/idempotent 형태입니다.
- 새 schema 변경은 기존 migration을 수정하지 않고 새 version을 append해야 합니다.

현재 ledger에는 attempt snapshot/sequence, workspace freeze trigger, event provenance, active-attempt unique index,
`Execution.input_files` migration이 포함됩니다.

## 10. 개인정보 최소화

브라우저 copy/cut telemetry는 이제 raw clipboard text를 **전송하지 않습니다.** 클라이언트는 문자 수만
전송하고, 서버도 payload allowlist에서 `text`를 허용하지 않습니다. 평가용으로는 `chars`, `source`, sequence
같은 metadata만 남습니다.

## 11. Dependency/CI 안전선

Web runtime은 audited lockfile 기준으로 Next.js `15.5.25`, React/React DOM `19.2.8`을 사용하고 PostCSS
`8.5.26` override를 적용합니다. Backend lockfile은 FastAPI `0.141.1`, Starlette `1.6.0`, lxml `6.1.3` 등
감사 통과 버전으로 갱신했습니다. Dependabot이 npm/pip/Docker 업데이트를 추적합니다.

PR CI는 다음을 merge gate로 둡니다.

- Python source compile
- api/edge/runner 컨테이너 이미지 실제 빌드
- locked dependency closure (`pip check`)
- 실제 FastAPI application import
- reliability unit tests
  - definition hash
  - Requirement Graph semantics
  - deterministic score engine
  - AES-GCM encryption/fail-closed
- Python dependency audit (`pip-audit`)
- Docker Compose configuration validation
- locked npm install
- TypeScript typecheck
- Next production build
- production npm dependency audit (`high` 이상 실패)

실제 namespace/toolchain/backup 복원 테스트는 privileged Linux 환경이 필요하므로 기존 smoke harness와 배포 전
staging 검증을 계속 유지해야 합니다. CI가 green이어도 이 운영 검증을 생략한다는 뜻은 아닙니다.

## 12. 배포 체크리스트

1. 현재 DB backup을 생성하고 **실제 복원 가능성**을 확인합니다.
2. `DATA_ENCRYPTION_KEY=$(openssl rand -hex 32)` 값을 secret store와 `.env`에 저장합니다 (`scripts/deploy.sh` 는 운영에서 이 값이 없으면 시작 전에 멈춥니다).
3. `JWT_SECRET`, `INTERNAL_TOKEN`, Redis 두 password가 각각 충분히 긴 독립 값인지 확인합니다.
4. 진행 중인 시험이 있다면 연결된 NPC/Agent provider를 삭제/disable하지 않습니다.
5. runner replica가 하나보다 많으면 고유하고 재시작 후에도 안정적인 `RUNNER_ID`를 지정합니다.
6. 필요하면 `RUNNER_EXEC_MEM_MB`를 workload에 맞게 조절합니다.
7. gVisor를 쓸 경우 staging에서 `RUNNER_RUNTIME=runsc`로 기존 isolation/toolchain smoke test를 먼저 통과시킵니다.
8. 배포 후 `/healthz`, 로그인, Scenario/Assessment CRUD, 시험 시작, NPC/Agent, terminal 실행, 제출, review checks/autoeval 흐름을 확인합니다.
9. Redis를 일시 중단한 상태에서 queued execution을 만든 뒤 Redis 복구 후 같은 `Execution.input_files`로 처리되는지 staging에서 확인합니다.
10. 새 Attempt의 `snapshot._definition_hash`와 Evaluation `scores.audit.definition_hash`가 일치하는지 확인합니다.
11. DB에서 secret column이 encrypted envelope 형태로 저장되는지 확인하되 값을 로그/티켓에 복사하지 않습니다.
12. 배포 직후 `schema_migrations` ledger의 적용 version과 애플리케이션 로그를 확인합니다.

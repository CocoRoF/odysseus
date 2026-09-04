# ODY-007: 마감·제출 이후 결과 변경 가능성

## 취약점 요약

- **심각도:** 높음
- **영향:** 제출 결과의 무결성 훼손, 응시자 간 실제 풀이 시간 불공정
- **원인:** 모든 변경 API에 45초 유예가 적용되고, 지연 도착한 runner 결과가 응시 상태를 다시 확인하지 않고 파일을 반영한다.
- **주요 근거:** `apps/api/odysseus_api/routers/attempts.py:30`, `apps/api/odysseus_api/routers/attempts.py:57`, `apps/api/odysseus_api/routers/internal.py:87`

## 상세

`check_expired()`는 `deadline_at + 45초`가 지나야 응시를 만료시킨다. 이 유예는 이벤트 flush 전용이라는 주석과 달리 파일 저장, 실행 요청, 메신저, 에이전트 등 `require_own_active()`를 사용하는 모든 변경에 적용된다.

또한 실행 요청이 제출 전에 큐에 들어가기만 하면, runner의 결과 콜백은 현재 Attempt 상태가 `submitted` 또는 `expired`인지 확인하지 않고 `changed_files`를 워크스페이스에 적용한다. 즉 제출 버튼을 누른 뒤 완료된 백그라운드 실행이 최종 파일을 바꿀 수 있다.

## 재현 방법(공격 방법)

전용 테스트 시험에서만 수행한다.

1. 마감 직전에 파일 저장 요청을 준비한다.
2. `deadline_at`이 지난 뒤 45초 이내에 PUT 파일 저장을 보낸다.
3. 성공하면 명목상 마감 이후 수정이 허용된 것이다.

지연 결과 검증은 마감 전에 다음과 같이 늦게 파일을 만드는 실행을 시작하고 즉시 시험을 제출한다.

```bash
sleep 10; printf 'changed after submit\n' > final.txt
```

제출 완료 후 `final.txt`가 생성되면 runner callback 문제도 재현된다.

## 공격 예시

1. **45초 추가 풀이:** 브라우저 타이머가 0이 된 후 직접 API로 파일을 계속 수정한다.
2. **지연 실행 제출:** 마감 직전 `sleep`이 포함된 명령을 시작하고 먼저 제출한 뒤 결과 파일을 나중에 반영한다.
3. **여러 큐 작업 예약:** 제출 직전 서로 다른 결과를 만드는 작업을 여러 개 넣어 제출 후 마지막 도착 결과가 답안을 덮게 한다.
4. **에이전트 지연 응답:** 마감 전 시작한 AI 도구 실행이 마감 후 파일을 변경하도록 유도한다.

## 해결 방법

1. 이벤트 flush 유예와 변경 가능 시간을 분리한다. 마감 즉시 모든 mutation을 거부하고 이벤트 수집만 별도 endpoint에서 제한적으로 허용한다.
2. 제출 시 워크스페이스, 대화, 실행 목록의 불변 스냅샷 또는 content hash를 생성해 평가 대상에 고정한다.
3. 내부 실행 결과 콜백에서 Attempt 상태와 execution 생성·시작 시각을 확인한다.
4. 제출/만료 처리 시 queued/running execution을 취소하고 이후 콜백은 감사용으로만 저장하며 워크스페이스에는 반영하지 않는다.
5. DB 트랜잭션과 행 잠금으로 제출 상태 변경과 callback 반영이 경쟁하지 않게 한다.
6. 평가기는 mutable 현재 워크스페이스가 아니라 제출 스냅샷만 사용한다.


## 조치 (2026-09-04, 완료)

- **유예 분리:** `check_expired()` 는 `deadline_at` 이 지나면 즉시 종료한다 — 파일·실행·대화·clone 등 `require_own_active` 를 쓰는 모든 변경이 마감과 동시에 400 이다. 45초 유예는 `EVENT_FLUSH_GRACE` 로 이름을 바꿔 **행동 이벤트 플러시(`POST /attempts/{id}/events`)에만** 적용된다 (`routers/attempts.py`).
- **종료의 단일 경로:** 제출(마지막 문제 완료·시험 종료)·마감·관리자 세션 종료가 모두 `lifecycle.finalize_attempt()` 를 지난다. 응시 행을 `SELECT … FOR UPDATE` 로 잠근 채 상태 변경 → 남은 queued/running 실행 취소(러너 취소 집합 + error 로 마감) → 시나리오별 스냅샷 → 이벤트를 한 트랜잭션으로 한다.
- **스냅샷:** `attempts.snapshot` 에 시나리오별 `{digest(내용 해시), files, bytes, messages, executions}` 를 남기고 `attempt_submitted`/`attempt_expired` 이벤트 payload 에도 요약을 넣는다. 평가기(`autoeval.evaluate_scenario`)는 평가 시점에 해시를 다시 계산해 다르면 `integrity_flags` 에 "제출 후 변경 의심" 을 붙이고 `snapshot_verified=false` 를 남긴다.
- **DB 동결 트리거:** `workspace_files_frozen` 트리거가 응시 상태가 `in_progress` 가 아니면 INSERT/UPDATE/DELETE 를 예외로 막는다 (`main.MIGRATIONS`). 애플리케이션 경로를 우회하는 늦은 콜백·버그·직접 SQL 도 워크스페이스를 바꾸지 못한다. 응시 삭제(CASCADE)는 그대로 된다.
- **늦은 콜백:** `/internal/executions/{id}/result` 는 응시 행을 잠근 채 상태·마감을 보고, 종료됐으면 stdout/stderr 는 감사용으로 저장하되 `changed_files` 는 버리고 이벤트에 `discarded_after_finalize` 로 남긴다. 러너에도 취소가 전달된다.
- **검증:** `tests/security/test_submission_freeze.py` — 제출 직전 시작한 `sleep 6; … > late.txt` 가 제출 뒤 반영되지 않음(실행은 취소), 제출 뒤 파일/실행/메신저/clone 400, 직접 SQL UPDATE/INSERT/DELETE 가 트리거로 거부, 마감 2초 뒤 저장 400(이전엔 45초 허용) + 이벤트 플러시는 45초만 허용, 정상 흐름 회귀.

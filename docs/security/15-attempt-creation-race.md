# ODY-015: 응시 생성 경쟁 조건

## 취약점 요약

- **심각도:** 중간
- **영향:** 한 시험에 여러 활성 응시 생성, 마감·답안·평가 기준 불일치
- **원인:** 기존 응시 조회와 새 응시 INSERT가 원자적이지 않고 DB에 활성 응시 유일성 제약이 없다.
- **주요 근거:** `apps/api/odysseus_api/routers/attempts.py:288`, `apps/api/odysseus_api/routers/attempts.py:311`, `apps/api/odysseus_api/models.py:131`

## 상세

시험 시작 endpoint는 먼저 `(assessment_id, user_id, superseded=false)` 응시가 있는지 조회하고, 없으면 새 Attempt와 전체 초기 파일·메시지를 생성한다. 두 요청이 동시에 실행되면 둘 다 기존 행을 보지 못하고 각각 INSERT할 수 있다.

Attempt 테이블에는 이 조건을 강제하는 unique index가 없다. 이후 `/my/assignments`는 여러 행을 dictionary로 축약하므로 어떤 attempt가 표시되는지도 조회 순서에 의존한다.

## 재현 방법(공격 방법)

새 테스트 사용자와 아직 시작하지 않은 테스트 assessment를 사용한다. 두 요청을 최대한 동시에 보낸다.

```bash
seq 1 2 | xargs -P2 -I{} curl -sS -b "$COOKIE_JAR" \
  -X POST "$BASE_URL/assessments/테스트-ASSESSMENT-UUID/attempts"
```

응답의 attempt ID가 서로 다르거나 DB에 superseded=false 행이 두 개 생성되면 재현된다. 반복할 때마다 새 테스트 사용자를 사용한다.

## 공격 예시

1. **두 개의 마감시간 확보:** 병렬 요청으로 서로 다른 `started_at/deadline_at`을 가진 응시를 만들고 유리한 쪽을 선택한다.
2. **답안 분기:** 각 attempt에서 다른 풀이를 작성한 뒤 평가 또는 UI가 어느 것을 선택하는지 악용한다.
3. **초기 메시지 중복:** 초기 NPC 메시지와 파일이 두 번 물질화되어 평가 데이터와 사용량 집계가 분리된다.
4. **재시도 자동화 악용:** 느린 네트워크에서 클라이언트가 POST를 재시도하면서 사용자의 의도 없이 중복 응시가 만들어진다.

## 해결 방법

1. PostgreSQL partial unique index를 추가한다: `(assessment_id, user_id) WHERE superseded = false`.
2. 트랜잭션에서 assignment 또는 사용자-시험 advisory lock을 획득한 뒤 조회·생성을 수행한다.
3. unique violation이 발생하면 기존 attempt를 다시 조회해 idempotent하게 반환한다.
4. 클라이언트가 생성 요청에 idempotency key를 보내도록 하고 서버에서 소비 기록을 유지한다.
5. 이미 존재하는 중복 응시는 자동 병합하지 말고 시간·파일·이벤트를 검토해 하나를 superseded 처리한다.


## 조치 (2026-09-04, 완료)

- **유일 제약:** 부분 유일 인덱스 `attempts_one_active_per_user (assessment_id, user_id) WHERE superseded = false` 를 마이그레이션으로 만든다. 이미 중복이 있으면 최신 것만 남기고 나머지를 superseded 로 돌린 뒤 인덱스를 만든다 (`main.MIGRATIONS`).
- **원자적 생성:** `start_attempt` 는 트랜잭션 advisory lock(`pg_advisory_xact_lock(hash(assessment, user))`) 아래에서 조회→생성을 하고, 그래도 겹치면(다른 인스턴스 등) `IntegrityError` 를 받아 롤백 후 기존 응시를 돌려준다 — 클라이언트 입장에서 idempotent.
- **재응시:** 같은 잠금 아래에서 '기존 활성 응시 전부 superseded + 새 응시 생성' 을 한 트랜잭션으로 한다. 이미 superseded 된 응시로 다시 요청하면 현재 활성 응시를 돌려준다.
- **검증:** `tests/security/test_attempt_race.py` — 응시자가 12개 요청을 동시에 보내도 전부 200·같은 id·DB 활성 1건·초기 파일 중복 없음, 관리자 6명이 동시에 재응시해도 활성 1건, 인덱스 존재(psql).
- **미완:** 클라이언트 idempotency key(#4)는 잠금+유일 인덱스로 같은 효과를 내므로 두지 않았다.

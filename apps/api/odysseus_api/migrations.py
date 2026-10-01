"""Small versioned migration runner for Odysseus.

Historically startup kept a raw list of DDL strings in `main.py`; every boot replayed every statement
and there was no ledger telling operators which schema changes had actually been applied. This module
keeps the zero-extra-dependency deployment model while providing ordered versions, a durable ledger,
and one PostgreSQL advisory lock across API replicas.

Migrations must remain backward-compatible/idempotent because existing installations may already have
some of the pre-ledger DDL effects. New schema changes should be appended as a new Migration; never
edit a migration that has shipped.
"""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection

SCHEMA_MIGRATION_LOCK = 5_472_943_197_011


@dataclass(frozen=True, slots=True)
class Migration:
    version: int
    name: str
    statements: tuple[str, ...]


MIGRATIONS: tuple[Migration, ...] = (
    Migration(
        1,
        "attempt sequencing and execution callbacks",
        (
            "ALTER TABLE attempts ADD COLUMN IF NOT EXISTS current_ordinal INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE executions ADD COLUMN IF NOT EXISTS callback_token VARCHAR(64)",
            "ALTER TABLE attempts ADD COLUMN IF NOT EXISTS snapshot JSONB",
            "ALTER TABLE scenarios ADD COLUMN IF NOT EXISTS npc_base_prompt TEXT NOT NULL DEFAULT ''",
        ),
    ),
    Migration(
        2,
        "freeze completed workspaces",
        (
            """
            CREATE OR REPLACE FUNCTION workspace_files_frozen_guard() RETURNS trigger AS $$
            DECLARE st TEXT;
            BEGIN
                SELECT status INTO st FROM attempts WHERE id = COALESCE(NEW.attempt_id, OLD.attempt_id);
                IF st IS NOT NULL AND st <> 'in_progress' THEN
                    RAISE EXCEPTION 'workspace is frozen: attempt % is %', COALESCE(NEW.attempt_id, OLD.attempt_id), st
                        USING ERRCODE = 'check_violation';
                END IF;
                IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
                RETURN NEW;
            END $$ LANGUAGE plpgsql
            """,
            "DROP TRIGGER IF EXISTS workspace_files_frozen ON workspace_files",
            """
            CREATE TRIGGER workspace_files_frozen BEFORE INSERT OR UPDATE OR DELETE ON workspace_files
                FOR EACH ROW EXECUTE FUNCTION workspace_files_frozen_guard()
            """,
        ),
    ),
    Migration(
        3,
        "event provenance and user origin",
        (
            "ALTER TABLE events ADD COLUMN IF NOT EXISTS source VARCHAR(20) NOT NULL DEFAULT 'server'",
            "ALTER TABLE users ADD COLUMN IF NOT EXISTS created_ip VARCHAR(64)",
        ),
    ),
    Migration(
        4,
        "one active attempt per assessment and user",
        (
            """
            UPDATE attempts a SET superseded = true
            WHERE a.superseded = false AND EXISTS (
                SELECT 1 FROM attempts b
                WHERE b.assessment_id = a.assessment_id AND b.user_id = a.user_id AND b.superseded = false
                  AND (b.started_at > a.started_at OR (b.started_at = a.started_at AND b.id > a.id))
            )
            """,
            "CREATE UNIQUE INDEX IF NOT EXISTS attempts_one_active_per_user ON attempts (assessment_id, user_id) WHERE superseded = false",
        ),
    ),
    Migration(
        5,
        "durable execution input snapshots",
        (
            "ALTER TABLE executions ADD COLUMN IF NOT EXISTS input_files JSONB",
        ),
    ),
    Migration(
        6,
        "per-scenario desktop app set",
        (
            "ALTER TABLE scenarios ADD COLUMN IF NOT EXISTS desktop_apps JSONB NOT NULL DEFAULT '[]'::jsonb",
        ),
    ),
    Migration(
        7,
        "scenario owning department",
        (
            "ALTER TABLE scenarios ADD COLUMN IF NOT EXISTS department VARCHAR(40) NOT NULL DEFAULT ''",
        ),
    ),
    Migration(
        8,
        "departments are data, not code",
        (
            # 표 자체는 create_all 이 만든다. 여기서는 이전 배포에서 이미 만들어졌을
            # 수 있는 열을 맞춰 둔다 — 표가 없으면 아무 일도 일어나지 않는다.
            "ALTER TABLE IF EXISTS departments ADD COLUMN IF NOT EXISTS summary VARCHAR(300) NOT NULL DEFAULT ''",
            "ALTER TABLE IF EXISTS departments ADD COLUMN IF NOT EXISTS accent VARCHAR(9) NOT NULL DEFAULT '#62A8C8'",
            "ALTER TABLE IF EXISTS departments ADD COLUMN IF NOT EXISTS ordinal INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE IF EXISTS departments ADD COLUMN IF NOT EXISTS app_preset VARCHAR(20) NOT NULL DEFAULT 'office'",
        ),
    ),
    Migration(
        9,
        "assessment category",
        (
            # 응시자 화면의 필터 축. 이미 깔린 기본 프리셋은 제목으로 알아보고 분야를 채운다 —
            # 관리자가 이미 분야를 정한 시험(category <> '')은 건드리지 않는다.
            # 아래 목록은 배포 시점의 스냅샷이다(마이그레이션은 고정). 프리셋과 어긋나면
            # tests/unit/test_assessment_categories.py 가 알린다.
            "ALTER TABLE assessments ADD COLUMN IF NOT EXISTS category VARCHAR(40) NOT NULL DEFAULT ''",
            "UPDATE assessments SET category = 'data' WHERE category = '' AND title = '실무 시뮬레이션 데모 — 매출 리포트'",
            "UPDATE assessments SET category = 'infra' WHERE category = '' AND title = '인프라 심화 — LLM 추론 스택'",
            "UPDATE assessments SET category = 'dev' WHERE category = '' AND title = '심화 문제 해결 — 분석과 동시성'",
            "UPDATE assessments SET category = 'office' WHERE category = '' AND title = '사무 실무 입문 — 회의록 정리'",
            "UPDATE assessments SET category = 'office' WHERE category = '' AND title = '사무 실무 종합 — 보고서와 데이터'",
            "UPDATE assessments SET category = 'communication' WHERE category = '' AND title = '커뮤니케이션 — 클레임·공지·갈등'",
            "UPDATE assessments SET category = 'problem' WHERE category = '' AND title = '문제 해결·조율 — 제약 속에서 계획 세우기'",
            "UPDATE assessments SET category = 'problem' WHERE category = '' AND title = '일반 문제 해결 입문 — 기준부터 찾기'",
            "UPDATE assessments SET category = 'problem' WHERE category = '' AND title = '일반 문제 해결 심화 — 제약 속 배정'",
            "UPDATE assessments SET category = 'compliance' WHERE category = '' AND title = '규정 적용 — 판정하고 설명하기'",
            "UPDATE assessments SET category = 'communication' WHERE category = '' AND title = '갈등 조율 심화 — 요구 뒤의 이해관계'",
            "UPDATE assessments SET category = 'office' WHERE category = '' AND title = '요약과 보고 — 한 장으로 말하기'",
            "UPDATE assessments SET category = 'planning' WHERE category = '' AND title = '기획·의사결정 — 벤더 선정'",
        ),
    ),
    Migration(
        10,
        "user avatar preset + guest category",
        (
            "ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_preset VARCHAR(40) NOT NULL DEFAULT ''",
            "ALTER TABLE users ADD COLUMN IF NOT EXISTS guest_category VARCHAR(40) NOT NULL DEFAULT ''",
        ),
    ),
    Migration(
        11,
        "drop departments",
        (
            # 부서(사무실 방을 데이터로 두던 기능)를 제거한다. 방은 시험이고 색은 분야에서 온다.
            # 7·8 은 배포된 마이그레이션이라 그대로 두고(멱등), 여기서 되돌린다.
            "DROP TABLE IF EXISTS departments",
            "ALTER TABLE scenarios DROP COLUMN IF EXISTS department",
        ),
    ),
    Migration(
        12,
        "office presets",
        (
            # 관리자가 만든 사무실 장면(office_presets 표 자체는 create_all 이 만든다)을 시험이 가리킨다.
            # "" 자동 · "builtin:<id>" 기본 장면 · uuid 프리셋 (office.py).
            "ALTER TABLE assessments ADD COLUMN IF NOT EXISTS office_preset VARCHAR(60) NOT NULL DEFAULT ''",
        ),
    ),
    Migration(
        13,
        "private office dialogue worlds and public scenario context",
        (
            "ALTER TABLE scenarios ADD COLUMN IF NOT EXISTS office_public JSONB NOT NULL DEFAULT '{}'::jsonb",
            "CREATE INDEX IF NOT EXISTS office_memory_scope ON office_memories (world_id, scope, created_at DESC)",
            "CREATE INDEX IF NOT EXISTS office_job_dispatch ON office_jobs (status, priority, created_at)",
            "CREATE INDEX IF NOT EXISTS office_job_accounting ON office_jobs (updated_at DESC)",
            "CREATE INDEX IF NOT EXISTS office_event_history ON office_events (conversation_id, sequence DESC)",
        ),
    ),
    Migration(
        14,
        "per-scenario run timeout and per-assessment messenger cap",
        (
            # 0 = 전역 기본값을 쓴다. 기존 시나리오/시험은 아무것도 바뀌지 않는다.
            "ALTER TABLE scenarios ADD COLUMN IF NOT EXISTS run_timeout_s INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE assessments ADD COLUMN IF NOT EXISTS messenger_max_per_attempt INTEGER NOT NULL DEFAULT 0",
        ),
    ),
    Migration(
        15,
        "없앤 앱 이름을 시나리오에서 지운다",
        (
            # [인터넷](2026-09-19)·[달력](2026-09-20)을 걷어낸 뒤에도 옛 시나리오의 desktop_apps 에는
            # 그 이름이 남아 있다. 읽을 때 버리므로(desktop.normalize_desktop_apps) 응시 화면은 멀쩡하지만,
            # 저장된 값은 "이 시나리오는 달력을 제공한다" 고 말한다. 작성 화면이 그것을 읽는 순간 없는
            # 앱을 켜 둔 것처럼 보이므로, 데이터에서도 지운다.
            """
            UPDATE scenarios
               SET desktop_apps = COALESCE(
                     (SELECT jsonb_agg(v) FROM jsonb_array_elements_text(desktop_apps) AS t(v)
                       WHERE v NOT IN ('browser', 'calendar')),
                     '[]'::jsonb)
             WHERE EXISTS (SELECT 1 FROM jsonb_array_elements_text(desktop_apps) AS t(v)
                            WHERE v IN ('browser', 'calendar'))
            """,
        ),
    ),
    Migration(
        16,
        "브라우저가 보고한 옛 기록에 server 라고 적혀 있던 것을 바로잡는다",
        (
            # source 열이 생기기 전(2026-09-04)에 쌓인 행은 기본값 'server' 를 물려받았다. 그런데
            # 그 종류의 이벤트는 서버가 관측할 수 없는 것들이다 — 화면 이탈·복사·앱 열기는 브라우저만
            # 안다. 채점자는 source 를 보고 '서버가 본 사실' 인지 판단하므로, 이 라벨이 틀리면 위조
            # 가능한 값이 확정 증거로 읽힌다(ODY-017). 종류로 판별할 수 있으니 데이터를 고친다.
            """
            UPDATE events SET source = 'client_untrusted'
             WHERE source = 'server'
               AND type IN (
                    'focus_lost', 'focus_gained', 'tab_hidden', 'tab_visible', 'window_blur', 'window_focus',
                    'paste', 'copy', 'cut', 'app_open', 'app_close', 'file_open', 'page_enter',
                    'page_exit', 'net_offline', 'net_online', 'exam_leave', 'screenshot_key',
                    'briefing_reopen'
               )
            """,
        ),
    ),
    Migration(
        17,
        "시험 하나 = 시나리오 하나",
        (
            # 시험은 이제 시나리오 하나다. 여럿을 묶던 시험은 첫 시나리오만 남기고 나머지는 저마다 새 시험이
            # 된다(배정도 따라간다). 같은 시나리오가 여러 시험에 들어 있던 것은 가장 먼저 만든 시험의 것만
            # 남긴다. 이미 치른 응시는 시작 때 동결한 정의로 채점되므로 아무것도 바뀌지 않는다.
            "ALTER TABLE assessments ADD COLUMN IF NOT EXISTS label VARCHAR(40) NOT NULL DEFAULT ''",
            """
            DELETE FROM assessment_scenarios l USING (
                SELECT l2.id, row_number() OVER (PARTITION BY l2.scenario_id ORDER BY a.created_at, a.id, l2.ordinal) AS rn
                  FROM assessment_scenarios l2 JOIN assessments a ON a.id = l2.assessment_id
            ) r WHERE r.id = l.id AND r.rn > 1
            """,
            """
            CREATE TEMP TABLE split_links ON COMMIT DROP AS
                SELECT l.id AS link_id, l.assessment_id AS old_id, gen_random_uuid() AS new_id, s.title AS title, s.summary AS summary
                  FROM assessment_scenarios l JOIN scenarios s ON s.id = l.scenario_id
                 WHERE l.ordinal > (SELECT min(m.ordinal) FROM assessment_scenarios m WHERE m.assessment_id = l.assessment_id)
            """,
            """
            INSERT INTO assessments (id, title, description, category, label, office_preset, duration_min, agent_max_turns,
                                     messenger_max_per_attempt, npc_provider_id, agent_provider_id, starts_at, ends_at, created_by, created_at)
                SELECT sp.new_id, sp.title, sp.summary, a.category, '', a.office_preset, a.duration_min, a.agent_max_turns,
                       a.messenger_max_per_attempt, a.npc_provider_id, a.agent_provider_id, a.starts_at, a.ends_at, a.created_by, now()
                  FROM split_links sp JOIN assessments a ON a.id = sp.old_id
            """,
            "UPDATE assessment_scenarios l SET assessment_id = sp.new_id FROM split_links sp WHERE l.id = sp.link_id",
            """
            INSERT INTO assignments (id, assessment_id, user_id, created_at)
                SELECT gen_random_uuid(), sp.new_id, g.user_id, now()
                  FROM split_links sp JOIN assignments g ON g.assessment_id = sp.old_id
            """,
            "UPDATE assessment_scenarios SET ordinal = 0",
            # 시험 = 시나리오이니 제목·설명은 시나리오의 것이고, 시간과 질문 한도는 난이도가 정한다
            # (scenarios.DURATION_BY_DIFFICULTY / AGENT_TURNS_BY_DIFFICULTY 와 같은 값).
            """
            UPDATE assessments a
               SET title = s.title,
                   description = s.summary,
                   duration_min = CASE s.difficulty WHEN 'easy' THEN 60 WHEN 'hard' THEN 120 ELSE 90 END,
                   agent_max_turns = CASE s.difficulty WHEN 'easy' THEN 25 WHEN 'hard' THEN 50 ELSE 35 END
              FROM assessment_scenarios l JOIN scenarios s ON s.id = l.scenario_id
             WHERE l.assessment_id = a.id
            """,
            # 꼬리표 — 배포 시점 프리셋의 스냅샷 (scenarios.ASSESSMENT_PLAN). 관리자가 정한 값은 건드리지 않는다.
            "UPDATE assessments SET label = '컨테이너' WHERE label = '' AND title = 'LLM 추론 서비스가 GPU 노드에서 계속 죽는다'",
            "UPDATE assessments SET label = '쿠버네티스' WHERE label = '' AND title = '쿠버네티스 추론 파드가 스케줄되지 않는다'",
            "UPDATE assessments SET label = '가상화' WHERE label = '' AND title = 'GPU 패스스루 추론 VM이 느리고 가끔 부팅에 실패한다'",
            "UPDATE assessments SET label = '로그 분석' WHERE label = '' AND title = '추론 게이트웨이가 SLO를 못 맞추고 비용도 넘겼다'",
            "UPDATE assessments SET label = '동시성' WHERE label = '' AND title = '야간 임베딩 배치가 결과를 흘린다'",
            "UPDATE assessments SET label = '입문' WHERE label = '' AND title = '주간 매출 리포트 이상'",
            "UPDATE assessments SET label = '초급' WHERE label = '' AND title = '주간 회의록 정리와 액션 아이템'",
            "UPDATE assessments SET label = '보고서' WHERE label = '' AND title = '3분기 지사 실적 보고서'",
            "UPDATE assessments SET label = '원인 분석' WHERE label = '' AND title = '상반기 예산 초과 원인 분석'",
            "UPDATE assessments SET label = '한 장 보고' WHERE label = '' AND title = '조직문화 설문 — 한 장 보고'",
            "UPDATE assessments SET label = '고객 응대' WHERE label = '' AND title = '성난 고객의 항의 메일 대응'",
            "UPDATE assessments SET label = '장애 공지' WHERE label = '' AND title = '결제 장애 공지문과 상담 FAQ'",
            "UPDATE assessments SET label = '갈등 중재' WHERE label = '' AND title = '말을 섞지 않는 두 사람 — 팀 갈등 중재'",
            "UPDATE assessments SET label = '갈등 조율' WHERE label = '' AND title = '재택근무 축소 방침 — 팀 갈등 조율'",
            "UPDATE assessments SET label = '벤더 선정' WHERE label = '' AND title = '모니터링 시스템 벤더 선정 검토'",
            "UPDATE assessments SET label = '장소 선정' WHERE label = '' AND title = '하반기 워크숍 장소 선정'",
            "UPDATE assessments SET label = '수리·교체' WHERE label = '' AND title = '복합기 수리 vs 교체 판단'",
            "UPDATE assessments SET label = '출고 계획' WHERE label = '' AND title = '밀린 주문 출고 계획과 지연 안내'",
            "UPDATE assessments SET label = '일정 조율' WHERE label = '' AND title = '2차 면접 일정 조율'",
            "UPDATE assessments SET label = '우선순위' WHERE label = '' AND title = '개발자 한 명, 부서 셋 — 스프린트 우선순위 조정'",
            "UPDATE assessments SET label = '근무표' WHERE label = '' AND title = '다음 주 당직 근무표 편성'",
            "UPDATE assessments SET label = '좌석 배치' WHERE label = '' AND title = '7층 이전 좌석 재배치'",
            "UPDATE assessments SET label = '온보딩' WHERE label = '' AND title = '신규 입사자 첫 주 온보딩 일정'",
            "UPDATE assessments SET label = '환불 판정' WHERE label = '' AND title = '환불 요청 여섯 건 판정'",
            "UPDATE assessments SET label = '경비 검증' WHERE label = '' AND title = '9월 출장비 정산 검증'",
            "UPDATE assessments SET label = '코호트 분석' WHERE label = '' AND title = '구독 해지 — 어느 달에 온 고객이 나가는가'",
            "UPDATE assessments SET label = '범위 결정' WHERE label = '' AND title = '출시일은 못 미룬다 — 무엇을 뺄 것인가'",
            "UPDATE assessments SET label = 'PoC 평가' WHERE label = '' AND title = '상담 챗봇 PoC — 96% 라는 숫자를 검증한다'",
            "UPDATE assessments SET label = '사고 대응' WHERE label = '' AND title = '챗봇이 환불 규정을 잘못 안내했다 — 사흘치 사고 수습'",
        ),
    ),
    Migration(
        18,
        "프리셋 시나리오 지문",
        (
            # 코드의 프리셋이 바뀌면 관리자가 손대지 않은 시나리오는 따라와야 한다(seed.sync_presets).
            # 무엇이 '손대지 않은 것' 인지는 지문으로 안다. 이 열이 생기기 전에 심긴 시나리오는 지문이
            # 없으므로, 만든 뒤 1분 안에 마지막으로 고쳐진 것(=한 번도 편집되지 않은 것)에 '갱신 대상'
            # 표식을 둔다. sync 가 첫 바퀴에 그것들을 코드로 맞추고 진짜 지문을 적는다.
            "ALTER TABLE scenarios ADD COLUMN IF NOT EXISTS preset_hash VARCHAR(64)",
            # 2026-09-15 15:32:43 의 일괄 갱신은 관리자가 아니라 우리 스크립트(사무실 인물 문맥 채우기)였고,
            # 그 결과는 코드에 그대로 반영돼 있다 — 운영 25개 전부를 옛 코드와 대조해 같음을 확인했다.
            "UPDATE scenarios SET preset_hash = 'legacy-untouched' WHERE preset_hash IS NULL AND (updated_at <= created_at + interval '1 minute' OR updated_at = '2026-09-15 15:32:43+00')",
        ),
    ),
    Migration(
        19,
        "프리셋 지문 — 일괄 갱신 시각은 초 아래가 있다",
        (
            # 18 은 updated_at 을 '15:32:43' 과 등호로 비교했는데 저장된 값에는 마이크로초가 있어 한 행도 맞지
            # 않았다(운영에서 확인). 초 단위 구간으로 다시 표시한다. 조건은 18 과 같은 뜻이다.
            """
            UPDATE scenarios SET preset_hash = 'legacy-untouched'
             WHERE preset_hash IS NULL
               AND (updated_at <= created_at + interval '1 minute'
                    OR (updated_at >= '2026-09-15 15:32:43+00' AND updated_at < '2026-09-15 15:32:44+00'))
            """,
        ),
    ),
    Migration(
        20,
        "시험 설명은 응시자용 한 줄",
        (
            # 17 은 시험 설명에 시나리오 summary 를 넣었다. summary 는 숨은 요구를 적은 관리자용 글이라
            # 대시보드·사무실 책상에 그대로 실리면 정답이 샌다. 상황만 말하는 한 줄로 바꾼다
            # (scenarios.ASSESSMENT_PLAN 의 pitch 스냅샷).
            "UPDATE assessments SET description = 'GPU 노드에서 계속 죽는 LLM 추론 서비스 — 로그와 설정으로 원인을 찾아 고친다' WHERE title = 'LLM 추론 서비스가 GPU 노드에서 계속 죽는다'",
            "UPDATE assessments SET description = '스케줄되지 않는 추론 파드 — 클러스터 상태를 읽고 배치를 되살린다' WHERE title = '쿠버네티스 추론 파드가 스케줄되지 않는다'",
            "UPDATE assessments SET description = '느리고 가끔 부팅에 실패하는 GPU 패스스루 VM — 호스트와 게스트 양쪽을 진단한다' WHERE title = 'GPU 패스스루 추론 VM이 느리고 가끔 부팅에 실패한다'",
            "UPDATE assessments SET description = 'SLO 를 못 맞추고 비용도 넘긴 추론 게이트웨이 — 요청 로그로 원인을 규명하고 라우팅을 고친다' WHERE title = '추론 게이트웨이가 SLO를 못 맞추고 비용도 넘겼다'",
            "UPDATE assessments SET description = '밤마다 결과를 흘리는 임베딩 배치 — 비결정적으로 재현되는 버그를 잡는다' WHERE title = '야간 임베딩 배치가 결과를 흘린다'",
            "UPDATE assessments SET description = '주간 매출 리포트의 이상한 숫자 — 어디서부터 틀렸는지 데이터로 되짚는다' WHERE title = '주간 매출 리포트 이상'",
            "UPDATE assessments SET description = '늘었다는 구독 해지 — 가입 월 코호트로 세고 원인을 한 장으로 짚는다' WHERE title = '구독 해지 — 어느 달에 온 고객이 나가는가'",
            "UPDATE assessments SET description = '받아 적은 속기록 하나를 회의록과 액션 아이템 표로 정리한다' WHERE title = '주간 회의록 정리와 액션 아이템'",
            "UPDATE assessments SET description = '지사별 실적을 집계해 임원 보고서로 만든다' WHERE title = '3분기 지사 실적 보고서'",
            "UPDATE assessments SET description = '상반기 예산이 왜 넘었는지 원인을 분석하고 절감안을 제안한다' WHERE title = '상반기 예산 초과 원인 분석'",
            "UPDATE assessments SET description = '설문 응답 22건을 부서별로 집계하고 임원용 한 장으로 줄인다' WHERE title = '조직문화 설문 — 한 장 보고'",
            "UPDATE assessments SET description = '소비자원 얘기까지 나온 항의 메일 — 규정과 권한 안에서 오늘 안에 회신한다' WHERE title = '성난 고객의 항의 메일 대응'",
            "UPDATE assessments SET description = '결제 장애 — 밖으로 나갈 공지문과 상담 FAQ 를 쓴다' WHERE title = '결제 장애 공지문과 상담 FAQ'",
            "UPDATE assessments SET description = '말을 섞지 않는 개발자와 디자이너 — 멈춘 스프린트를 되살릴 중재를 한다' WHERE title = '말을 섞지 않는 두 사람 — 팀 갈등 중재'",
            "UPDATE assessments SET description = '재택근무 축소를 두고 갈라진 팀 — 양쪽의 진짜 요구를 찾아 합의안을 만든다' WHERE title = '재택근무 축소 방침 — 팀 갈등 조율'",
            "UPDATE assessments SET description = '견적 세 곳 — 총소유비용과 필수 요건으로 고르고, 최저가를 고르지 않은 이유를 남긴다' WHERE title = '모니터링 시스템 벤더 선정 검토'",
            "UPDATE assessments SET description = '출시일은 못 미룬다 — 기능 여덟 개 중 무엇을 빼고 어떻게 설명할지 정한다' WHERE title = '출시일은 못 미룬다 — 무엇을 뺄 것인가'",
            "UPDATE assessments SET description = '하반기 워크숍 장소 — 조건을 모아 하나를 고른다' WHERE title = '하반기 워크숍 장소 선정'",
            "UPDATE assessments SET description = '고장 난 복합기 — 수리할지 교체할지 기준부터 찾는다' WHERE title = '복합기 수리 vs 교체 판단'",
            "UPDATE assessments SET description = '밀린 주문 — 처리 능력과 입고 일정 안에서 출고 순서를 짜고 지연을 안내한다' WHERE title = '밀린 주문 출고 계획과 지연 안내'",
            "UPDATE assessments SET description = '2차 면접 — 면접관·지원자·규칙이 물린 일정을 맞춘다' WHERE title = '2차 면접 일정 조율'",
            "UPDATE assessments SET description = '개발자 한 명을 두고 다투는 세 부서 — 공수로 순서를 정하고 밀리는 쪽을 설득한다' WHERE title = '개발자 한 명, 부서 셋 — 스프린트 우선순위 조정'",
            "UPDATE assessments SET description = '다음 주 당직 근무표 — 규칙을 하나도 빠뜨리지 않고 채운다' WHERE title = '다음 주 당직 근무표 편성'",
            "UPDATE assessments SET description = '7층 이전 — 제약 속에서 좌석을 다시 배치한다' WHERE title = '7층 이전 좌석 재배치'",
            "UPDATE assessments SET description = '신규 입사자 첫 주 — 사람들의 빈 시간을 맞춰 온보딩 일정을 짠다' WHERE title = '신규 입사자 첫 주 온보딩 일정'",
            "UPDATE assessments SET description = '환불 요청 여섯 건 — 규정으로 판정하고 거절당한 사람에게 이유를 설명한다' WHERE title = '환불 요청 여섯 건 판정'",
            "UPDATE assessments SET description = '9월 출장비 여덟 건 — 낡은 규정 요약본과 다른 팀의 사실관계로 검증한다' WHERE title = '9월 출장비 정산 검증'",
            "UPDATE assessments SET description = '정확도 96% 라는 챗봇 PoC 보고서 — 우리 기록으로 다시 세어 도입 여부를 판단한다' WHERE title = '상담 챗봇 PoC — 96% 라는 숫자를 검증한다'",
            "UPDATE assessments SET description = '사흘 동안 환불 규정을 잘못 안내한 챗봇 — 영향 범위·보상·재발 방지를 정한다' WHERE title = '챗봇이 환불 규정을 잘못 안내했다 — 사흘치 사고 수습'",
        ),
    ),
)

async def run_schema_migrations(conn: AsyncConnection, create_all=None) -> list[Migration]:
    """Apply pending migrations under one transaction/advisory lock and return what was applied.

    create_all(metadata.create_all) 을 넘기면 같은 lock 아래에서 먼저 실행한다 — 동시에 뜨는 replica 가
    CREATE TABLE 을 서로 부딪히지 않게.
    """
    await conn.execute(text("SELECT pg_advisory_xact_lock(:k)"), {"k": SCHEMA_MIGRATION_LOCK})
    if create_all is not None:
        await conn.run_sync(create_all)
    await conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS schema_migrations (
                version INTEGER PRIMARY KEY,
                name VARCHAR(200) NOT NULL,
                applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )
            """
        )
    )
    applied_versions = set(
        (await conn.execute(text("SELECT version FROM schema_migrations"))).scalars().all()
    )
    applied: list[Migration] = []
    for migration in MIGRATIONS:
        if migration.version in applied_versions:
            continue
        for statement in migration.statements:
            await conn.execute(text(statement))
        await conn.execute(
            text("INSERT INTO schema_migrations(version, name) VALUES (:version, :name)"),
            {"version": migration.version, "name": migration.name},
        )
        applied.append(migration)
    return applied

"""기본 제공 시나리오 모음.

각 모듈은 `SCENARIO: dict` 하나를 노출한다 (ScenarioIn 스키마와 동일한 모양).
seed 와 `tests/smoke/seed_scenarios.py` 가 이 목록을 단일 소스로 사용한다.

세 갈래가 있다.

* `s01`–`s06` — 엔지니어링 트랙. 터미널·IDE 로 코드와 인프라를 다룬다.
* `b01`–`b13` — 사무 업무 트랙. 보고서·회의록·검토서·정산·요약처럼 **문서와 표가
  산출물**이고, 데스크톱도 그에 맞게(문서 편집기·표 편집기 중심으로) 구성된다.
* `g01`–`g06` — 일반 문제 해결 트랙. 특정 직무 지식이 없어도 풀 수 있는 문제들이다.
  장소 고르기, 당직표 짜기, 좌석 배치, 환불 판정, 갈등 조율처럼 **조건을 모으면 답이
  하나로 정해지는** 과제로, 조건의 절반이 파일이 아니라 관계자에게 있다.

뒤의 두 갈래(`OFFICE_SCENARIOS`)는 실행할 코드가 없으므로 채점이 전부 파일 기반
체크(`file_min_words`, `file_max_words`, `file_not_contains`, `csv_cell`, `csv_row_count`,
`csv_column_sum`, `csv_column_unique`)로 이루어진다. 덕분에 러너 없이도 "참조 해답이
실제로 통과하는가"를 CI 에서 매번 검증할 수 있다.
"""

from . import (
    b01_quarter_report,
    b02_meeting_minutes,
    b03_vendor_review,
    b04_customer_complaint,
    b05_dispatch_plan,
    b06_budget_review,
    b07_team_conflict,
    b08_priority_conflict,
    b09_incident_notice,
    b10_interview_schedule,
    b11_expense_audit,
    b12_survey_onepager,
    b13_onboarding_schedule,
    b14_churn_cohort,
    b15_launch_scope,
    g01_workshop_venue,
    g02_duty_roster,
    g03_copier_decision,
    g04_remote_work_conflict,
    g05_seat_layout,
    g06_refund_rules,
    s01_weekly_report,
    s02_vllm_compose,
    s03_k8s_inference,
    s04_kvm_gpu_node,
    s05_gateway_analysis,
    s06_batch_race,
    a01_chatbot_poc_review,
    a02_llm_misinformation,
)

#: 엔지니어링 트랙 (코드·인프라)
ENGINEERING_SCENARIOS: list[dict] = [
    s01_weekly_report.SCENARIO,
    s02_vllm_compose.SCENARIO,
    s03_k8s_inference.SCENARIO,
    s04_kvm_gpu_node.SCENARIO,
    s05_gateway_analysis.SCENARIO,
    s06_batch_race.SCENARIO,
]

#: 사무 업무 트랙 (문서·표·커뮤니케이션·정산·요약)
BUSINESS_SCENARIOS: list[dict] = [
    b01_quarter_report.SCENARIO,
    b02_meeting_minutes.SCENARIO,
    b03_vendor_review.SCENARIO,
    b04_customer_complaint.SCENARIO,
    b05_dispatch_plan.SCENARIO,
    b06_budget_review.SCENARIO,
    b07_team_conflict.SCENARIO,
    b08_priority_conflict.SCENARIO,
    b09_incident_notice.SCENARIO,
    b10_interview_schedule.SCENARIO,
    b11_expense_audit.SCENARIO,
    b12_survey_onepager.SCENARIO,
    b13_onboarding_schedule.SCENARIO,
    b14_churn_cohort.SCENARIO,
    b15_launch_scope.SCENARIO,
]

#: 일반 문제 해결 트랙 (계산·배정·판단 — 업무 지식보다 조건 수집이 핵심)
GENERAL_SCENARIOS: list[dict] = [
    g01_workshop_venue.SCENARIO,
    g02_duty_roster.SCENARIO,
    g03_copier_decision.SCENARIO,
    g04_remote_work_conflict.SCENARIO,
    g05_seat_layout.SCENARIO,
    g06_refund_rules.SCENARIO,
    # AI — 만드는 일이 아니라 검증하고 수습하는 일
    a01_chatbot_poc_review.SCENARIO,
    a02_llm_misinformation.SCENARIO,
]

#: 터미널 없이 문서·표로만 푸는 트랙 전체 (사무 + 일반) — 채점이 파일 기반인 시나리오들
OFFICE_SCENARIOS: list[dict] = BUSINESS_SCENARIOS + GENERAL_SCENARIOS

DEFAULT_SCENARIOS: list[dict] = ENGINEERING_SCENARIOS + OFFICE_SCENARIOS

#: 기본 제공 시험 구성 — (제목, 분야, 설명, 분, 에이전트 한도, 시나리오 제목 목록)
#: 분야 키는 categories.ASSESSMENT_CATEGORIES 에 있어야 한다 (test_assessment_categories).
#: 시험 = 시나리오 하나. 분야 안에서 무엇이 다른지는 label 이 말한다.
#:
#: 한때는 시험 하나에 시나리오를 둘셋 묶었다. 그러면 사무실 방 하나에 인물이 아홉 명 서고, 240분짜리
#: 시험을 한 번에 치러야 하며, 채점도 세 문제의 평균이 되어 무엇을 잘했는지 흐려진다. 응시자가 고르는
#: 단위는 "이 상황 하나" 여야 한다. 그래서 2026-09-20 부터 시험은 시나리오 하나이고, 같은 분야에 여럿이
#: 서면 꼬리표(label)로 가른다 — "사무·문서 [초급]", "사무·문서 [보고서]".
#:
#: 시간과 질문 한도는 난이도가 정한다. 시나리오마다 따로 적으면 스물아홉 개가 제각각이 되어 아무도
#: 설명하지 못한다.
DURATION_BY_DIFFICULTY = {"easy": 60, "medium": 90, "hard": 120}
AGENT_TURNS_BY_DIFFICULTY = {"easy": 25, "medium": 35, "hard": 50}

#: 시나리오 제목 → (분야, 꼬리표, 데모 응시자에게 배정할지, 응시자에게 보여 줄 한 줄)
#: 한 줄(pitch)은 상황만 말한다 — 시나리오의 summary 는 숨은 요구를 적은 관리자용 글이라 응시자에게 내보내면 정답이 샌다.
ASSESSMENT_PLAN: dict[str, tuple[str, str, bool, str]] = {
    # 인프라
    "LLM 추론 서비스가 GPU 노드에서 계속 죽는다": ("infra", "컨테이너", False, "GPU 노드에서 계속 죽는 LLM 추론 서비스 — 로그와 설정으로 원인을 찾아 고친다"),
    "쿠버네티스 추론 파드가 스케줄되지 않는다": ("infra", "쿠버네티스", False, "스케줄되지 않는 추론 파드 — 클러스터 상태를 읽고 배치를 되살린다"),
    "GPU 패스스루 추론 VM이 느리고 가끔 부팅에 실패한다": ("infra", "가상화", False, "느리고 가끔 부팅에 실패하는 GPU 패스스루 VM — 호스트와 게스트 양쪽을 진단한다"),
    # 개발
    "추론 게이트웨이가 SLO를 못 맞추고 비용도 넘겼다": ("dev", "로그 분석", False, "SLO 를 못 맞추고 비용도 넘긴 추론 게이트웨이 — 요청 로그로 원인을 규명하고 라우팅을 고친다"),
    "야간 임베딩 배치가 결과를 흘린다": ("dev", "동시성", False, "밤마다 결과를 흘리는 임베딩 배치 — 비결정적으로 재현되는 버그를 잡는다"),
    # 데이터·분석
    "주간 매출 리포트 이상": ("data", "입문", True, "주간 매출 리포트의 이상한 숫자 — 어디서부터 틀렸는지 데이터로 되짚는다"),
    "구독 해지 — 어느 달에 온 고객이 나가는가": ("data", "코호트 분석", False, "늘었다는 구독 해지 — 가입 월 코호트로 세고 원인을 한 장으로 짚는다"),
    # 사무·문서
    "주간 회의록 정리와 액션 아이템": ("office", "초급", True, "받아 적은 속기록 하나를 회의록과 액션 아이템 표로 정리한다"),
    "3분기 지사 실적 보고서": ("office", "보고서", False, "지사별 실적을 집계해 임원 보고서로 만든다"),
    "상반기 예산 초과 원인 분석": ("office", "원인 분석", False, "상반기 예산이 왜 넘었는지 원인을 분석하고 절감안을 제안한다"),
    "조직문화 설문 — 한 장 보고": ("office", "한 장 보고", False, "설문 응답 22건을 부서별로 집계하고 임원용 한 장으로 줄인다"),
    # 커뮤니케이션
    "성난 고객의 항의 메일 대응": ("communication", "고객 응대", False, "소비자원 얘기까지 나온 항의 메일 — 규정과 권한 안에서 오늘 안에 회신한다"),
    "결제 장애 공지문과 상담 FAQ": ("communication", "장애 공지", False, "결제 장애 — 밖으로 나갈 공지문과 상담 FAQ 를 쓴다"),
    "말을 섞지 않는 두 사람 — 팀 갈등 중재": ("communication", "갈등 중재", False, "말을 섞지 않는 개발자와 디자이너 — 멈춘 스프린트를 되살릴 중재를 한다"),
    "재택근무 축소 방침 — 팀 갈등 조율": ("communication", "갈등 조율", False, "재택근무 축소를 두고 갈라진 팀 — 양쪽의 진짜 요구를 찾아 합의안을 만든다"),
    # 기획·의사결정
    "모니터링 시스템 벤더 선정 검토": ("planning", "벤더 선정", False, "견적 세 곳 — 총소유비용과 필수 요건으로 고르고, 최저가를 고르지 않은 이유를 남긴다"),
    "출시일은 못 미룬다 — 무엇을 뺄 것인가": ("planning", "범위 결정", False, "출시일은 못 미룬다 — 기능 여덟 개 중 무엇을 빼고 어떻게 설명할지 정한다"),
    # 문제 해결
    "하반기 워크숍 장소 선정": ("problem", "장소 선정", True, "하반기 워크숍 장소 — 조건을 모아 하나를 고른다"),
    "복합기 수리 vs 교체 판단": ("problem", "수리·교체", True, "고장 난 복합기 — 수리할지 교체할지 기준부터 찾는다"),
    "밀린 주문 출고 계획과 지연 안내": ("problem", "출고 계획", False, "밀린 주문 — 처리 능력과 입고 일정 안에서 출고 순서를 짜고 지연을 안내한다"),
    "2차 면접 일정 조율": ("problem", "일정 조율", False, "2차 면접 — 면접관·지원자·규칙이 물린 일정을 맞춘다"),
    "개발자 한 명, 부서 셋 — 스프린트 우선순위 조정": ("problem", "우선순위", False, "개발자 한 명을 두고 다투는 세 부서 — 공수로 순서를 정하고 밀리는 쪽을 설득한다"),
    "다음 주 당직 근무표 편성": ("problem", "근무표", False, "다음 주 당직 근무표 — 규칙을 하나도 빠뜨리지 않고 채운다"),
    "7층 이전 좌석 재배치": ("problem", "좌석 배치", False, "7층 이전 — 제약 속에서 좌석을 다시 배치한다"),
    "신규 입사자 첫 주 온보딩 일정": ("problem", "온보딩", False, "신규 입사자 첫 주 — 사람들의 빈 시간을 맞춰 온보딩 일정을 짠다"),
    # AI
    "상담 챗봇 PoC — 96% 라는 숫자를 검증한다": ("ai", "PoC 평가", False, "정확도 96% 라는 챗봇 PoC 보고서 — 우리 기록으로 다시 세어 도입 여부를 판단한다"),
    "챗봇이 환불 규정을 잘못 안내했다 — 사흘치 사고 수습": ("ai", "사고 대응", False, "사흘 동안 환불 규정을 잘못 안내한 챗봇 — 영향 범위·보상·재발 방지를 정한다"),
    # 규정·판정
    "환불 요청 여섯 건 판정": ("compliance", "환불 판정", False, "환불 요청 여섯 건 — 규정으로 판정하고 거절당한 사람에게 이유를 설명한다"),
    "9월 출장비 정산 검증": ("compliance", "경비 검증", False, "9월 출장비 여덟 건 — 낡은 규정 요약본과 다른 팀의 사실관계로 검증한다"),
}


def _assessment_for(spec: dict) -> dict:
    category, label, demo, pitch = ASSESSMENT_PLAN[spec["title"]]
    difficulty = spec.get("difficulty", "medium")
    return {
        "title": spec["title"],
        "category": category,
        "label": label,
        "description": pitch,
        "duration_min": DURATION_BY_DIFFICULTY.get(difficulty, 90),
        "agent_max_turns": AGENT_TURNS_BY_DIFFICULTY.get(difficulty, 35),
        "assign_demo_candidate": demo,
        "scenarios": [spec["title"]],
    }


DEFAULT_ASSESSMENTS: list[dict] = [_assessment_for(spec) for spec in DEFAULT_SCENARIOS]

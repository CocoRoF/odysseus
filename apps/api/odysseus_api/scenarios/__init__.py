"""기본 제공 시나리오 모음.

각 모듈은 `SCENARIO: dict` 하나를 노출한다 (ScenarioIn 스키마와 동일한 모양).
seed 와 `tests/smoke/seed_scenarios.py` 가 이 목록을 단일 소스로 사용한다.
"""

from . import (
    s01_weekly_report,
    s02_vllm_compose,
    s03_k8s_inference,
    s04_kvm_gpu_node,
    s05_gateway_analysis,
    s06_batch_race,
)

DEFAULT_SCENARIOS: list[dict] = [
    s01_weekly_report.SCENARIO,
    s02_vllm_compose.SCENARIO,
    s03_k8s_inference.SCENARIO,
    s04_kvm_gpu_node.SCENARIO,
    s05_gateway_analysis.SCENARIO,
    s06_batch_race.SCENARIO,
]

#: 기본 제공 시험 구성 — (제목, 설명, 분, 에이전트 한도, 시나리오 제목 목록)
DEFAULT_ASSESSMENTS: list[dict] = [
    {
        "title": "실무 시뮬레이션 데모 — 매출 리포트",
        "description": "메신저로 관계자와 대화하며 요구사항을 파악하고, 워크스페이스에서 문제를 해결하세요.",
        "duration_min": 90,
        "agent_max_turns": 30,
        "assign_demo_candidate": True,
        "scenarios": ["주간 매출 리포트 이상"],
    },
    {
        "title": "인프라 심화 — LLM 추론 스택",
        "description": (
            "LLM 추론 인프라 장애 3종(컨테이너·쿠버네티스·가상화)을 실제 로그와 설정으로 진단하고 고칩니다. "
            "관계자에게 물어 요구사항을 스스로 확정해야 합니다."
        ),
        "duration_min": 240,
        "agent_max_turns": 60,
        "assign_demo_candidate": False,
        "scenarios": [
            "LLM 추론 서비스가 GPU 노드에서 계속 죽는다",
            "쿠버네티스 추론 파드가 스케줄되지 않는다",
            "GPU 패스스루 추론 VM이 느리고 가끔 부팅에 실패한다",
        ],
    },
    {
        "title": "심화 문제 해결 — 분석과 동시성",
        "description": "운영 로그 분석으로 SLO·비용 문제를 규명하고, 비결정적으로 재현되는 동시성 버그를 잡습니다.",
        "duration_min": 180,
        "agent_max_turns": 50,
        "assign_demo_candidate": False,
        "scenarios": [
            "추론 게이트웨이가 SLO를 못 맞추고 비용도 넘겼다",
            "야간 임베딩 배치가 결과를 흘린다",
        ],
    },
]

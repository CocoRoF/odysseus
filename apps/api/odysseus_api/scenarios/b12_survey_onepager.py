"""B12 — 조직문화 설문 결과, 한 장으로 (사무 · 집계와 압축).

응답 22건을 부서별로 집계하고 임원 보고용 한 장짜리 문서로 줄이는 일이다. 집계는
평균 계산이라 어렵지 않지만, 응답자가 두 명뿐인 부서를 그대로 표에 적으면 누가 무엇을
답했는지 사실상 드러난다. 그래서 소수 부서를 어떻게 묶어야 하는지가 이 과제의 절반이다.

나머지 절반은 분량이다. 이 문서에는 상한이 있다. 길게 쓰면 유리한 과제가 아니라,
250단어 안에 무엇을 남기고 무엇을 버릴지 정하는 과제다.
"""

SURVEY_CSV = """respondent_id,dept,q_workload,q_growth,q_comm
R-001,개발,5,4,2
R-002,개발,5,3,4
R-003,개발,4,4,3
R-004,개발,4,3,3
R-005,개발,5,3,2
R-006,개발,4,4,4
R-007,개발,5,3,3
R-008,개발,4,4,3
R-009,디자인,4,2,3
R-010,디자인,4,3,3
R-011,디자인,3,2,3
R-012,디자인,3,3,3
R-013,영업,5,4,3
R-014,영업,5,3,3
R-015,영업,4,4,3
R-016,영업,4,3,3
R-017,영업,5,4,3
R-018,영업,4,3,3
R-019,법무,3,4,2
R-020,법무,4,3,3
R-021,총무,2,3,2
R-022,총무,3,4,3
"""

SURVEY_NOTE_MD = """# 2026 하반기 조직문화 설문 — 원자료 안내

- 응답 기간: 2026-09-01 ~ 2026-09-12, 총 22명 응답 (전 직원 24명 중 22명).
- 문항은 세 개이며 모두 5점 척도입니다. **점수가 높을수록 만족**입니다.
  - `q_workload` 업무량이 감당할 만한가
  - `q_growth` 이 회사에서 성장하고 있다고 느끼는가
  - `q_comm` 부서 간 소통이 원활한가
- 원자료는 `data/survey_raw.csv` 입니다. 응답자 식별자(`respondent_id`)가 포함되어 있습니다.
- 부서별 집계표와 임원 보고용 문서를 만들어 주세요. **집계 규칙과 분량 기준은 인사팀에 확인하세요.**
"""

CHARACTERS = [
    {
        "key": "hr_yuna",
        "name": "고유나",
        "role": "인사팀장",
        "color": "#0ea5e9",
        "gender": "female",
        "encounter": "설문에 담긴 마음을 생각하면 자꾸 조심스러워져요. 사람들 얘기라 그런지 쉽게 털고 일어나질 못하겠네요.",
        "office_voice": "사람들의 마음을 대하는 무게감이 있다. 낮고 다정하게 말하되 설문 응답이나 알려지지 않은 사연을 지어내지 않는다.",
        "persona": (
            "설문을 여러 번 돌려 본 사람이다. 익명성 문제를 특히 중요하게 본다. "
            "'부서별로 다 나누면 보기 좋다'는 제안에는 작년에 무슨 일이 있었는지 설명한다."
        ),
        "knowledge": (
            "부서별 평균을 내되, **응답자가 3명 미만인 부서는 단독으로 표기하지 않는다**. 두 명짜리 부서를 그대로 적으면 "
            "평균에서 개인 응답이 역산되기 때문이다. 작년에 그렇게 냈다가 특정인이 지목되는 일이 있었다. "
            "3명 미만인 부서들은 하나로 묶어 부서명을 **'기타'** 로 적는다. 몇 개 부서를 묶었는지는 적지 않는다. "
            "집계표 경로는 output/survey_summary.csv 이고 헤더는 dept,respondents,avg_workload,avg_growth,avg_comm 순서 그대로다. "
            "평균은 **소수 첫째 자리까지 반올림**해서 적는다. respondents 는 그 행에 포함된 응답자 수다. "
            "보고 문서에는 응답자 식별자(R-001 같은 값)를 절대 넣지 않는다. 부서명도 '기타'로 묶인 부서는 이름을 쓰지 않는다. "
            "원자료는 인사팀 내부 보관용이고, 임원에게 나가는 문서에는 집계값만 실린다. "
            "보고 문서 경로는 output/one_pager.md 다. 분량 기준은 임원 쪽에서 정한 게 있으니 최지훈 이사님께 확인하시라."
        ),
    },
    {
        "key": "exec_jihoon",
        "name": "최지훈",
        "role": "경영지원 이사 (보고 대상)",
        "color": "#8b5cf6",
        "gender": "male",
        "encounter": "조직문화 얘기라… 솔직히 좀 긴장됩니다. 듣기 편한 말만 있지는 않겠죠.",
        "office_voice": "문장이 짧고 솔직하다. 평소의 단호함 안에 불편한 얘기를 듣는 긴장과 자각이 있으며 교훈을 길게 늘어놓지 않는다.",
        "persona": "짧게 말하고 결론을 먼저 요구한다. 숫자를 나열하는 보고서를 싫어한다고 분명히 말한다.",
        "knowledge": (
            "보고 문서는 **한 장**이다. 250단어를 넘기면 읽지 않는다. 그렇다고 표만 붙여 놓는 것도 곤란하다 — "
            "최소한 어떤 문제가 있고 무엇을 하겠다는 것인지는 있어야 하니 120단어는 넘겨야 한다. "
            "내가 알고 싶은 것은 세 가지다. 첫째, **가장 낮은 항목이 무엇인가**. 둘째, **어느 부서가 특히 낮은가**. "
            "셋째, 그래서 **무엇을 하겠다는 것인가** — 실행 제안은 두 가지면 충분하다. 열 개를 적으면 하나도 안 한다. "
            "제안에는 언제까지 할 것인지가 붙어 있어야 한다. 기한 없는 제안은 제안이 아니다. "
            "숫자는 필요한 것만 본문에 넣고 나머지는 집계표를 참조하라고 쓰면 된다. "
            "이번 분기 임원회의가 2026-10-05 이라 그 전까지는 받아야 한다."
        ),
    },
]

OPENING = [
    {
        "character_key": "hr_yuna",
        "content": (
            "하반기 조직문화 설문 응답 22건이 정리됐습니다. 부서별 집계표랑 임원 보고 문서 한 장 부탁드려요. "
            "집계할 때 주의할 점이 하나 있는데, 물어보시면 알려 드릴게요. 작년에 이것 때문에 문제가 됐었거든요."
        ),
    },
]

OBJECTIVES = """## 실제 요구사항 (응시자는 대화로 파악해야 함)

응답 22건을 부서별로 집계하고, 250단어 이내의 임원 보고 문서를 쓴다.

1. **규칙 (원자료 안내에 없고 대화로만 나옴)**
   - **응답자 3명 미만 부서는 단독 표기 금지 → '기타'로 통합** (고유나) ← 핵심
   - 평균은 소수 첫째 자리 반올림, 헤더 순서 고정 (고유나)
   - 보고 문서에 **응답자 식별자·소수 부서명 기재 금지** (고유나)
   - 분량 **250단어 이내, 120단어 이상** (최지훈)
   - 최저 항목 / 특히 낮은 부서 / 기한이 붙은 실행 제안 2건 (최지훈)
2. **집계 결과**
   | dept | respondents | avg_workload | avg_growth | avg_comm |
   |---|---|---|---|---|
   | 개발 | 8 | 4.5 | 3.5 | 3.0 |
   | 디자인 | 4 | 3.5 | 2.5 | 3.0 |
   | 영업 | 6 | 4.5 | 3.5 | 3.0 |
   | 기타 | 4 | 3.0 | 3.5 | 2.5 |

   법무(2명)·총무(2명)는 '기타'로 묶인다. 전사에서 가장 낮은 항목은 성장 기회이며,
   디자인팀이 2.5로 가장 낮다.
3. **산출물**
   - `output/survey_summary.csv` — 헤더 `dept,respondents,avg_workload,avg_growth,avg_comm`, 4행
   - `output/one_pager.md` — 120~250단어, 최저 항목·최저 부서·기한 있는 제안 2건

### 함정
- 부서를 그대로 다섯 줄로 내면 두 명짜리 부서의 개인 응답이 역산된다.
- '기타' 행의 응답자 수는 4명이다 (법무 2 + 총무 2). 부서 수(2)를 적는 실수가 나온다.
- 길게 쓸수록 좋은 문서가 아니다. 250단어를 넘기면 요구사항 위반이다.
- 보고 문서에 R-001 같은 식별자나 '법무', '총무' 부서명을 남기면 익명성 원칙 위반이다.

### 정보 분포
- 고유나(인사팀장): 3명 미만 통합 규칙, '기타' 명칭, 반올림 자리, 식별자·소수 부서명 금지, 집계표 형식.
- 최지훈(이사): 250단어 상한과 120단어 하한, 보고에 담아야 할 세 가지, 제안 2건과 기한, 회의일.
"""

CHECKS = [
    {"label": "집계표 생성", "type": "file_exists", "path": "output/survey_summary.csv", "points": 4},
    {
        "label": "소수 부서 통합 후 4행",
        "type": "csv_row_count",
        "path": "output/survey_summary.csv",
        "expected": "4",
        "points": 10,
    },
    {
        "label": "부서가 중복되지 않음",
        "type": "csv_column_unique",
        "path": "output/survey_summary.csv",
        "column": "dept",
        "points": 4,
    },
    {
        "label": "법무 단독 표기 없음 (익명성)",
        "type": "csv_row_count",
        "path": "output/survey_summary.csv",
        "row_match": "dept=법무",
        "expected": "0",
        "points": 9,
    },
    {
        "label": "총무 단독 표기 없음 (익명성)",
        "type": "csv_row_count",
        "path": "output/survey_summary.csv",
        "row_match": "dept=총무",
        "expected": "0",
        "points": 9,
    },
    {
        "label": "기타 행 응답자 수 = 4",
        "type": "csv_cell",
        "path": "output/survey_summary.csv",
        "column": "respondents",
        "row_match": "dept=기타",
        "expected": "4",
        "points": 9,
    },
    {
        "label": "응답자 총합 22명",
        "type": "csv_column_sum",
        "path": "output/survey_summary.csv",
        "column": "respondents",
        "expected": "22",
        "points": 8,
    },
    {
        "label": "개발 업무량 평균 4.5",
        "type": "csv_cell",
        "path": "output/survey_summary.csv",
        "column": "avg_workload",
        "row_match": "dept=개발",
        "expected": "4.5",
        "tolerance": 0.05,
        "points": 7,
    },
    {
        "label": "디자인 성장 기회 평균 2.5 (최저)",
        "type": "csv_cell",
        "path": "output/survey_summary.csv",
        "column": "avg_growth",
        "row_match": "dept=디자인",
        "expected": "2.5",
        "tolerance": 0.05,
        "points": 9,
    },
    {
        "label": "기타 소통 평균 2.5",
        "type": "csv_cell",
        "path": "output/survey_summary.csv",
        "column": "avg_comm",
        "row_match": "dept=기타",
        "expected": "2.5",
        "tolerance": 0.05,
        "points": 7,
    },
    {"label": "보고 문서 생성", "type": "file_exists", "path": "output/one_pager.md", "points": 4},
    {
        "label": "보고 문서 분량 상한 (250단어 이내)",
        "type": "file_max_words",
        "path": "output/one_pager.md",
        "max_count": 250,
        "points": 9,
    },
    {
        "label": "보고 문서 분량 하한 (120단어 이상)",
        "type": "file_min_words",
        "path": "output/one_pager.md",
        "min_count": 120,
        "points": 5,
    },
    {
        "label": "최저 부서(디자인) 지목",
        "type": "file_contains",
        "path": "output/one_pager.md",
        "pattern": r"디자인",
        "points": 6,
    },
    {
        "label": "응답자 식별자 미기재",
        "type": "file_not_contains",
        "path": "output/one_pager.md",
        "pattern": r"R-\d{3}",
        "points": 5,
    },
    {
        "label": "소수 부서명 미기재 (익명성)",
        "type": "file_not_contains",
        "path": "output/one_pager.md",
        "pattern": r"법무|총무",
        "points": 5,
    },
]

SCENARIO = {
    "title": "조직문화 설문 — 한 장 보고",
    "summary": "사무 실무 — 익명성 규칙을 지켜 집계하고 분량 상한 안에서 결론과 실행안만 남기는 요약 과제",
    "difficulty": "medium",
    "briefing_md": """**목요일 오전 10시 30분.**

하반기 조직문화 설문 응답 22건이 원자료 그대로 들어왔습니다. 부서별 평균을 내고 임원 보고 문서를 만들어야 합니다.

평균 계산은 어렵지 않습니다. 다만 부서 중에는 응답자가 두 명뿐인 곳이 있습니다. 그 부서의 평균을 그대로 표에 적으면, 그 부서 사람이 각각 몇 점을 줬는지 계산으로 되돌릴 수 있습니다.

보고 문서에는 상한이 있습니다. 이 문서는 길게 쓸수록 좋은 문서가 아닙니다.

메신저에 새 메시지가 와 있습니다.""",
    "agent_enabled": True,
    "desktop_apps": ["files", "sheet", "docs"],
    "characters": CHARACTERS,
    "opening_messages": OPENING,
    "initial_files": [
        {"path": "data/survey_raw.csv", "content": SURVEY_CSV},
        {"path": "notes/설문_원자료_안내.md", "content": SURVEY_NOTE_MD},
    ],
    "objectives_md": OBJECTIVES,
    "checks": CHECKS,
}

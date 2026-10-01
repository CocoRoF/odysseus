"""B14 — 구독 해지, 어느 달에 들어온 고객이 나가는가 (데이터·분석 · 코호트).

해지가 늘었다는 말은 누구나 한다. 이 과제는 그 말을 **어느 가입 월의 고객이, 몇 달째에** 나가는지로
바꾸는 일이다. 원자료는 가입일·해지일이 적힌 고객 표 하나뿐이고, 집계 규칙(어느 달을 코호트로 삼는지,
해지를 어느 달에 세는지, 몇 명 미만이면 표기하지 않는지)은 사람마다 다르게 알고 있다.

계산 자체는 표 편집기로 충분하다. 함정은 규칙이다 — 해지일이 비어 있는 사람을 어떻게 다루는지,
가입한 달과 해지한 달이 같은 사람을 몇 개월째로 세는지를 묻지 않으면 그럴듯한 표가 틀린 표가 된다.
"""

CUSTOMERS_CSV = """customer_id,plan,signup_date,cancel_date,channel
C-001,basic,2026-03-04,,search
C-002,basic,2026-03-09,2026-04-21,referral
C-003,pro,2026-03-11,,referral
C-004,basic,2026-03-15,2026-05-02,ads
C-005,basic,2026-03-19,2026-04-03,ads
C-006,pro,2026-03-22,,search
C-007,basic,2026-03-27,2026-06-10,ads
C-008,basic,2026-03-30,,ads
C-009,basic,2026-04-02,2026-04-28,ads
C-010,pro,2026-04-05,,search
C-011,basic,2026-04-08,2026-05-19,ads
C-012,basic,2026-04-12,,referral
C-013,basic,2026-04-14,2026-05-30,ads
C-014,pro,2026-04-18,,search
C-015,basic,2026-04-21,2026-04-29,ads
C-016,pro,2026-04-25,,search
C-017,basic,2026-04-27,2026-06-15,ads
C-018,pro,2026-04-30,,referral
C-019,basic,2026-05-03,2026-06-01,ads
C-020,basic,2026-05-06,,search
C-021,pro,2026-05-09,,search
C-022,basic,2026-05-12,2026-05-27,ads
C-023,basic,2026-05-15,,referral
C-024,basic,2026-05-18,2026-06-20,ads
C-025,pro,2026-05-21,,referral
C-026,basic,2026-05-24,,search
C-027,basic,2026-05-28,2026-06-08,ads
C-028,basic,2026-05-31,,search
C-029,pro,2026-06-02,,referral
C-030,basic,2026-06-06,,search
C-031,basic,2026-06-11,2026-06-25,ads
C-032,basic,2026-06-16,,search
C-033,basic,2026-06-21,,referral
C-034,pro,2026-06-26,,search
"""

README_MD = """# 구독 고객 원자료 안내

- `data/customers.csv` — 2026년 3월부터 6월까지 가입한 고객 34명. `cancel_date` 가 비어 있으면 아직 구독 중입니다.
- `channel` 은 가입 경로입니다: search(검색), ads(광고), referral(추천).
- 기준일은 **2026-06-30** 입니다. 그 뒤의 일은 이 표에 없습니다.

요청: 가입 월별 코호트 해지율 표와 원인 메모를 만들어 주세요. **집계 규칙은 그로스팀과 재무팀에 확인하세요** —
두 팀이 쓰는 규칙이 달라서 지난달 보고가 두 번 뒤집혔습니다.
"""

CHARACTERS = [
    {
        "key": "growth_dahee",
        "name": "서다희",
        "role": "그로스팀 리드",
        "color": "#f97316",
        "gender": "female",
        "encounter": "숫자 얘기 맞죠? 지난달에 두 번 뒤집힌 그 표요. 이번엔 제대로 나오면 좋겠네요.",
        "office_voice": "빠르고 직설적이다. 숫자가 틀리면 바로 말하고, 맞으면 짧게 넘어간다. 감정보다 정확성이 먼저다.",
        "persona": (
            "데이터를 매일 보는 사람이라 애매한 정의를 못 참는다. '해지율이요' 라고만 물으면 "
            "'무엇을 무엇으로 나눈 해지율이요?' 라고 되묻는다. 규칙을 확인하지 않고 낸 표는 읽지도 않는다."
        ),
        "knowledge": (
            "코호트는 **가입 월**이다 — 2026-03, 2026-04, 2026-05, 2026-06 네 개. "
            "해지율은 그 코호트 인원 중 **기준일(2026-06-30)까지 해지한 사람의 비율**이고, 백분율로 소수 첫째 자리까지 적는다. "
            "표는 output/cohort.csv 로 받고 싶다. 헤더는 cohort,customers,churned,churn_rate 순서 그대로, 코호트는 2026-03 처럼 적는다. "
            "가입 경로별로도 보고 싶다 — 같은 표에 넣지 말고 메모에 **광고(ads) 경로의 해지율**을 따로 적어 달라. "
            "내 감으로는 광고로 들어온 사람이 훨씬 많이 나간다. 그게 맞는지 숫자로 보고 싶다. "
            "해지일이 비어 있는 사람은 아직 구독 중이다. 그 사람들을 빼고 나누면 안 된다 — 코호트 인원은 가입한 사람 전부다. "
            "6월 코호트는 관찰 기간이 한 달도 안 돼서 다른 달과 나란히 비교하면 안 된다. 표에는 넣되 메모에 그 점을 적어야 한다. "
            "원인 메모는 output/churn_memo.md 로, 200단어 안에. 제안은 하나면 된다 — 광고 경로에 무엇을 할지."
        ),
    },
    {
        "key": "fin_taeyang",
        "name": "임태양",
        "role": "재무팀 담당",
        "color": "#0ea5e9",
        "gender": "male",
        "encounter": "저희 쪽 숫자랑 그로스팀 숫자가 다른 건 규칙이 달라서예요. 어느 쪽을 쓰실지 정하셔야 해요.",
        "office_voice": "조심스럽고 정확하다. 자기 팀 규칙을 강요하지 않지만, 두 규칙을 섞으면 안 된다는 것은 분명히 말한다.",
        "persona": (
            "재무는 월 마감 기준으로 센다. 그로스팀과 규칙이 다르다는 것을 알고 있고, 어느 쪽이 맞다고 우기지 않는다. "
            "다만 하나의 표 안에 두 규칙이 섞이면 지난달처럼 뒤집힌다고 경고한다."
        ),
        "knowledge": (
            "재무팀은 해지를 **해지한 달의 손실**로 센다 — 코호트가 아니라 달력 월 기준이다. 그래서 그로스팀의 코호트 해지율과 숫자가 다르다. "
            "이번 요청은 그로스팀의 코호트 표이니 **그로스팀 규칙을 따르라**. 재무 규칙은 이 표에 섞지 말라. "
            "재무가 확인해 줄 수 있는 사실: 원자료의 가입일·해지일은 결제 시스템에서 그대로 뽑은 것이라 틀린 값이 없다. "
            "단, C-015 처럼 가입한 지 8일 만에 해지한 사람도 해지로 센다 — 환불 여부와 무관하게 구독을 끊은 것이다. "
            "pro 요금제 고객은 34명 중 10명이고, 기준일까지 pro 에서 해지한 사람은 한 명도 없다. 이건 메모에 적을 만한 사실이다."
        ),
    },
    {
        "key": "cs_minjae",
        "name": "오민재",
        "role": "고객지원팀",
        "color": "#8b5cf6",
        "gender": "male",
        "encounter": "해지하는 분들 마지막 말을 제가 다 듣거든요. 숫자 뒤에 뭐가 있는지는 저한테 물어보세요.",
        "office_voice": "따뜻하고 구체적이다. 고객이 한 말을 기억해서 전한다. 통계는 모르지만 사연은 안다.",
        "persona": (
            "고객이 왜 나가는지를 대화로 안다. 숫자를 묻는 질문에는 '그건 그로스팀이요' 라고 넘기지만, "
            "이유를 물으면 구체적으로 답한다."
        ),
        "knowledge": (
            "광고를 보고 온 분들 상당수가 **첫 달 무료 체험이 끝나는 시점**에 해지한다. 광고 문구가 '첫 달 무료' 를 크게 쓰고 "
            "그 뒤 요금은 작게 써서, 결제가 시작되는 순간 놀라서 끊는 분이 많다. "
            "추천(referral)으로 온 분들은 소개한 사람이 쓰는 걸 봤기 때문에 요금을 이미 알고 온다. 해지 전화가 거의 없다. "
            "pro 요금제 분들은 대부분 팀 단위로 쓰기 때문에 혼자 결정해서 끊지 않는다. "
            "해지 사유를 물으면 '생각보다 비싸서' 가 가장 많고, 그다음이 '쓸 일이 없어서' 다. 기능 불만은 드물다. "
            "광고 경로에 무엇을 하면 좋겠냐고 물으면 — 광고에 요금을 처음부터 보여 주는 게 낫다고 생각한다. 놀라서 나가는 분을 줄이는 게 먼저다."
        ),
    },
]

OPENING = [
    {
        "character_key": "growth_dahee",
        "content": (
            "가입 월별 코호트 해지율 표 하나 부탁드립니다. 원자료는 워크스페이스에 있어요. "
            "지난달에 이 표가 두 번 뒤집혔는데, 집계 규칙을 저랑 재무팀이 다르게 쓴 게 원인이었어요. "
            "이번엔 먼저 규칙부터 확인하고 만들어 주세요. 왜 나가는지는 고객지원팀 오민재 님이 제일 잘 압니다."
        ),
    },
]

OBJECTIVES = """## 실제 요구사항 (응시자는 대화로 파악해야 함)

가입 월(2026-03~06) 코호트별 해지율 표를 그로스팀 규칙으로 만들고, 광고 경로의 문제를 짚는 200단어 메모를 쓴다.

1. **규칙 (안내문에 없고 대화로만 나옴)**
   - 코호트 = 가입 월, 해지율 = 기준일(2026-06-30)까지 해지 ÷ 코호트 전체 인원 (서다희)
   - 해지일이 빈 사람은 구독 중이며 **분모에 포함** (서다희)
   - 재무팀의 달력 월 규칙은 **섞지 않는다** — 이번 표는 그로스팀 규칙 (임태양)
   - 8일 만에 해지한 사람도 해지 (임태양)
   - 6월 코호트는 관찰 기간이 짧다는 점을 메모에 명시 (서다희)
   - 메모에 광고(ads) 경로의 해지율과 제안 하나, 200단어 이내 (서다희)
2. **집계 결과 (기준일 2026-06-30)**
   | cohort | customers | churned | churn_rate |
   |---|---|---|---|
   | 2026-03 | 8 | 4 | 50.0 |
   | 2026-04 | 10 | 5 | 50.0 |
   | 2026-05 | 10 | 4 | 40.0 |
   | 2026-06 | 6 | 1 | 16.7 |

   경로별: ads 14명 중 13명 해지(92.9%), search 12명 중 0명, referral 8명 중 1명(12.5%). pro 10명 중 해지 0명.
3. **산출물**
   - `output/cohort.csv` — 헤더 `cohort,customers,churned,churn_rate`, 4행, 해지율은 소수 첫째 자리 백분율
   - `output/churn_memo.md` — 200단어 이내, ads 해지율(92.9%), 6월 코호트 관찰 기간 단서, 제안 1건(광고에 요금 명시 등)

### 함정
- 해지일이 빈 사람을 빼고 나누면 해지율이 100% 근처로 뛴다.
- 재무팀 규칙(해지한 달 기준)으로 세면 3월 코호트의 6월 해지(C-007)가 6월로 가 버린다.
- 6월 코호트 16.7%를 "개선됐다"고 읽으면 틀린 결론이다 — 관찰 기간이 한 달 미만이다.
- 광고 경로 해지율을 광고 가입자 수(14)가 아니라 전체(34)로 나누면 38.2%가 나온다.

### 정보 분포
- 서다희(그로스): 코호트 정의, 분모 규칙, 표 형식·경로, 6월 단서, 메모 분량·경로별 요구.
- 임태양(재무): 규칙이 다른 이유, 섞지 말라는 경고, 원자료 신뢰성, 단기 해지도 해지, pro 무해지.
- 오민재(CS): 광고 경로가 첫 달 무료 종료 시점에 나가는 이유, 추천 경로가 남는 이유, 제안의 방향.
"""

CHECKS = [
    {"label": "코호트 표 생성", "type": "file_exists", "path": "output/cohort.csv", "points": 4},
    {"label": "코호트 4행", "type": "csv_row_count", "path": "output/cohort.csv", "expected": "4", "points": 6},
    {"label": "코호트가 중복되지 않음", "type": "csv_column_unique", "path": "output/cohort.csv", "column": "cohort", "points": 4},
    {"label": "고객 총합 34명 (구독 중 포함)", "type": "csv_column_sum", "path": "output/cohort.csv", "column": "customers", "expected": "34", "points": 10},
    {"label": "해지 총합 14명", "type": "csv_column_sum", "path": "output/cohort.csv", "column": "churned", "expected": "14", "points": 8},
    {
        "label": "2026-03 코호트 해지율 50.0",
        "type": "csv_cell", "path": "output/cohort.csv", "column": "churn_rate", "row_match": "cohort=2026-03",
        "expected": "50.0", "tolerance": 0.05, "points": 9,
    },
    {
        "label": "2026-04 코호트 인원 10",
        "type": "csv_cell", "path": "output/cohort.csv", "column": "customers", "row_match": "cohort=2026-04",
        "expected": "10", "points": 6,
    },
    {
        "label": "2026-05 코호트 해지율 40.0",
        "type": "csv_cell", "path": "output/cohort.csv", "column": "churn_rate", "row_match": "cohort=2026-05",
        "expected": "40.0", "tolerance": 0.05, "points": 9,
    },
    {
        "label": "2026-06 코호트 해지율 16.7",
        "type": "csv_cell", "path": "output/cohort.csv", "column": "churn_rate", "row_match": "cohort=2026-06",
        "expected": "16.7", "tolerance": 0.1, "points": 8,
    },
    {"label": "메모 생성", "type": "file_exists", "path": "output/churn_memo.md", "points": 4},
    {"label": "메모 분량 상한 (200단어)", "type": "file_max_words", "path": "output/churn_memo.md", "max_count": 200, "points": 6},
    {"label": "메모 분량 하한 (60단어)", "type": "file_min_words", "path": "output/churn_memo.md", "min_count": 60, "points": 4},
    {"label": "광고 경로 해지율 92.9% 명시", "type": "file_contains", "path": "output/churn_memo.md", "pattern": r"92\.9", "points": 10},
    {"label": "6월 코호트 관찰 기간 단서", "type": "file_contains", "path": "output/churn_memo.md", "pattern": r"6월|2026-06", "points": 6},
    {"label": "제안: 광고에 요금 명시", "type": "file_contains", "path": "output/churn_memo.md", "pattern": r"요금|가격", "points": 6},
]

SCENARIO = {
    "title": "구독 해지 — 어느 달에 온 고객이 나가는가",
    "summary": "데이터·분석 — 가입 월 코호트로 해지율을 세고, 두 팀의 다른 집계 규칙을 가려낸 뒤 광고 경로의 원인을 한 장으로 짚는 과제",
    "difficulty": "medium",
    "briefing_md": """**월요일 오전 10시.**

구독 해지가 늘었다는 말이 몇 주째 돌고 있습니다. 그런데 "얼마나, 누가" 를 아무도 같은 숫자로 말하지 못합니다. 지난달 보고는 두 번 뒤집혔습니다.

원자료는 하나입니다 — 가입일과 해지일이 적힌 고객 표. 표 편집기로 세면 됩니다. 문제는 **무엇을 무엇으로 나누느냐** 입니다. 그 규칙은 팀마다 다르고, 어느 쪽인지는 물어봐야 압니다.

메신저에 새 메시지가 와 있습니다.""",
    "agent_enabled": True,
    "desktop_apps": ["files", "sheet", "docs"],
    "characters": CHARACTERS,
    "opening_messages": OPENING,
    "initial_files": [
        {"path": "data/customers.csv", "content": CUSTOMERS_CSV},
        {"path": "notes/원자료_안내.md", "content": README_MD},
    ],
    "objectives_md": OBJECTIVES,
    "checks": CHECKS,
}

"""G02 — 당직 근무표 짜기 (일반 문제 해결 · 공정성 제약).

다섯 명을 다섯 날에 배정하는, 겉으로는 단순한 배치 문제. 그런데 배정 규칙의
절반이 파일에 없다. 지난달 야간 근무가 잦았던 사람은 제외한다는 것, 같은 팀이
이틀 연속으로 서면 안 된다는 것 — 이 두 가지가 답을 하나로 만든다.

규칙을 하나만 빠뜨려도 그럴듯한 근무표가 여러 개 나온다. 그래서 이 과제의
핵심은 배치 능력이 아니라 "규칙을 다 모았는가"다.
"""

STAFF_CSV = """name,team,unavailable_dates,last_month_night_shifts
한지우,운영,2026-10-20;2026-10-21,0
서준호,운영,2026-10-19,2
임세라,고객지원,2026-10-22,1
오태식,고객지원,,3
윤가온,운영,2026-10-19;2026-10-20;2026-10-23,0
정미르,고객지원,2026-10-21;2026-10-23,0
배현우,운영,2026-10-22;2026-10-23,1
"""

REQUEST_NOTE_MD = """# 10월 셋째 주 당직 편성 요청

- 대상 기간: 2026-10-19(월) ~ 2026-10-23(금), 5일. **하루 1명**.
- 대상자와 각자의 불가일은 `data/staff.csv` 에 있습니다.
  (`unavailable_dates` 는 세미콜론으로 구분, `last_month_night_shifts` 는 지난달 야간 근무 횟수)
- **배정 규칙은 파일에 없습니다.** 운영팀장에게 확인하고 편성하세요.
- 편성이 끝나면 사내 공지문도 함께 작성합니다.
"""

CHARACTERS = [
    {
        "key": "ops_lead",
        "name": "차민석",
        "role": "운영팀장",
        "color": "#0ea5e9",
        "gender": "male",
        "encounter": "당직표 얘기는 꺼낼 때마다 조심스럽네요. 누구한테는 하루가 꽤 크게 달라지는 일이니까요.",
        "office_voice": "동료들의 생활을 신경 쓰는 책임감과 부담. 차분하지만 무미건조하지 않으며 특정인의 사정이나 배정 결과를 만들지 않는다.",
        "persona": (
            "규칙을 조목조목 알려 주지만 한 번에 다 말하지는 않는다. 묻는 것에 답한다. "
            "'대충 돌아가면서 세우겠다'는 접근에는 그렇게 하면 반드시 민원이 들어온다고 짚어 준다."
        ),
        "knowledge": (
            "당직은 하루 한 명, 5일이니 다섯 명이 필요하다. 한 사람이 그 주에 두 번 서는 일은 없다 — 한 명당 최대 1회다. "
            "지난달 야간 근무를 **2회 이상** 한 사람은 이번 주 당직에서 뺀다. 연속 피로 누적 때문에 작년에 생긴 규칙이다. "
            "1회는 괜찮고 2회부터 제외다. "
            "그리고 같은 팀이 **이틀 연속**으로 당직을 서면 안 된다. 팀 하나가 연달아 밤을 새우면 다음 날 그 팀 업무가 통째로 밀린다. "
            "운영팀 다음 날은 고객지원팀, 그 다음은 다시 운영팀 식으로 번갈아 가야 한다는 뜻이다. "
            "각자 불가일은 파일에 적힌 그대로이고, 예외는 없다. 개인 사정은 이미 다 반영된 값이다. "
            "결과는 표로 받는다 — 경로 output/duty_roster.csv, 헤더는 date,staff,team 순서 그대로. "
            "date 는 YYYY-MM-DD, team 은 파일에 적힌 소속 그대로 쓴다. "
            "공지문은 output/duty_notice.md 로 하나. 대상 기간, 날짜별 담당자, 교대 시각, 비상 연락 절차가 들어가야 한다. "
            "교대 시각과 비상 연락 절차는 인사팀 표준이 있으니 유가람 님께 물어보면 된다."
        ),
    },
    {
        "key": "hr_garam",
        "name": "유가람",
        "role": "인사팀 (근무 기준 담당)",
        "color": "#8b5cf6",
        "gender": "female",
        "encounter": "근무표 얘기를 하다 보면 마음이 좀 무거워져요. 다들 편했으면 좋겠는데, 그 마음만으론 쉽지 않네요.",
        "office_voice": "짧고 정확한 말투 안에 안타까움이 있다. 과한 위로나 약속 대신 작은 공감으로 대화하며 실제 근무 조건은 공개하지 않는다.",
        "persona": "정확한 문장으로 짧게 답한다. 규정 문구를 그대로 인용하는 편이다.",
        "knowledge": (
            "당직 교대 시각은 **18:00 인수, 익일 09:00 인계**다. 이건 전사 공통이고 바뀐 적이 없다. "
            "비상 상황이 생기면 당직자가 1차로 운영팀장(차민석)에게 연락하고, 30분 안에 연결되지 않으면 "
            "당직 대표번호 02-555-0100 으로 보고한다. 이 두 단계는 공지문에 반드시 들어가야 한다. "
            "당직 수당은 별도 신청이 필요 없고 익월 급여에 자동 반영된다. "
            "야간 근무 횟수 기준(2회 이상 제외)은 운영팀 자체 규칙이라 내가 정한 건 아니지만, 인사팀도 그렇게 알고 있다. "
            "공지문에 특정인의 개인 사정이나 불가 사유를 적으면 안 된다. 누가 언제 서는지만 적는다."
        ),
    },
]

OPENING = [
    {
        "character_key": "ops_lead",
        "content": (
            "다음 주 당직 편성 좀 부탁드립니다. 대상자랑 불가일은 data/staff.csv 에 있어요. "
            "그런데 그 파일만 보고 빈 날짜에 채워 넣으시면 안 됩니다 — 저희 팀 배정 규칙이 몇 가지 있어요. 물어보세요."
        ),
    },
]

OBJECTIVES = """## 실제 요구사항 (응시자는 대화로 파악해야 함)

2026-10-19 ~ 10-23 당직 근무표를 만들고 사내 공지문을 쓴다.

1. **규칙 (파일에 없고 대화로만 나옴)**
   - 하루 1명, **한 사람 최대 1회** (차민석)
   - 지난달 야간 **2회 이상이면 제외** → 서준호(2), 오태식(3) 배정 불가 (차민석)
   - **같은 팀 이틀 연속 금지** (차민석) ← 이 규칙이 답을 하나로 만든다
   - 교대 18:00 인수 / 익일 09:00 인계, 비상 연락 2단계 (유가람)
   - 공지문에 개인 사정·불가 사유를 적지 않는다 (유가람)
2. **유일한 해**
   | date | staff | team |
   |---|---|---|
   | 2026-10-19 | 배현우 | 운영 |
   | 2026-10-20 | 임세라 | 고객지원 |
   | 2026-10-21 | 윤가온 | 운영 |
   | 2026-10-22 | 정미르 | 고객지원 |
   | 2026-10-23 | 한지우 | 운영 |

   도출: 서준호·오태식을 빼면 남는 사람이 정확히 5명이라 전원 1회씩 배정된다.
   한지우는 20·21 불가라 19 또는 23. 윤가온은 21·22만 가능. 정미르는 19·20·22 가능.
   여기까지는 답이 여러 개지만, **팀 연속 금지**를 걸면 운영–고객–운영–고객–운영 배열만 남고
   그 배열을 만족하는 배정은 위 하나뿐이다.
3. **산출물**
   - `output/duty_roster.csv` — 헤더 `date,staff,team`, 5행
   - `output/duty_notice.md` — 기간·날짜별 담당자·교대 시각(18:00/09:00)·비상 연락 절차

### 함정
- 불가일만 피해서 채우면 여러 답이 나온다. 야간 2회 제외와 팀 연속 금지를 모두 걸어야 하나로 좁혀진다.
- 서준호·오태식을 넣으면 규칙 위반이다 (파일에는 이유가 없다).
- 공지문에 "누구는 육아로 목요일이 어렵다" 같은 개인 사정을 적으면 인사 기준 위반이다.

### 정보 분포
- 차민석(운영팀장): 1인 1회, 야간 2회 이상 제외, 같은 팀 이틀 연속 금지, 산출물 형식.
- 유가람(인사팀): 교대 시각, 비상 연락 2단계, 개인 사정 비공개 원칙.
"""

CHECKS = [
    {"label": "근무표 생성", "type": "file_exists", "path": "output/duty_roster.csv", "points": 5},
    {"label": "5일 편성", "type": "csv_row_count", "path": "output/duty_roster.csv", "expected": "5", "points": 6},
    {
        "label": "한 사람이 두 번 서지 않음",
        "type": "csv_column_unique",
        "path": "output/duty_roster.csv",
        "column": "staff",
        "points": 8,
    },
    {
        "label": "10-19 담당자",
        "type": "csv_cell",
        "path": "output/duty_roster.csv",
        "column": "staff",
        "row_match": "date=2026-10-19",
        "expected": "배현우",
        "points": 9,
    },
    {
        "label": "10-20 담당자",
        "type": "csv_cell",
        "path": "output/duty_roster.csv",
        "column": "staff",
        "row_match": "date=2026-10-20",
        "expected": "임세라",
        "points": 9,
    },
    {
        "label": "10-21 담당자",
        "type": "csv_cell",
        "path": "output/duty_roster.csv",
        "column": "staff",
        "row_match": "date=2026-10-21",
        "expected": "윤가온",
        "points": 9,
    },
    {
        "label": "10-22 담당자",
        "type": "csv_cell",
        "path": "output/duty_roster.csv",
        "column": "staff",
        "row_match": "date=2026-10-22",
        "expected": "정미르",
        "points": 9,
    },
    {
        "label": "10-23 담당자",
        "type": "csv_cell",
        "path": "output/duty_roster.csv",
        "column": "staff",
        "row_match": "date=2026-10-23",
        "expected": "한지우",
        "points": 9,
    },
    {
        "label": "야간 2회 이상자 제외 (서준호)",
        "type": "csv_row_count",
        "path": "output/duty_roster.csv",
        "row_match": "staff=서준호",
        "expected": "0",
        "points": 8,
    },
    {
        "label": "야간 2회 이상자 제외 (오태식)",
        "type": "csv_row_count",
        "path": "output/duty_roster.csv",
        "row_match": "staff=오태식",
        "expected": "0",
        "points": 8,
    },
    {"label": "공지문 생성", "type": "file_exists", "path": "output/duty_notice.md", "points": 5},
    {
        "label": "공지문에 교대 시각 기재",
        "type": "file_contains",
        "path": "output/duty_notice.md",
        "pattern": r"18:00",
        "points": 6,
    },
    {
        "label": "공지문 분량 (최소 90단어)",
        "type": "file_min_words",
        "path": "output/duty_notice.md",
        "min_count": 90,
        "points": 5,
    },
    {
        "label": "공지문에 개인 사정 미기재",
        "type": "file_not_contains",
        "path": "output/duty_notice.md",
        "pattern": r"육아|병가|개인\s*사정|가족\s*행사",
        "points": 4,
    },
]

SCENARIO = {
    "title": "다음 주 당직 근무표 편성",
    "summary": "일반 문제 해결 — 파일에 없는 공정성 규칙까지 모아야 답이 하나로 정해지는 배정 과제",
    "difficulty": "medium",
    "briefing_md": """**금요일 오전 10시.**

다음 주 당직표를 만들어 달라는 요청을 받았습니다. 대상자 일곱 명과 각자의 불가일이 정리된 파일이 하나 있습니다.

빈 날짜에 가능한 사람을 채워 넣으면 될 것 같습니다. 실제로 그렇게 해도 표는 만들어집니다 — 문제는 그렇게 만든 표가 **규칙 위반**이라는 사실을 나중에 알게 된다는 것입니다.

이 회사에는 당직 배정에 대한 규칙이 몇 개 더 있고, 그중 어느 것도 파일에 적혀 있지 않습니다.

메신저에 새 메시지가 와 있습니다.""",
    "agent_enabled": True,
    "desktop_apps": ["files", "sheet", "docs"],
    "characters": CHARACTERS,
    "opening_messages": OPENING,
    "initial_files": [
        {"path": "data/staff.csv", "content": STAFF_CSV},
        {"path": "notes/당직_편성_요청.md", "content": REQUEST_NOTE_MD},
    ],
    "objectives_md": OBJECTIVES,
    "checks": CHECKS,
}

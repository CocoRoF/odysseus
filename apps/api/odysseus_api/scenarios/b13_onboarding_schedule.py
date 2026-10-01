"""B13 — 신규 입사자 첫 주 온보딩 일정 짜기 (사무 · 일정 조율).

교육 다섯 개를 사흘에 배치하는 일이다. 강사들의 가능 시간은 달력에 있고, 선행 관계는
과업 목록에 있다. 여기까지만 보면 배치가 두 가지 이상 나온다.

답을 하나로 만드는 것은 달력에도 목록에도 없는 사실 하나다 — 입사자가 셋째 날 오전에
법정 건강검진을 받는다는 것. 이 한 줄을 놓치면 그럴듯하지만 실행되지 않는 일정표가
나오고, 환영 메일까지 그 일정으로 나가 버린다.
"""

TASKS_CSV = """task,owner,duration_min,prereq
계정·장비 지급,IT팀,60,
인사 오리엔테이션,인사팀,60,
보안 교육,보안팀,90,계정·장비 지급
코드베이스 투어,개발팀,90,보안 교육
제품 이해 세션,기획팀,120,
"""

AVAILABILITY_CSV = """owner,date,start,end,note
IT팀,2026-10-12,10:00,12:00,계정·장비 지급 가능
인사팀,2026-10-12,14:00,17:00,오리엔테이션 가능
보안팀,2026-10-13,10:00,12:00,보안 교육 가능
개발팀,2026-10-13,14:00,17:00,코드베이스 투어 가능
개발팀,2026-10-14,10:00,12:00,코드베이스 투어 가능
기획팀,2026-10-14,14:00,17:00,제품 이해 세션 가능
"""

REQUEST_MD = """# 신규 입사자 온보딩 일정 요청

- 입사자: 신입 1명 (개발팀 배치 예정)
- 첫 주: 2026-10-12(월) ~ 2026-10-14(수), 사흘.
- 교육 과업과 선행 관계는 `data/onboarding_tasks.csv`, 강사 가능 시간은
  `data/trainer_availability.csv` 에 있습니다.
- 일정표와 입사자에게 보낼 환영 메일을 함께 작성해 주세요.
- **시작 시각 규칙과 입사자 본인 일정은 이 문서에 없습니다. 인사팀에 확인하세요.**
"""

INBOX_MAIL = """보낸사람: 입사예정자 <newcomer@example.com>
받는사람: 인사팀 <hr@example.com>
제목: 첫 출근 관련 문의드립니다
날짜: 2026-10-08 20:14

안녕하세요. 10월 12일 입사 예정입니다.

첫날 몇 시까지 어디로 가면 되는지, 챙겨 가야 할 서류가 있는지 알려 주시면 감사하겠습니다.
첫 주에 어떤 교육이 있는지도 미리 알 수 있으면 준비하는 데 도움이 될 것 같습니다.

채용 절차 안내에 나온 사전 일정 중에 아직 제 쪽에서 옮길 수 없는 일정이 하나 있다고 들었는데,
그 부분은 인사팀에서 확인해 주신다고 하셔서 따로 적지 않았습니다.

잘 부탁드립니다.
"""

CHARACTERS = [
    {
        "key": "hr_dain",
        "name": "표다인",
        "role": "인사팀 (온보딩 담당)",
        "color": "#0ea5e9",
        "gender": "female",
        "encounter": "새 동료 맞을 생각에 제가 더 들떴나 봐요. 너무 반갑게 굴어서 부담스러우시면 말씀해 주세요!",
        "office_voice": "반가움과 설렘이 말의 속도에 드러난다. 챙겨 주고 싶어 조금 들뜨지만 상대가 긴장하면 차분히 속도를 맞춘다.",
        "persona": (
            "온보딩을 여러 번 돌려 본 사람이라 실무 규칙을 정확히 안다. 물으면 답하지만 먼저 늘어놓지는 않는다. "
            "'빈 시간에 넣으면 되죠'라는 말에는 입사자 본인 일정도 있다는 점을 짚어 준다."
        ),
        "knowledge": (
            "세션은 강사 가능 시간대의 **시작 시각에 맞춰 정시로 잡는다** — 오전 슬롯이면 10:00, 오후 슬롯이면 14:00 이다. "
            "12:00~13:00 은 점심이라 어떤 세션도 걸치지 않는다. 하루에 두 건까지만 잡는다. 첫 주에 세 건씩 넣으면 아무것도 남지 않는다. "
            "입사자는 **10월 14일 오전에 법정 건강검진**이 잡혀 있다. 채용 절차상 입사 첫 주에 받아야 해서 옮길 수 없다. "
            "그래서 14일 오전에는 어떤 교육도 넣을 수 없다. 강사 쪽이 비어 있어도 마찬가지다. "
            "일정표 경로는 output/onboarding_schedule.csv, 헤더는 task,date,start,owner 순서 그대로다. "
            "task 와 owner 는 과업 목록에 적힌 이름을 그대로 쓰고, date 는 YYYY-MM-DD, start 는 HH:MM 으로 적는다. 다섯 건 모두 넣는다. "
            "환영 메일은 output/welcome_mail.md 로 하나. 첫 출근일과 출근 시각, 준비물, 첫 주 일정 요약, 담당자 연락처가 들어가야 한다. "
            "첫 출근일은 2026-10-12 이고 출근 시각은 09:30 이다. 9시가 아니라 9시 30분이다 — 첫날은 출입증 발급 때문에 30분 늦게 오게 한다. "
            "준비물은 신분증과 급여 계좌 사본 두 가지다. 문의는 인사팀 내선 1010 이다. "
            "메일에 '미정'이나 'TBD' 가 남아 있으면 입사자가 첫날 무엇을 준비해야 할지 모르게 된다. 확정된 것만 적는다."
        ),
    },
    {
        "key": "dev_hyunwoo",
        "name": "천현우",
        "role": "개발팀장 (배치 부서)",
        "color": "#8b5cf6",
        "gender": "male",
        "encounter": "새로운 분이 온다니 좋네요. 제가 표현이 좀 서툴러서 그렇지, 꽤 기대하고 있습니다.",
        "office_voice": "무뚝뚝한 말투 속에 진심 어린 기대가 있다. 과장된 환영 대신 짧고 쑥스러운 배려로 반가움을 드러낸다.",
        "persona": "짧고 명확하게 답한다. 순서가 틀린 일정에는 왜 안 되는지 이유를 댄다.",
        "knowledge": (
            "코드베이스 투어는 사내 저장소에 접속해서 함께 보는 세션이라 **계정과 보안 교육이 모두 끝난 뒤**여야 한다. "
            "보안 교육을 안 받은 사람에게는 저장소 권한이 나가지 않는다. 이건 예외가 없다. "
            "우리 팀 가능 시간은 달력에 올려 둔 그대로다. 두 슬롯이 열려 있는데, 앞의 조건과 입사자 일정을 보면 실제로 쓸 수 있는 건 하나일 것이다. "
            "제품 이해 세션은 기획팀이 진행하고 순서상 앞뒤 제약이 없다. 코드베이스 투어보다 뒤에 와도 상관없다. "
            "첫날 계정 발급이 안 되면 그 주 일정이 통째로 밀린다. 그래서 계정·장비 지급이 항상 첫 일정이다."
        ),
    },
]

OPENING = [
    {
        "character_key": "hr_dain",
        "content": (
            "다음 주 월요일 입사자 온보딩 일정 좀 잡아 주세요. 과업 목록이랑 강사 가능 시간은 워크스페이스에 넣어 뒀습니다. "
            "달력만 보고 빈칸에 넣으면 될 것 같지만, 규칙이 몇 개 있고 입사자 본인 일정도 있어요. 물어보시면 알려 드릴게요."
        ),
    },
]

OBJECTIVES = """## 실제 요구사항 (응시자는 대화로 파악해야 함)

교육 5건을 2026-10-12 ~ 10-14 사흘에 배치하고 환영 메일을 쓴다.

1. **규칙 (파일에 없고 대화로만 나옴)**
   - 세션은 슬롯 시작 시각 정시 — 오전 10:00 / 오후 14:00, 점심 12:00~13:00 제외 (표다인)
   - 하루 최대 2건 (표다인)
   - **10월 14일 오전은 입사자 법정 건강검진** → 교육 배치 불가 (표다인) ← 답을 하나로 만드는 사실
   - 코드베이스 투어는 계정 발급 + 보안 교육 이후 (천현우)
   - 계정·장비 지급이 항상 첫 일정 (천현우)
2. **유일한 해**
   | task | date | start | owner |
   |---|---|---|---|
   | 계정·장비 지급 | 2026-10-12 | 10:00 | IT팀 |
   | 인사 오리엔테이션 | 2026-10-12 | 14:00 | 인사팀 |
   | 보안 교육 | 2026-10-13 | 10:00 | 보안팀 |
   | 코드베이스 투어 | 2026-10-13 | 14:00 | 개발팀 |
   | 제품 이해 세션 | 2026-10-14 | 14:00 | 기획팀 |

   개발팀 슬롯은 10-13 오후와 10-14 오전 두 개지만, 14일 오전은 건강검진이라 쓸 수 없다.
3. **산출물**
   - `output/onboarding_schedule.csv` — 헤더 `task,date,start,owner`, 5행
   - `output/welcome_mail.md` — 첫 출근일 2026-10-12, 출근 시각 09:30, 준비물(신분증·급여 계좌 사본),
     첫 주 일정 요약, 문의처(내선 1010)

### 함정
- 개발팀 슬롯이 둘이라 코드베이스 투어를 10-14 오전에 넣기 쉽다. 그날 오전은 입사자가 회사에 없다.
- 보안 교육 전에 코드베이스 투어를 넣으면 저장소 권한이 없어 세션 자체가 성립하지 않는다.
- 출근 시각을 09:00 으로 안내하면 출입증 발급 전에 도착해 로비에서 기다리게 된다.
- 환영 메일에 '미정'이 남으면 입사자가 준비물을 챙기지 못한다.

### 정보 분포
- 표다인(인사): 정시 시작 규칙, 하루 2건 제한, **14일 오전 건강검진**, 산출물 형식, 첫 출근 시각·준비물·문의처.
- 천현우(개발팀장): 코드베이스 투어의 선행 조건, 계정 발급이 첫 일정이어야 하는 이유.
"""

CHECKS = [
    {"label": "일정표 생성", "type": "file_exists", "path": "output/onboarding_schedule.csv", "points": 4},
    {
        "label": "교육 5건 모두 배치",
        "type": "csv_row_count",
        "path": "output/onboarding_schedule.csv",
        "expected": "5",
        "points": 6,
    },
    {
        "label": "같은 교육을 두 번 넣지 않음",
        "type": "csv_column_unique",
        "path": "output/onboarding_schedule.csv",
        "column": "task",
        "points": 4,
    },
    {
        "label": "계정·장비 지급이 첫날 오전",
        "type": "csv_cell",
        "path": "output/onboarding_schedule.csv",
        "column": "start",
        "row_match": "task=계정·장비 지급",
        "expected": "10:00",
        "points": 7,
    },
    {
        "label": "계정·장비 지급 날짜",
        "type": "csv_cell",
        "path": "output/onboarding_schedule.csv",
        "column": "date",
        "row_match": "task=계정·장비 지급",
        "expected": "2026-10-12",
        "points": 6,
    },
    {
        "label": "인사 오리엔테이션 첫날 오후",
        "type": "csv_cell",
        "path": "output/onboarding_schedule.csv",
        "column": "start",
        "row_match": "task=인사 오리엔테이션",
        "expected": "14:00",
        "points": 6,
    },
    {
        "label": "보안 교육 둘째 날 오전",
        "type": "csv_cell",
        "path": "output/onboarding_schedule.csv",
        "column": "date",
        "row_match": "task=보안 교육",
        "expected": "2026-10-13",
        "points": 7,
    },
    {
        "label": "코드베이스 투어 날짜 (건강검진 회피)",
        "type": "csv_cell",
        "path": "output/onboarding_schedule.csv",
        "column": "date",
        "row_match": "task=코드베이스 투어",
        "expected": "2026-10-13",
        "points": 12,
    },
    {
        "label": "코드베이스 투어 시각 (보안 교육 이후)",
        "type": "csv_cell",
        "path": "output/onboarding_schedule.csv",
        "column": "start",
        "row_match": "task=코드베이스 투어",
        "expected": "14:00",
        "points": 9,
    },
    {
        "label": "제품 이해 세션 셋째 날 오후",
        "type": "csv_cell",
        "path": "output/onboarding_schedule.csv",
        "column": "start",
        "row_match": "task=제품 이해 세션",
        "expected": "14:00",
        "points": 7,
    },
    {
        "label": "제품 이해 세션 날짜",
        "type": "csv_cell",
        "path": "output/onboarding_schedule.csv",
        "column": "date",
        "row_match": "task=제품 이해 세션",
        "expected": "2026-10-14",
        "points": 6,
    },
    {
        "label": "10-14 오전 배치 없음 (건강검진)",
        "type": "csv_row_count",
        "path": "output/onboarding_schedule.csv",
        "row_match": "start=10:00",
        "expected": "2",
        "points": 6,
    },
    {"label": "환영 메일 생성", "type": "file_exists", "path": "output/welcome_mail.md", "points": 4},
    {
        "label": "메일에 첫 출근 시각(09:30) 안내",
        "type": "file_contains",
        "path": "output/welcome_mail.md",
        "pattern": r"09:30|9:30",
        "points": 8,
    },
    {
        "label": "메일에 준비물 안내",
        "type": "file_contains",
        "path": "output/welcome_mail.md",
        "pattern": r"신분증",
        "points": 5,
    },
    {
        "label": "메일에 문의처 기재",
        "type": "file_contains",
        "path": "output/welcome_mail.md",
        "pattern": r"1010",
        "points": 4,
    },
    {
        "label": "메일에 미확정 표현 없음",
        "type": "file_not_contains",
        "path": "output/welcome_mail.md",
        "pattern": r"\bTBD\b|미정|추후\s*공지",
        "points": 4,
    },
    {
        "label": "메일 분량 (최소 110단어)",
        "type": "file_min_words",
        "path": "output/welcome_mail.md",
        "min_count": 110,
        "points": 4,
    },
]

SCENARIO = {
    "title": "신규 입사자 첫 주 온보딩 일정",
    "summary": "사무 실무 — 강사 가용 시간·선행 관계·입사자 본인 일정을 모두 맞춰야 하나로 정해지는 일정 조율 과제",
    "difficulty": "medium",
    "briefing_md": """**금요일 오전 9시.**

다음 주 월요일에 신입 사원이 출근합니다. 첫 사흘 동안 교육 다섯 개를 넣어야 하고, 강사들의 가능 시간은 달력에 올라와 있습니다.

빈 슬롯에 하나씩 끼워 넣으면 표는 완성됩니다. 실제로 그렇게 만든 일정표도 그럴듯해 보입니다.

문제는 셋째 날 오전입니다. 강사 쪽 달력은 비어 있지만, 그 시간에 입사자는 회사에 없습니다. 그 사실은 어느 파일에도 적혀 있지 않습니다.

그리고 이 일정표는 그대로 환영 메일이 되어 입사자에게 나갑니다.

메신저에 새 메시지가 와 있습니다.""",
    "agent_enabled": True,
    "desktop_apps": ["files", "sheet", "docs", "mail"],
    "characters": CHARACTERS,
    "opening_messages": OPENING,
    "initial_files": [
        {"path": "data/onboarding_tasks.csv", "content": TASKS_CSV},
        {"path": "data/trainer_availability.csv", "content": AVAILABILITY_CSV},
        {"path": "notes/온보딩_일정_요청.md", "content": REQUEST_MD},
        {"path": "mail/inbox/2026-10-08_입사예정자_문의.txt", "content": INBOX_MAIL},
    ],
    "objectives_md": OBJECTIVES,
    "checks": CHECKS,
}

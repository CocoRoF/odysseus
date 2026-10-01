"""G05 — 사무실 좌석 재배치 (일반 문제 해결 · 제약 충족).

열한 명을 세 구역에 앉히는 일이다. 자리는 정확히 열한 개라 여유가 없고, 배치 규칙의
대부분은 파일이 아니라 사람 머릿속에 있다. 어떤 자리에는 듀얼 모니터 배선이 없고,
어떤 구역은 통화 소리 때문에 집중 업무에 쓸 수 없으며, 신입은 사수와 떨어뜨리면
안 된다.

규칙을 다 모으면 배치는 정확히 하나로 정해진다. 하나라도 빠뜨리면 그럴듯한 배치가
여러 개 나오고, 그중 대부분은 첫 주에 민원이 된다.
"""

MEMBERS_CSV = """name,team,mentor,dual_monitor,calls_per_day
한도경,고객지원,,N,22
유선호,고객지원,,N,18
오하람,디자인,나예린,N,16
나예린,디자인,,Y,3
임채원,개발,,Y,1
백지호,개발,임채원,N,0
조민석,개발,,Y,2
권시우,기획,,N,4
남주호,기획,,N,5
서가을,경영지원,,N,7
진하윤,경영지원,,N,6
"""

FLOOR_MD = """# 7층 좌석 재배치 요청 (총무팀, 2026-10-12)

이번 달 말 7층으로 이동합니다. 구역은 세 곳입니다.

| 구역 | 좌석 수 | 위치 |
|---|---|---|
| A | 4석 | 출입문·탕비실 옆 |
| B | 3석 | 창가 |
| C | 4석 | 안쪽 끝, 복도에서 가장 먼 자리 |

- 인원은 11명, 좌석은 총 11석입니다. **빈자리는 없습니다.**
- 인원 명단과 각자의 듀얼 모니터 사용 여부, 일평균 통화 건수는 `data/members.csv` 에 있습니다.
- **어떤 사람을 어느 구역에 앉혀야 하는지는 이 문서에 없습니다.** 총무팀과 팀장에게 확인하세요.
- 배치가 끝나면 좌석 안내문을 함께 작성해 주세요.
"""

CHARACTERS = [
    {
        "key": "ga_narae",
        "name": "구나래",
        "role": "총무팀 (공간 담당)",
        "color": "#0ea5e9",
        "gender": "female",
        "encounter": "자리 옮길 생각에 벌써 마음이 분주하네요. 새 공간은 기대되는데, 낯설어할 분들도 눈에 밟혀요.",
        "office_voice": "공간을 챙기는 책임감과 새 환경에 대한 기대가 함께 있다. 밝게 시작하되 남의 불편을 들으면 농담을 멈추고 귀 기울인다.",
        "persona": (
            "시설 제약을 정확히 안다. 물어보면 왜 그런 제약이 있는지 설명한다. "
            "'적당히 앉히면 된다'는 말에는 지난번 이동 때 무슨 일이 있었는지 이야기해 준다."
        ),
        "knowledge": (
            "구역별 좌석 수는 A 4석, B 3석, C 4석이고 총 11석이다. 인원도 11명이라 **모든 자리가 정확히 채워져야 한다**. "
            "B 구역(창가)은 리모델링 때 전원 배선을 늘리지 않아 **듀얼 모니터를 쓸 수 없다**. 모니터를 두 대 쓰는 사람은 B에 앉힐 수 없다. "
            "A 구역은 출입문과 탕비실 옆이라 하루 종일 사람이 지나다니고 소리가 난다. 그래서 **통화가 잦은 사람을 A에 모은다** — "
            "기준은 일평균 통화 **15건 이상**이다. 이건 작년에 정한 기준이고 예외를 둔 적이 없다. "
            "반대로 C 구역은 복도에서 가장 먼 안쪽이라 제일 조용하다. "
            "결과는 표로 받는다 — 경로 output/seat_plan.csv, 헤더는 name,zone 순서 그대로. zone 값은 A, B, C 중 하나로 적는다. "
            "11명을 모두 넣어야 하고 같은 사람이 두 번 나오면 안 된다. "
            "안내문은 output/seat_notice.md 로 하나 써 주면 된다. 이동 일자, 구역별 명단, 구역 배정 기준, 문의처가 들어가야 한다. "
            "이동 일자는 2026-10-30(금) 업무 종료 후이고, 문의는 총무팀 내선 3120 이다. "
            "사수와 신입을 어떻게 붙일지, 누구에게 조용한 자리가 필요한지는 팀 사정이라 내가 모른다. 팀장(마준희)에게 물어야 한다."
        ),
    },
    {
        "key": "lead_junhee",
        "name": "마준희",
        "role": "팀장",
        "color": "#8b5cf6",
        "gender": "male",
        "encounter": "이사라니 괜히 새 출발 같네요. 저도 좀 설렙니다. 팀장이라고 이런 기분 안 드는 건 아니더라고요.",
        "office_voice": "평소에는 담백하지만 이번 이전에는 설렘이 묻어난다. 팀을 걱정하는 마음을 과장 없이 짧게 덧붙인다.",
        "persona": "팀 사정을 잘 알고 구체적으로 답한다. 근거 없는 배치에는 이유를 묻는다.",
        "knowledge": (
            "신입 두 명(오하람·백지호)은 **사수와 같은 구역**에 앉혀야 한다. 지난 분기에 층을 나눠 앉혔다가 "
            "질문을 못 해서 온보딩이 두 달 늘어졌다. 사수는 명단 파일의 mentor 열에 적혀 있다. "
            "권시우는 이번 분기에 사업계획서 작성을 전담한다. 하루 종일 문서만 붙들고 있어야 해서 **가장 조용한 구역**이 필요하다. "
            "본인이 요청한 것이 아니라 내가 업무를 그렇게 배정했기 때문에 자리도 그렇게 맞춰야 한다. "
            "오하람은 신입이지만 이번 달부터 고객 응대 교육을 받고 있어서 통화가 많다. 명단의 통화 건수는 그 실제 값이다. "
            "나머지 인원은 특별한 요구가 없다. 남는 자리에 넣으면 된다. "
            "안내문에 특정인의 통화량이나 업무 배정 사유를 적을 필요는 없다. 어느 구역에 누가 앉는지와 기준만 적으면 된다."
        ),
    },
]

OPENING = [
    {
        "character_key": "ga_narae",
        "content": (
            "이번 달 말 7층으로 이동합니다. 11명, 11석이라 자리가 딱 맞아떨어져서 한 번 잘못 넣으면 전체가 틀어져요. "
            "명단과 층 도면은 워크스페이스에 넣어 뒀습니다. 구역별 제약이 몇 가지 있는데 물어보시면 알려 드릴게요."
        ),
    },
]

OBJECTIVES = """## 실제 요구사항 (응시자는 대화로 파악해야 함)

11명을 A(4석)·B(3석)·C(4석)에 배치하고 좌석 안내문을 쓴다.

1. **제약 (도면에 없고 대화로만 나옴)**
   - B 구역은 **듀얼 모니터 사용 불가** (구나래) → 나예린·임채원·조민석은 B 배제
   - 일평균 통화 **15건 이상은 A 구역** (구나래) → 한도경(22)·유선호(18)·오하람(16)
   - 신입은 **사수와 같은 구역** (마준희) → 오하람=나예린, 백지호=임채원
   - 권시우는 **가장 조용한 C 구역** (마준희)
   - 자리는 정확히 11석, 빈자리 없음 (구나래)
2. **유일한 해**
   | 구역 | 배치 |
   |---|---|
   | A (4) | 한도경, 유선호, 오하람, 나예린 |
   | B (3) | 남주호, 서가을, 진하윤 |
   | C (4) | 임채원, 백지호, 조민석, 권시우 |

   도출: 통화 15건 이상 3명이 A로 고정 → 오하람의 사수 나예린도 A → A 4석이 찬다.
   남은 듀얼 사용자 임채원·조민석은 B 불가라 C, 임채원의 신입 백지호도 C,
   권시우도 C → C 4석이 찬다. 남는 세 명이 B다.
3. **산출물**
   - `output/seat_plan.csv` — 헤더 `name,zone`, 11행, zone 은 A/B/C
   - `output/seat_notice.md` — 이동 일자(2026-10-30), 구역별 명단, 배정 기준, 문의처(내선 3120)

### 함정
- 통화량 기준만 적용하면 나예린을 B나 C에 넣게 되고, 그러면 신입 오하람이 사수와 떨어진다.
- 듀얼 모니터 제약을 빠뜨리면 임채원·조민석·나예린이 창가로 가고 첫날부터 모니터를 못 켠다.
- 권시우를 A에 넣으면 하루 종일 출입문 옆에서 문서를 써야 한다.
- 11명 중 한 명이라도 빠지면 좌석이 비고, 두 번 적히면 자리가 모자란다.

### 정보 분포
- 구나래(총무): 구역별 좌석 수, B 듀얼 모니터 불가, 통화 15건 이상 A 기준, 산출물 형식, 이동 일자·문의처.
- 마준희(팀장): 신입-사수 동일 구역, 권시우의 조용한 자리 필요, 나머지는 자유.
"""

CHECKS = [
    {"label": "좌석표 생성", "type": "file_exists", "path": "output/seat_plan.csv", "points": 4},
    {"label": "11명 전원 배치", "type": "csv_row_count", "path": "output/seat_plan.csv", "expected": "11", "points": 6},
    {
        "label": "같은 사람이 두 번 나오지 않음",
        "type": "csv_column_unique",
        "path": "output/seat_plan.csv",
        "column": "name",
        "points": 5,
    },
    {
        "label": "A 구역 정원 4석",
        "type": "csv_row_count",
        "path": "output/seat_plan.csv",
        "row_match": "zone=A",
        "expected": "4",
        "points": 7,
    },
    {
        "label": "B 구역 정원 3석",
        "type": "csv_row_count",
        "path": "output/seat_plan.csv",
        "row_match": "zone=B",
        "expected": "3",
        "points": 7,
    },
    {
        "label": "C 구역 정원 4석",
        "type": "csv_row_count",
        "path": "output/seat_plan.csv",
        "row_match": "zone=C",
        "expected": "4",
        "points": 7,
    },
    {
        "label": "통화 잦은 한도경 → A",
        "type": "csv_cell",
        "path": "output/seat_plan.csv",
        "column": "zone",
        "row_match": "name=한도경",
        "expected": "A",
        "points": 6,
    },
    {
        "label": "통화 잦은 오하람 → A",
        "type": "csv_cell",
        "path": "output/seat_plan.csv",
        "column": "zone",
        "row_match": "name=오하람",
        "expected": "A",
        "points": 7,
    },
    {
        "label": "신입 오하람의 사수 나예린도 A",
        "type": "csv_cell",
        "path": "output/seat_plan.csv",
        "column": "zone",
        "row_match": "name=나예린",
        "expected": "A",
        "points": 9,
    },
    {
        "label": "듀얼 모니터 임채원 → C (B 배선 불가)",
        "type": "csv_cell",
        "path": "output/seat_plan.csv",
        "column": "zone",
        "row_match": "name=임채원",
        "expected": "C",
        "points": 8,
    },
    {
        "label": "신입 백지호는 사수 임채원과 같은 C",
        "type": "csv_cell",
        "path": "output/seat_plan.csv",
        "column": "zone",
        "row_match": "name=백지호",
        "expected": "C",
        "points": 8,
    },
    {
        "label": "듀얼 모니터 조민석 → C",
        "type": "csv_cell",
        "path": "output/seat_plan.csv",
        "column": "zone",
        "row_match": "name=조민석",
        "expected": "C",
        "points": 7,
    },
    {
        "label": "집중 업무 권시우 → 가장 조용한 C",
        "type": "csv_cell",
        "path": "output/seat_plan.csv",
        "column": "zone",
        "row_match": "name=권시우",
        "expected": "C",
        "points": 9,
    },
    {"label": "안내문 생성", "type": "file_exists", "path": "output/seat_notice.md", "points": 4},
    {
        "label": "안내문에 이동 일자 기재",
        "type": "file_contains",
        "path": "output/seat_notice.md",
        "pattern": r"2026-10-30",
        "points": 6,
    },
    {
        "label": "안내문에 문의처 기재",
        "type": "file_contains",
        "path": "output/seat_notice.md",
        "pattern": r"3120",
        "points": 5,
    },
    {
        "label": "안내문 분량 (최소 100단어)",
        "type": "file_min_words",
        "path": "output/seat_notice.md",
        "min_count": 100,
        "points": 5,
    },
]

SCENARIO = {
    "title": "7층 이전 좌석 재배치",
    "summary": "일반 문제 해결 — 시설 제약과 팀 사정을 모두 모아야 자리가 하나로 정해지는 배치 과제",
    "difficulty": "medium",
    "briefing_md": """**월요일 오전 11시.**

이번 달 말에 7층으로 이동합니다. 총무팀에서 좌석 배치를 만들어 달라고 합니다. 인원은 11명, 자리는 정확히 11석입니다. 여유 좌석이 없으니 한 사람을 잘못 넣으면 나머지가 전부 밀립니다.

명단과 층 도면은 워크스페이스에 있습니다. 이름을 빈칸에 채워 넣으면 표는 금방 완성됩니다.

문제는 어느 자리에 무엇이 안 되는지, 누구를 떼어 놓으면 안 되는지가 도면에 적혀 있지 않다는 것입니다. 그 제약들은 총무팀과 팀장이 각각 절반씩 알고 있습니다.

메신저에 새 메시지가 와 있습니다.""",
    "agent_enabled": True,
    "desktop_apps": ["files", "sheet", "docs"],
    "characters": CHARACTERS,
    "opening_messages": OPENING,
    "initial_files": [
        {"path": "data/members.csv", "content": MEMBERS_CSV},
        {"path": "notes/7층_좌석_재배치_요청.md", "content": FLOOR_MD},
    ],
    "objectives_md": OBJECTIVES,
    "checks": CHECKS,
}

"""G01 — 워크숍 장소 고르기 (단순 문제 해결 · 조건 비교).

표에 있는 다섯 곳 중 하나를 고르는 일이다. 어렵지 않다 — 단, 무엇을 기준으로
걸러야 하는지가 표에 없다. 예산 상한, 이동 시간, 필수 설비, 식단 요건은 사람에게
물어야 나오고, 그 조건을 모두 적용하면 남는 곳은 한 곳뿐이다.

가장 흔한 실패는 "1인당 대관료가 제일 싼 곳"을 고르는 것이다. 식대를 합치면
순위가 뒤집히고, 그 곳은 채식 식단이 되지 않아 애초에 후보가 아니다.
"""

VENUES_CSV = """venue,capacity,room_fee_per_person,meal_per_person,travel_min,projector,vegetarian
가평 숲속연수원,40,45000,18000,95,있음,가능
양평 리버하우스,35,38000,22000,70,있음,불가
용인 세미나센터,30,40000,20000,55,있음,가능
파주 아트캠프,50,52000,15000,80,없음,가능
인천 베이컨퍼런스,36,35000,25000,65,있음,가능
"""

REQUEST_NOTE_MD = """# 하반기 팀 워크숍 장소 선정 요청

- 일정: 2026-11-13(금) 09:30 ~ 17:30, 당일치기.
- 후보지 다섯 곳의 견적을 받아 `data/venues.csv` 로 정리해 두었습니다.
  (1인 대관료 / 1인 식대 / 회사에서 버스 이동 시간 / 프로젝터 유무 / 채식 식단 가능 여부)
- **참석 인원, 예산 한도, 이동 시간 기준, 필수 설비는 총무팀에 확인하고 진행하세요.**
- 결과는 비교표와 짧은 품의 메모로 제출합니다.
"""

CHARACTERS = [
    {
        "key": "ga_sunwoo",
        "name": "정선우",
        "role": "총무팀 대리",
        "color": "#0ea5e9",
        "gender": "male",
        "encounter": "워크숍 얘기만 해도 벌써 신나지 않아요? 준비해야 하는데 자꾸 놀 생각부터 나서 큰일이에요.",
        "office_voice": "평소의 꼼꼼함 사이로 들뜬 기대와 수줍은 웃음이 나온다. 사적인 취향은 가볍게 나누되 확정되지 않은 행사 내용을 만들지 않는다.",
        "persona": (
            "친절하지만 묻지 않은 것은 말하지 않는다. 질문을 하나 하면 하나를 정확히 답한다. "
            "'알아서 좋은 데로 잡아 주세요' 라고 하면 기준부터 정하자고 되돌려 준다."
        ),
        "knowledge": (
            "참석 확정 인원은 32명이다. 원래 35명이었는데 세 명이 같은 날 고객사 방문이 잡혀서 빠졌다. "
            "예산은 1인당 총액(대관료 + 식대) 80,000원 이하다. 이 금액을 넘으면 대표이사 결재가 따로 필요해서 사실상 불가능하다. "
            "버스 이동 시간은 편도 80분 이내여야 한다. 작년에 95분 걸리는 곳으로 갔다가 오전 일정이 다 밀려서 그 뒤로 기준이 생겼다. "
            "장소 수용 인원은 참석 인원 이상이면 된다. 여유는 따지지 않는다. "
            "결과는 표로 받고 싶다 — 경로는 output/venue_compare.csv, 헤더는 venue,per_person_cost,total_cost,eligible 순서 그대로. "
            "per_person_cost 는 1인 대관료와 1인 식대를 합한 금액, total_cost 는 거기에 참석 인원을 곱한 금액이다. "
            "eligible 은 조건을 모두 만족하면 '적합', 하나라도 못 맞추면 '부적합' 으로 적는다. 후보 다섯 곳을 모두 넣어야 한다. "
            "그리고 output/venue_memo.md 로 짧은 품의 메모를 써 주면 된다. 어디로 정했는지, 1인 총액과 전체 금액이 얼마인지, "
            "탈락한 곳은 왜 탈락했는지가 들어가야 결재가 올라간다. "
            "필수 설비와 식단 조건은 내가 정하는 게 아니라 팀에서 요청한 거라, 기획팀 한도윤 님께 물어보시는 게 정확하다."
        ),
    },
    {
        "key": "plan_doyun",
        "name": "한도윤",
        "role": "기획팀 워크숍 담당",
        "color": "#8b5cf6",
        "gender": "male",
        "encounter": "워크숍은 가기 전이 제일 설레는 것 같아요. 아, 저만 벌써 들떠 있는 건 아니죠?",
        "office_voice": "말이 빠르고 생기가 있으며 동료들과 가까워질 일을 기대한다. 농담과 호기심이 자연스럽지만 모든 대화를 억지로 긍정하지 않는다.",
        "persona": "말이 빠르고 실무적이다. 이유를 함께 설명해 준다. 대충 넘어가려는 제안에는 곤란하다고 분명히 말한다.",
        "knowledge": (
            "이번 워크숍은 오후 내내 분임 토의 결과를 발표하는 구성이라 **프로젝터가 반드시 있어야 한다**. "
            "노트북 화면으로 돌려 보는 건 32명한테는 안 된다. 프로젝터가 없는 곳은 후보에서 빼야 한다. "
            "참석자 중 두 명이 채식이다. 종교적인 이유라 대체 메뉴가 아니라 **채식 식단이 실제로 제공되는 곳**이어야 한다. "
            "작년에 '샐러드 더 드릴게요' 로 넘어갔다가 항의가 들어왔다. 그래서 채식 불가한 곳은 후보에서 뺀다. "
            "회의실 하나면 되고, 분임 토의는 같은 공간에서 나눠서 한다. 별도 분임실은 필요 없다. "
            "숙박은 없다. 당일치기다."
        ),
    },
]

OPENING = [
    {
        "character_key": "ga_sunwoo",
        "content": (
            "11월 워크숍 장소 좀 정해 주시겠어요? 후보 다섯 군데 견적은 data/venues.csv 에 정리해 뒀습니다. "
            "그런데 그 표만 보고 제일 싼 데를 고르시면 안 되고, 저희 쪽 조건이 몇 가지 있어요. 물어보시면 알려 드릴게요."
        ),
    },
]

OBJECTIVES = """## 실제 요구사항 (응시자는 대화로 파악해야 함)

후보 5곳을 비교해 조건을 모두 만족하는 한 곳을 고르고, 비교표와 품의 메모를 낸다.

1. **조건 (표에 없고 대화로만 나옴)**
   - 참석 32명 → 수용 인원 32명 이상 (정선우)
   - 1인 총액(대관료+식대) **80,000원 이하** (정선우)
   - 편도 이동 **80분 이내** (정선우, 80분은 포함)
   - **프로젝터 필수** (한도윤)
   - **채식 식단 가능** 필수 (한도윤)
2. **판정**
   | 후보 | 1인 총액 | 판정 이유 |
   |---|---|---|
   | 가평 숲속연수원 | 63,000 | 이동 95분 → 부적합 |
   | 양평 리버하우스 | 60,000 | 채식 불가 → 부적합 |
   | 용인 세미나센터 | 60,000 | 수용 30명 < 32명 → 부적합 |
   | 파주 아트캠프 | 67,000 | 프로젝터 없음 → 부적합 |
   | **인천 베이컨퍼런스** | **60,000** | 모든 조건 충족 → **적합** |

   전체 금액 = 60,000 × 32 = **1,920,000원**
3. **산출물**
   - `output/venue_compare.csv` — 헤더 `venue,per_person_cost,total_cost,eligible`, 5개 후보 전부, eligible 은 `적합`/`부적합`
   - `output/venue_memo.md` — 선정 결과, 1인 총액과 전체 금액, 탈락 사유

### 함정
- 1인 대관료만 보면 인천(35,000)이 최저지만, 대관료 최저가 곧 총액 최저는 아니다 — 인천은 식대가 가장 비싸고,
  총액으로는 양평·용인과 같은 60,000원이다. **가격이 아니라 조건이 답을 정한다.**
- 이동 80분은 '이내'이므로 파주(80분)는 이동 조건을 통과한다. 파주가 떨어지는 이유는 프로젝터다.
- 조건을 하나라도 빠뜨리면 적합 판정이 둘 이상 나온다.

### 정보 분포
- 정선우(총무): 인원 32명, 1인 80,000원 한도, 이동 80분 기준, 산출물 형식.
- 한도윤(기획): 프로젝터 필수, 채식 식단 필수.
"""

CHECKS = [
    {"label": "비교표 생성", "type": "file_exists", "path": "output/venue_compare.csv", "points": 6},
    {
        "label": "후보 5곳 모두 비교",
        "type": "csv_row_count",
        "path": "output/venue_compare.csv",
        "expected": "5",
        "points": 8,
    },
    {
        "label": "인천 1인 총액 (대관료+식대)",
        "type": "csv_cell",
        "path": "output/venue_compare.csv",
        "column": "per_person_cost",
        "row_match": "venue=인천 베이컨퍼런스",
        "expected": "60000",
        "points": 8,
    },
    {
        "label": "인천 전체 금액 (32명)",
        "type": "csv_cell",
        "path": "output/venue_compare.csv",
        "column": "total_cost",
        "row_match": "venue=인천 베이컨퍼런스",
        "expected": "1920000",
        "points": 10,
    },
    {
        "label": "인천 = 적합 (유일한 해)",
        "type": "csv_cell",
        "path": "output/venue_compare.csv",
        "column": "eligible",
        "row_match": "venue=인천 베이컨퍼런스",
        "expected": "적합",
        "points": 12,
    },
    {
        "label": "가평 부적합 (이동 95분)",
        "type": "csv_cell",
        "path": "output/venue_compare.csv",
        "column": "eligible",
        "row_match": "venue=가평 숲속연수원",
        "expected": "부적합",
        "points": 8,
    },
    {
        "label": "양평 부적합 (채식 불가)",
        "type": "csv_cell",
        "path": "output/venue_compare.csv",
        "column": "eligible",
        "row_match": "venue=양평 리버하우스",
        "expected": "부적합",
        "points": 8,
    },
    {
        "label": "용인 부적합 (수용 인원 부족)",
        "type": "csv_cell",
        "path": "output/venue_compare.csv",
        "column": "eligible",
        "row_match": "venue=용인 세미나센터",
        "expected": "부적합",
        "points": 8,
    },
    {
        "label": "파주 부적합 (프로젝터 없음)",
        "type": "csv_cell",
        "path": "output/venue_compare.csv",
        "column": "eligible",
        "row_match": "venue=파주 아트캠프",
        "expected": "부적합",
        "points": 8,
    },
    {"label": "품의 메모 생성", "type": "file_exists", "path": "output/venue_memo.md", "points": 6},
    {
        "label": "메모에 전체 금액 기재",
        "type": "file_contains",
        "path": "output/venue_memo.md",
        "pattern": r"1,?920,?000",
        "points": 10,
    },
    {
        "label": "메모 분량 (최소 90단어)",
        "type": "file_min_words",
        "path": "output/venue_memo.md",
        "min_count": 90,
        "points": 8,
    },
]

SCENARIO = {
    "title": "하반기 워크숍 장소 선정",
    "summary": "단순 문제 해결 — 표에 없는 선정 기준을 대화로 모아야 후보가 하나로 좁혀지는 비교·계산 과제",
    "difficulty": "easy",
    "briefing_md": """**수요일 오후 2시.**

총무팀에서 11월 팀 워크숍 장소를 정해 달라는 요청이 왔습니다. 후보 다섯 곳의 견적은 이미 표로 정리돼 있습니다.

표만 보면 5분이면 끝날 일처럼 보입니다. 그런데 이 표에는 "무엇을 기준으로 골라야 하는가"가 없습니다. 인원도, 예산 한도도, 어떤 설비가 꼭 있어야 하는지도 적혀 있지 않습니다.

기준을 물어보지 않고 고른 답은, 거의 확실히 틀린 답입니다.

메신저에 새 메시지가 와 있습니다.""",
    "agent_enabled": True,
    "desktop_apps": ["files", "sheet", "docs"],
    "characters": CHARACTERS,
    "opening_messages": OPENING,
    "initial_files": [
        {"path": "data/venues.csv", "content": VENUES_CSV},
        {"path": "notes/워크숍_장소_요청.md", "content": REQUEST_NOTE_MD},
    ],
    "objectives_md": OBJECTIVES,
    "checks": CHECKS,
}

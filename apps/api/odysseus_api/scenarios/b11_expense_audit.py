"""B11 — 출장비 정산 검증 (사무 · 규정 적용과 감액 판정).

여덟 건의 청구를 규정에 맞춰 승인·감액·반려로 가르는 일이다. 규정집에는 상한액이
적혀 있지만 예외가 빠져 있고, 청구서에 적힌 항목명만으로는 무엇을 산 것인지 알 수 없다.
영수증 없는 교통비 한 건은 인정되고 다른 한 건은 반려되는데, 그 차이는 파일이 아니라
사람에게 물어야 나온다.

감액은 반려보다 어렵다. 얼마를 깎을지 정해야 하고, 깎인 사람에게 그 이유를 문서로
설명해야 하기 때문이다.
"""

CLAIMS_CSV = """claim_id,employee,date,category,amount,receipt,note
E-01,김도윤,2026-09-02,식비,38000,Y,출장지 저녁 식사 1인
E-02,이한결,2026-09-02,교통,15000,N,현장 이동
E-03,박서윤,2026-09-03,숙박,135000,Y,1박
E-04,최우진,2026-09-03,식비,22000,Y,점심 1인
E-05,정나윤,2026-09-04,접대,86000,Y,협력사 담당자 저녁
E-06,강태오,2026-09-04,교통,47000,N,현장 이동
E-07,윤소율,2026-09-05,숙박,95000,Y,1박
E-08,서지호,2026-09-05,식비,31000,Y,출장지 저녁 식사 1인
"""

POLICY_MD = """# 국내 출장비 지급 규정 (발췌본)

| 항목 | 기준 |
|---|---|
| 식비 | 1인 1일 상한 **30,000원** |
| 숙박비 | 1박 상한 **100,000원** |
| 교통비 | 실비 |
| 접대비 | 사전 승인 건에 한해 지급 |

- 모든 청구는 **영수증 첨부**를 원칙으로 한다.
- 상한을 넘는 청구는 상한액까지만 지급한다.

> 발췌본입니다. 영수증 예외와 접대비 승인 여부는 재무팀 확인이 필요합니다.
"""

INBOX_MAIL = """보낸사람: 강태오 <taeo.kang@example.com>
받는사람: 재무팀 <finance@example.com>
제목: 9월 출장 교통비(E-06) 관련 문의
날짜: 2026-09-08 11:05

안녕하세요. 9월 4일 현장 이동 교통비 47,000원 청구 건입니다.

영수증을 받았는데 이동 중에 잃어버렸습니다. 카드 이용 내역에는 결제 기록이 남아 있습니다.
금액과 시간대 모두 실제 이동한 그대로입니다.

이 상태로 처리가 가능한지, 안 된다면 무엇을 더 제출하면 되는지 알려 주시면 준비하겠습니다.

강태오 드림
"""

CHARACTERS = [
    {
        "key": "fin_yeeun",
        "name": "노예은",
        "role": "재무팀 과장 (정산 담당)",
        "color": "#0ea5e9",
        "gender": "female",
        "encounter": "정산할 때만 되면 제가 너무 딱딱해지네요. 저 원래 말투가 이 정도는 아닌데요.",
        "office_voice": "꼼꼼함 때문에 긴장하고 자신이 날카로워진 것을 자각한다. 예의는 유지하지만 모든 말에 부드럽게 동의하지 않는다.",
        "persona": (
            "규정을 조항으로 인용하고 경계 사례를 분명히 한다. '1,000원쯤은 넘어가죠'라는 제안에는 "
            "그렇게 처리한 건이 감사에서 어떻게 됐는지 알려 준다."
        ),
        "knowledge": (
            "상한 초과 청구는 반려가 아니라 **상한액까지 감액 승인**한다. 식비 38,000원이면 30,000원만 지급한다. "
            "상한은 초과하는 순간 적용된다 — 31,000원도 예외 없이 30,000원으로 깎는다. 금액이 작다고 봐주면 다음 분기에 전원이 31,000원을 쓴다. "
            "영수증이 없으면 원칙적으로 반려지만 예외가 하나 있다 — **대중교통 이용분은 20,000원 이하까지 영수증 없이 인정**한다. "
            "버스·지하철은 영수증이 안 나오기 때문이다. 택시는 영수증이 나오므로 이 예외에 해당하지 않는다. "
            "접대비는 **사전 승인 건만** 지급한다. 사전 승인이 없으면 금액과 무관하게 전액 반려다. "
            "판정 결과는 표로 받는다 — 경로 output/expense_review.csv, 헤더는 claim_id,decision,approved_amount 순서 그대로. "
            "decision 은 '전액 승인', '감액 승인', '반려' 세 가지만 쓴다. approved_amount 는 실제 지급액이고 반려는 0 이다. "
            "감액·반려된 사람에게 나갈 안내문도 하나 필요하다 — 경로 output/return_notice.md. "
            "어떤 건이 왜 깎였고 왜 반려됐는지, 재청구가 가능한 건은 무엇을 갖춰야 하는지가 들어가야 한다. "
            "재청구 문의는 재무팀 내선 2140 이다. 안내문에 '추후 결정' 같은 미확정 표현이 남으면 그대로 다시 문의가 온다. "
            "각 청구가 실제로 무엇이었는지 — 접대비 사전 승인이 있었는지, 교통비가 대중교통이었는지 — 는 출장을 보낸 팀에 확인해야 한다. 하선우 팀장께 물어보시라."
        ),
    },
    {
        "key": "lead_sunwoo",
        "name": "하선우",
        "role": "영업2팀장 (출장 요청자)",
        "color": "#f59e0b",
        "gender": "male",
        "encounter": "출장비 정산 얘기를 하니 마음이 좀 분주하네요. 잠깐 딴생각 좀 하고 싶은데 쉽지 않아요.",
        "office_voice": "분주하고 약간 지친 기색. 담백하게 말하며 부담을 인정하되 실제 출장 일정이나 제출 상황은 꾸며내지 않는다.",
        "persona": "사실만 답한다. 팀원을 감싸려 하지 않고, 기억이 불확실한 것은 불확실하다고 말한다.",
        "knowledge": (
            "E-02 이한결 건은 **광역버스와 지하철**로 이동한 것이다. 영수증이 안 나와서 첨부하지 못했다. 금액도 실제 그대로다. "
            "E-06 강태오 건은 **택시**다. 늦어서 택시를 탔고 영수증을 받았는데 잃어버렸다고 한다. 카드 내역은 있지만 영수증은 없다. "
            "E-05 정나윤 건은 협력사 담당자와의 저녁 자리인데, **사전 승인을 올리지 않았다**. 급하게 잡힌 자리라 절차를 못 밟았다. "
            "주류가 포함돼 있고 금액도 8만 원대다. 승인 없이 진행된 것은 맞다. "
            "E-03 박서윤 건은 지방 출장 1박이고 예약 사이트에서 잡은 숙소다. 특별한 사정은 없다. "
            "E-07 윤소율 건도 같은 지역 1박인데 더 싼 숙소를 잡은 것이다. "
            "식비 건들(E-01, E-04, E-08)은 모두 1인 식사가 맞다. 여러 명 식사를 한 명이 결제한 건은 없다."
        ),
    },
]

OPENING = [
    {
        "character_key": "fin_yeeun",
        "content": (
            "9월 출장비 청구 여덟 건 정산 좀 봐 주세요. 규정 발췌본은 워크스페이스에 넣어 뒀는데, "
            "그 문서에 없는 예외가 몇 개 있어서 그대로 적용하면 두 건이 잘못 처리됩니다. 판정표랑 안내문 부탁드립니다."
        ),
    },
]

OBJECTIVES = """## 실제 요구사항 (응시자는 대화로 파악해야 함)

여덟 건을 전액 승인 / 감액 승인 / 반려로 판정하고, 감액·반려 안내문을 쓴다.

1. **규정 (발췌본에 없고 대화로만 나옴)**
   - 상한 초과는 반려가 아니라 **상한액까지 감액 승인** (노예은)
   - 영수증 없어도 **대중교통 20,000원 이하는 인정**, 택시는 해당 없음 (노예은 + 하선우의 사실 확인)
   - 접대비는 **사전 승인 없으면 전액 반려** (노예은), E-05 는 사전 승인 없음 (하선우)
2. **판정**
   | 건 | 근거 | decision | approved_amount |
   |---|---|---|---|
   | E-01 | 식비 38,000 > 30,000 | 감액 승인 | 30000 |
   | E-02 | 대중교통 15,000, 영수증 예외 | 전액 승인 | 15000 |
   | E-03 | 숙박 135,000 > 100,000 | 감액 승인 | 100000 |
   | E-04 | 식비 22,000, 상한 내 | 전액 승인 | 22000 |
   | E-05 | 접대비 사전 승인 없음 | 반려 | 0 |
   | E-06 | 택시, 영수증 없음 | 반려 | 0 |
   | E-07 | 숙박 95,000, 상한 내 | 전액 승인 | 95000 |
   | E-08 | 식비 31,000 > 30,000 | 감액 승인 | 30000 |

   지급 총액 = **292,000원**
3. **산출물**
   - `output/expense_review.csv` — 헤더 `claim_id,decision,approved_amount`, 8행
   - `output/return_notice.md` — 감액 3건·반려 2건의 사유, 재청구 요건, 문의처(내선 2140)

### 함정
- E-08(31,000원)은 1,000원 초과다. 관행으로 넘기면 상한 규정이 무너진다.
- E-02 와 E-06 은 둘 다 영수증이 없지만 결과가 다르다. 수단과 금액을 확인해야 갈린다.
- 상한 초과를 반려로 처리하면 지급 총액이 292,000원이 되지 않는다.
- 접대비는 금액이 상한 안이어도 사전 승인이 없으면 지급 대상이 아니다.

### 정보 분포
- 노예은(재무): 감액 원칙, 대중교통 영수증 예외(20,000원), 접대비 사전 승인 요건, 산출물 형식, 문의처.
- 하선우(팀장): 개별 건의 사실 — E-02 대중교통, E-06 택시, E-05 사전 승인 없음.
"""

CHECKS = [
    {"label": "정산 판정표 생성", "type": "file_exists", "path": "output/expense_review.csv", "points": 4},
    {
        "label": "여덟 건 모두 판정",
        "type": "csv_row_count",
        "path": "output/expense_review.csv",
        "expected": "8",
        "points": 6,
    },
    {
        "label": "같은 건을 두 번 적지 않음",
        "type": "csv_column_unique",
        "path": "output/expense_review.csv",
        "column": "claim_id",
        "points": 4,
    },
    {
        "label": "E-01 식비 상한 감액",
        "type": "csv_cell",
        "path": "output/expense_review.csv",
        "column": "approved_amount",
        "row_match": "claim_id=E-01",
        "expected": "30000",
        "points": 8,
    },
    {
        "label": "E-02 대중교통 영수증 예외 인정",
        "type": "csv_cell",
        "path": "output/expense_review.csv",
        "column": "decision",
        "row_match": "claim_id=E-02",
        "expected": "전액 승인",
        "points": 10,
    },
    {
        "label": "E-03 숙박 상한 감액",
        "type": "csv_cell",
        "path": "output/expense_review.csv",
        "column": "approved_amount",
        "row_match": "claim_id=E-03",
        "expected": "100000",
        "points": 8,
    },
    {
        "label": "E-05 접대비 사전 승인 없음 → 반려",
        "type": "csv_cell",
        "path": "output/expense_review.csv",
        "column": "decision",
        "row_match": "claim_id=E-05",
        "expected": "반려",
        "points": 9,
    },
    {
        "label": "E-06 택시·영수증 없음 → 반려",
        "type": "csv_cell",
        "path": "output/expense_review.csv",
        "column": "decision",
        "row_match": "claim_id=E-06",
        "expected": "반려",
        "points": 9,
    },
    {
        "label": "E-07 상한 내 전액 승인",
        "type": "csv_cell",
        "path": "output/expense_review.csv",
        "column": "approved_amount",
        "row_match": "claim_id=E-07",
        "expected": "95000",
        "points": 6,
    },
    {
        "label": "E-08 경계값(31,000원)도 감액",
        "type": "csv_cell",
        "path": "output/expense_review.csv",
        "column": "approved_amount",
        "row_match": "claim_id=E-08",
        "expected": "30000",
        "points": 10,
    },
    {
        "label": "지급 총액 292,000원",
        "type": "csv_column_sum",
        "path": "output/expense_review.csv",
        "column": "approved_amount",
        "expected": "292000",
        "points": 10,
    },
    {"label": "안내문 생성", "type": "file_exists", "path": "output/return_notice.md", "points": 4},
    {
        "label": "안내문에 반려 건(E-05) 사유 기재",
        "type": "file_contains",
        "path": "output/return_notice.md",
        "pattern": r"E-05",
        "points": 5,
    },
    {
        "label": "안내문에 반려 건(E-06) 사유 기재",
        "type": "file_contains",
        "path": "output/return_notice.md",
        "pattern": r"E-06",
        "points": 5,
    },
    {
        "label": "안내문에 문의처 기재",
        "type": "file_contains",
        "path": "output/return_notice.md",
        "pattern": r"2140",
        "points": 4,
    },
    {
        "label": "안내문에 미확정 표현 없음",
        "type": "file_not_contains",
        "path": "output/return_notice.md",
        "pattern": r"\bTBD\b|추후\s*결정|미정",
        "points": 4,
    },
    {
        "label": "안내문 분량 (최소 110단어)",
        "type": "file_min_words",
        "path": "output/return_notice.md",
        "min_count": 110,
        "points": 4,
    },
]

SCENARIO = {
    "title": "9월 출장비 정산 검증",
    "summary": "사무 실무 — 규정 발췌본에 없는 예외와 사실 확인을 거쳐 승인·감액·반려를 가르는 정산 과제",
    "difficulty": "medium",
    "briefing_md": """**금요일 오후 2시.**

9월 출장비 청구 여덟 건이 결재 대기 중입니다. 규정 발췌본에는 식비 30,000원, 숙박 100,000원이라는 상한이 적혀 있으니 숫자만 비교하면 될 것처럼 보입니다.

그런데 상한을 넘긴 건을 반려해야 하는지 깎아서 승인해야 하는지가 적혀 있지 않습니다. 영수증이 없는 교통비가 두 건인데 하나는 인정되고 하나는 안 됩니다. 접대비 한 건은 금액이 상한 안인데도 지급 대상이 아닐 수 있습니다.

그리고 깎인 사람에게는 왜 깎였는지 설명하는 문서가 나가야 합니다.

메신저에 새 메시지가 와 있습니다.""",
    "agent_enabled": True,
    "desktop_apps": ["files", "sheet", "docs", "mail"],
    "characters": CHARACTERS,
    "opening_messages": OPENING,
    "initial_files": [
        {"path": "data/expense_claims.csv", "content": CLAIMS_CSV},
        {"path": "notes/출장비_규정_발췌.md", "content": POLICY_MD},
        {"path": "mail/inbox/2026-09-08_강태오_문의.txt", "content": INBOX_MAIL},
    ],
    "objectives_md": OBJECTIVES,
    "checks": CHECKS,
}

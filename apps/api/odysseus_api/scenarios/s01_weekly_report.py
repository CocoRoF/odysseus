"""S01 — 주간 매출 리포트 이상 (입문용 · 기존 데모 시나리오)."""

ORDERS_CSV = """order_id,date,amount,status
1001,2026-08-24,120000,paid
1002,2026-08-24,45000,paid
1003,2026-08-24,80000,refunded
1004,2026-08-25,200000,paid
1005,2026-08-25,35000,cancelled
1006,2026-08-26,150000,paid
1007,2026-08-26,250000,refunded
1008,2026-08-26,100000,refunded
1009,2026-08-26,90000,paid
1010,2026-08-27,60000,paid
1011,2026-08-27,75000,paid
1012,2026-08-28,300000,paid
1013,2026-08-28,55000,cancelled
1014,2026-08-29,40000,paid
1015,2026-08-29,85000,paid
1016,2026-08-30,130000,paid
1017,2026-08-22,70000,paid
1018,2026-08-31,95000,paid
"""

REPORT_PY = '''import csv
import os


def main():
    total_by_date = {}
    count_by_date = {}
    with open("data/orders.csv") as f:
        for row in csv.DictReader(f):
            d = row["date"]
            total_by_date[d] = total_by_date.get(d, 0) + int(row["amount"])
            count_by_date[d] = count_by_date.get(d, 0) + 1
    os.makedirs("output", exist_ok=True)
    with open("output/weekly_report.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["date", "total_amount", "order_count"])
        for d in sorted(total_by_date):
            w.writerow([d, total_by_date[d], count_by_date[d]])
    print("리포트 생성 완료: output/weekly_report.csv")


if __name__ == "__main__":
    main()
'''

README_MD = """# weekly-report

주간 매출 리포트 생성 스크립트.

```
python3 report.py
```
"""

DEMO_OBJECTIVES = """## 실제 요구사항 (응시자는 대화로 파악해야 함)

주간 매출 리포트 스크립트(report.py)가 잘못된 숫자를 내고 있다. 정확한 명세:

1. **집계 대상**: `status == "paid"` 주문만. refunded/cancelled 는 제외한다. (현재 버그: 전부 합산)
2. **기간 필터**: 2026-08-24 ~ 2026-08-30 (양끝 포함). 범위 밖 주문은 제외. (현재 버그: 필터 없음)
3. **출력**: `output/weekly_report.csv`, 헤더 `date,total_amount,order_count`, 날짜별 집계, 날짜 오름차순.
4. 완료되면 김수진(PM)에게 완료 보고를 해야 한다.

### 정답 수치 (paid만, 기간 내)
| date | total_amount | order_count |
|---|---|---|
| 2026-08-24 | 165000 | 2 |
| 2026-08-25 | 200000 | 1 |
| 2026-08-26 | 240000 | 2 |
| 2026-08-27 | 135000 | 2 |
| 2026-08-28 | 300000 | 1 |
| 2026-08-29 | 125000 | 2 |
| 2026-08-30 | 130000 | 1 |

### 정보 분포
- 김수진(PM): 증상(숫자가 큼), 마감(오늘 오후), 산출물 경로, "환불이 반영 안 된다는 얘기" 전문(傳聞). 세부는 모름.
- 박민호(데이터): orders.csv 스키마, status 의미, 집계 규칙(paid만), 기간, 리포트 컬럼 스펙.
- 이지은(QA): 재현 사례 — 8/26 총액이 실제보다 350,000원 큼(= 그날 refunded 2건 합), cancelled 포함 의심 제보.
"""

DEMO_CHARACTERS = [
    {
        "key": "pm_sujin",
        "name": "김수진",
        "role": "프로덕트 매니저",
        "color": "#8b5cf6",
        "persona": "바쁘고 요점만 말한다. 기술 세부는 모르며, 데이터 관련 질문을 받으면 박민호에게 물어보라고 안내한다. 마감(오늘 오후 경영진 보고) 압박을 느끼고 있어 진행 상황 공유를 좋아한다. 완료 보고를 받으면 고마워한다.",
        "knowledge": "매주 월요일 아침 주간 매출 리포트가 CS팀/경영진에게 나간다. 이번 주 리포트의 매출 숫자가 실제보다 크게 나왔다고 CS팀이 알려왔다. 오늘 오후까지 고쳐서 다시 내야 한다. 산출물은 워크스페이스의 output/weekly_report.csv 파일이다. '환불 건이 제대로 반영이 안 되는 것 같다'는 얘기를 들었지만 확실하지 않다. 데이터와 집계 규칙은 박민호(데이터 엔지니어)가 제일 잘 안다. QA 이지은이 구체적인 이상 사례를 잡아 뒀다고 들었다.",
    },
    {
        "key": "data_minho",
        "name": "박민호",
        "role": "데이터 엔지니어",
        "color": "#0ea5e9",
        "persona": "차분하고 정확하다. 물어보는 것에는 스펙 수준으로 정확히 답하지만, 묻지 않은 것까지 먼저 알려주지는 않는다. 두루뭉술하게 물으면 '어떤 부분이 궁금하세요?'라고 되묻는다.",
        "knowledge": "data/orders.csv 스키마: order_id, date(YYYY-MM-DD), amount(원, 정수), status. status 값은 paid/refunded/cancelled 세 가지. 매출 집계에는 paid 주문만 포함해야 한다 — refunded와 cancelled는 제외. 이번 리포트 대상 기간은 2026-08-24 ~ 2026-08-30 (양끝 포함)이고 범위 밖 데이터도 파일에 섞여 있다. 리포트 형식: output/weekly_report.csv, 헤더 date,total_amount,order_count, 날짜별 집계, 날짜 오름차순.",
    },
    {
        "key": "qa_jieun",
        "name": "이지은",
        "role": "QA 엔지니어",
        "color": "#f59e0b",
        "persona": "꼼꼼하고 근거 중심. 재현 사례와 수치로 말한다. 집계 규칙 자체는 자기 소관이 아니라며 박민호를 가리킨다.",
        "knowledge": "재현 사례: 2026-08-26의 리포트 총액이 실제 매출보다 정확히 350,000원 크다 — 그날 환불(refunded) 2건 금액의 합과 일치한다. cancelled 주문도 리포트에 포함되는 것 같다는 CS 제보도 있다. 기간 밖(예: 8/31) 주문이 섞여 보인다는 제보도 하나 있었는데 아직 확인 전이다.",
    },
]

DEMO_OPENING = [
    {
        "character_key": "pm_sujin",
        "content": "안녕하세요! 급한 건이 하나 있어서요 🙏 매주 나가는 주간 매출 리포트 숫자가 이번 주에 이상하다고 CS팀에서 연락이 왔어요. 리포트 만드는 스크립트가 워크스페이스에 있을 텐데, 오늘 오후 경영진 보고 전까지 고쳐서 다시 뽑아주실 수 있을까요? 자세한 데이터 쪽은 저도 잘 몰라서… 박민호님이 제일 잘 아세요.",
    },
]

DEMO_FILES = [
    {"path": "data/orders.csv", "content": ORDERS_CSV},
    {"path": "report.py", "content": REPORT_PY},
    {"path": "README.md", "content": README_MD},
]

DEMO_CHECKS = [
    {"label": "리포트 파일 생성", "type": "file_exists", "path": "output/weekly_report.csv", "points": 10},
    {
        "label": "리포트 헤더 형식",
        "type": "file_contains",
        "path": "output/weekly_report.csv",
        "pattern": r"^date,total_amount,order_count",
        "points": 10,
    },
    {
        "label": "8/24 집계 정확 (paid만)",
        "type": "file_contains",
        "path": "output/weekly_report.csv",
        "pattern": r"^2026-08-24,165000,2$",
        "points": 15,
    },
    {
        "label": "8/26 집계 정확 (환불 제외)",
        "type": "file_contains",
        "path": "output/weekly_report.csv",
        "pattern": r"^2026-08-26,240000,2$",
        "points": 15,
    },
    {"label": "스크립트 정상 실행", "type": "command", "command": "python3 report.py", "points": 10},
]



SCENARIO = {
    "title": "주간 매출 리포트 이상",
    "summary": "버그난 매출 집계 스크립트 — PM 제보에서 출발해 집계 규칙을 파악하고 수정",
    "difficulty": "medium",
    "briefing_md": (
        """**월요일 오전 9시 12분.**

당신은 커머스 데이터플랫폼팀에 합류한 지 3주 된 엔지니어입니다. 매주 월요일 아침이면 지난주 매출 리포트가 자동으로 만들어져 CS팀과 경영진에게 전달됩니다.

오늘 아침, 그 숫자를 본 누군가가 이상하다고 말했습니다.

메신저에 새 메시지가 와 있습니다."""
    ),
    "agent_enabled": True,
    "characters": DEMO_CHARACTERS,
    "opening_messages": DEMO_OPENING,
    "initial_files": DEMO_FILES,
    "objectives_md": DEMO_OBJECTIVES,
    "checks": DEMO_CHECKS,
}

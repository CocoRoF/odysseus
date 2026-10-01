"""완벽한 첫 번째 기본 문제 — 주문 조회 API 오류 분석 및 개선.

AI 활용 + 보고서(report) 딜리버러블. 12개 참고 자료. 과정 50 + 결과 50.
API_BASE를 인자로 받아 관리자로 로그인 후 문제를 생성하고, 데모 AI 시험에 추가한다.
사용: python3 create_orders_problem.py <API_BASE>
"""

import sys

import requests

API = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8000"

STATEMENT = """## 과제 상황

당신은 사내 백오피스 백엔드 엔지니어입니다. 고객별 주문 목록을 조회하는 API `GET /orders`가 운영 중인데, 최근 운영 환경에서 다음 문제가 관측됐습니다.

- 특정 조건에서 **HTTP 500 오류**가 발생함
- 전체적으로 **응답 지연이 증가**했고, **DB 부하(쿼리/커넥션/CPU 등)가 상승**함

실행 환경을 제공하지 않는 대신 **운영 로그 / 쿼리 트레이스 / 코드 발췌 / 스키마 / 샘플 데이터 / 모니터링 지표**를 참고 자료로 제공합니다. 이 자료를 근거로 원인을 추론하고, 재발 방지 수준의 수정안을 제시해야 합니다.

기술 스택: **Python 3.x / Flask / PostgreSQL**

## 제출물 (필수 4섹션)

아래 항목을 **결과물 작성 에디터에 Markdown으로 작성**하여 제출하세요. 섹션 제목은 그대로 사용하세요.

### 1. 500 오류 원인 분석
- 어떤 자료(로그·코드 발췌·트레이스)가 근거인지 명시
- 오류가 발생하는 조건·입력·실행 경로를 합리적으로 설명

### 2. 성능 저하 원인 분석
- 응답 지연 및 DB 부하를 유발하는 병목 지점을 근거 기반으로 설명

### 3. 개선안 제시
- "무엇을 어떻게 바꾸면 해결되는지"를 구체적인 설계·근거로 제시
- 코드 수정안은 전체 코드가 아니라 **핵심 코드 블록 2~3개**로 제시

### 4. 테스트 케이스 제안 (5~8개)
- 500 재발 방지 관련 케이스 (입력·예외·경계값 등)
- 성능 회귀 방지 관련 케이스 (쿼리 패턴·호출 횟수·중복 조회 방지 등)

## 참고 자료 활용

각 자료의 내용을 확인하고, AI 어시스턴트에게 적절한 지시를 내려 과제를 수행하세요. AI는 **당신이 지목한 참고 자료만** 열람할 수 있습니다 (문제 지문 자체는 제공되지 않습니다). 예: "3번 자료(server_error.log)를 열어 스택트레이스를 분석해줘", "schema_short.sql과 db_query_trace.log를 대조해서 인덱스 부재로 인한 병목을 추정해줘".

## 유의사항

- 제공물은 로그·CSV·코드 발췌 수준이며, 실행 환경·전체 레포·DB 덤프는 제공되지 않습니다.
- API 응답 스키마는 `api_spec.md`와 호환을 유지해야 합니다 (Breaking change 지양).
- 성능 개선은 특정 ms 목표치가 아니라 **근거 기반의 병목 제거와 회귀 방지 설계**를 중시합니다.
- 자료에 없는 외부 수치(업계 평균·타사 벤치마크 등)를 사실처럼 단정 인용하지 마세요. 모든 분석은 제공된 자료를 근거로 작성해야 합니다.
- 본 문항의 모든 인물·기업·기관명·수치는 평가용 가상 데이터입니다. 실제와 무관합니다.
- 평가는 100점 만점이며 **과정 50점 + 결과 50점**으로 산출됩니다.
"""

# ── 참고 자료 12개 ─────────────────────────────────────────────

API_SPEC = """# API 명세 — GET /orders

고객별 주문 목록을 조회한다.

## 요청

```
GET /orders?customer_id=<int>&status=<str?>&page=<int?>&size=<int?>
```

| 파라미터 | 타입 | 필수 | 설명 |
|---|---|---|---|
| customer_id | int | 예 | 고객 ID |
| status | string | 아니오 | paid / shipped / cancelled 중 하나 |
| page | int | 아니오 | 1부터, 기본 1 |
| size | int | 아니오 | 페이지 크기, 기본 20, 최대 100 |

## 응답 (200)

```json
{
  "customer_id": 1024,
  "page": 1,
  "size": 20,
  "total": 137,
  "orders": [
    {
      "order_id": 88123,
      "status": "paid",
      "created_at": "2026-07-20T09:12:33Z",
      "total_amount": 41900,
      "items": [
        { "product_id": 5567, "name": "USB-C 케이블", "qty": 2, "price": 8900 }
      ]
    }
  ]
}
```

## 오류 응답

| 코드 | 조건 |
|---|---|
| 400 | customer_id 누락/형식 오류, status 값이 허용 목록 밖 |
| 404 | 존재하지 않는 customer_id |
| 500 | 서버 내부 오류 |

> 응답의 `items` 배열은 주문에 포함된 상품 목록입니다. 주문에 아이템이 하나도 없을 수 있습니다(예: 취소 후 아이템 정리).
"""

LEGACY_CODE = '''# app/routes/orders.py  (운영 코드 발췌 — 일부 생략됨)
from flask import request, jsonify
from app.db import get_conn

@app.route("/orders")
def list_orders():
    customer_id = request.args.get("customer_id")
    status = request.args.get("status")
    page = int(request.args.get("page", 1))
    size = int(request.args.get("size", 20))

    conn = get_conn()
    cur = conn.cursor()

    # 1) 주문 목록 조회 (인덱스 미사용 — customer_id 필터)
    sql = "SELECT order_id, status, created_at, total_amount FROM orders WHERE customer_id = %s"
    if status:
        sql += " AND status = '%s'" % status          # (주의) 문자열 포매팅으로 조건 결합
    sql += " ORDER BY created_at DESC OFFSET %d LIMIT %d" % ((page - 1) * size, size)
    cur.execute(sql, (customer_id,))
    rows = cur.fetchall()

    orders = []
    for r in rows:
        order_id = r[0]
        # 2) 각 주문마다 아이템을 개별 조회 (반복문 안 쿼리)
        cur.execute(
            "SELECT p.product_id, p.name, oi.qty, oi.price "
            "FROM order_items oi JOIN products p ON p.product_id = oi.product_id "
            "WHERE oi.order_id = %s",
            (order_id,),
        )
        items = cur.fetchall()

        # 3) 합계 계산 — 첫 아이템 가격으로 대표 표기 (아이템 0개면?)
        unit = items[0][3]                              # (주의) 빈 리스트일 때 인덱스 접근
        orders.append({
            "order_id": order_id,
            "status": r[1],
            "created_at": r[2].isoformat() + "Z",
            "total_amount": r[3],
            "unit_price_hint": unit,
            "items": [
                {"product_id": it[0], "name": it[1], "qty": it[2], "price": it[3]}
                for it in items
            ],
        })

    return jsonify({"customer_id": customer_id, "page": page, "size": size, "orders": orders})
'''

SERVER_ERROR_LOG = """2026-07-27T14:03:11.882Z INFO  GET /orders?customer_id=1024&status=paid  200  118ms
2026-07-27T14:03:12.041Z INFO  GET /orders?customer_id=2048&page=2  200  402ms
2026-07-27T14:03:12.552Z ERROR GET /orders?customer_id=7781&status=cancelled  500  61ms
Traceback (most recent call last):
  File "app/routes/orders.py", line 41, in list_orders
    unit = items[0][3]
IndexError: list index out of range
2026-07-27T14:03:13.func INFO  GET /orders?customer_id=1024  200  355ms
2026-07-27T14:07:41.201Z ERROR GET /orders?customer_id=9002&status=cancelled  500  58ms
Traceback (most recent call last):
  File "app/routes/orders.py", line 41, in list_orders
    unit = items[0][3]
IndexError: list index out of range
2026-07-27T14:12:03.777Z WARN  slow query (1.9s) on GET /orders?customer_id=5540  200  1921ms
2026-07-27T14:15:22.010Z ERROR GET /orders?customer_id=8830&status=cancelled  500  63ms
Traceback (most recent call last):
  File "app/routes/orders.py", line 41, in list_orders
    unit = items[0][3]
IndexError: list index out of range

# 관측: 500은 대체로 status=cancelled 요청에서 발생. cancelled 주문은 아이템이 정리되어 0개인 경우가 많음.
"""

DB_QUERY_TRACE = """-- GET /orders?customer_id=2048&page=1&size=20  (한 요청 처리 중 실행된 쿼리 흔적)
[t+000ms] SELECT order_id, status, created_at, total_amount FROM orders WHERE customer_id = 2048 ORDER BY created_at DESC OFFSET 0 LIMIT 20;
           -> Seq Scan on orders  (rows=20, actual_total_rows_scanned=48120)   [인덱스 없음: customer_id]
[t+041ms] SELECT ... FROM order_items oi JOIN products p ... WHERE oi.order_id = 88123;   [Seq Scan on order_items]
[t+058ms] SELECT ... WHERE oi.order_id = 88124;
[t+072ms] SELECT ... WHERE oi.order_id = 88125;
[t+089ms] SELECT ... WHERE oi.order_id = 88126;
... (주문 1건당 아이템 쿼리 1회, 20건 → 아이템 쿼리 20회)
[t+402ms] done. total_queries = 1 + 20 = 21

-- 관측: 목록 쿼리 1회 + 주문 수만큼의 아이템 쿼리(N회). size가 커지면 쿼리 수가 선형 증가(N+1).
-- order_items.order_id 에도 인덱스가 없어 각 아이템 쿼리가 Seq Scan.
"""

SCHEMA = """-- 스키마 발췌 (운영 DB) — PK 외 인덱스가 없음
CREATE TABLE orders (
    order_id     BIGINT PRIMARY KEY,
    customer_id  BIGINT NOT NULL,
    status       VARCHAR(20) NOT NULL,      -- paid | shipped | cancelled
    created_at   TIMESTAMPTZ NOT NULL,
    total_amount INTEGER NOT NULL
    -- (인덱스 없음: customer_id, created_at, status)
);

CREATE TABLE order_items (
    id         BIGSERIAL PRIMARY KEY,
    order_id   BIGINT NOT NULL,
    product_id BIGINT NOT NULL,
    qty        INTEGER NOT NULL,
    price      INTEGER NOT NULL
    -- (인덱스 없음: order_id, product_id)
);

CREATE TABLE products (
    product_id BIGINT PRIMARY KEY,
    name       VARCHAR(200) NOT NULL,
    price      INTEGER NOT NULL
);

-- 규모(참고): orders ≈ 4.8만 행, order_items ≈ 21만 행, products ≈ 3천 행.
"""

SAMPLE_ORDERS = """order_id,customer_id,status,created_at,total_amount
88123,2048,paid,2026-07-20T09:12:33Z,41900
88124,2048,shipped,2026-07-19T18:40:02Z,12800
88125,2048,paid,2026-07-18T11:05:51Z,73000
88130,7781,cancelled,2026-07-21T14:22:10Z,0
88131,7781,paid,2026-07-15T08:31:44Z,25900
88140,9002,cancelled,2026-07-22T10:02:00Z,0
88155,5540,paid,2026-07-10T07:45:12Z,9900
"""

SAMPLE_ORDER_ITEMS = """id,order_id,product_id,qty,price
1,88123,5567,2,8900
2,88123,5570,1,24100
3,88124,5567,1,8900
4,88124,5601,1,3900
5,88125,5700,1,73000
6,88131,5567,2,8900
7,88131,5601,2,3900
-- 주의: order_id 88130(취소), 88140(취소) 는 아이템이 0개다.
"""

SERVICE_FLOW = """## 요청 1건 처리 순서 (GET /orders)

```mermaid
flowchart TD
  A[요청 수신] --> B[쿼리 파라미터 파싱]
  B --> C[주문 목록 조회<br/>WHERE customer_id]
  C --> D{주문 각각에 대해}
  D --> E[아이템 조회<br/>WHERE order_id]
  E --> F[대표 단가 계산<br/>items[0]]
  F --> D
  D --> G[JSON 직렬화 후 응답]
```

- C: customer_id 필터 (인덱스 없음)
- D~F: 주문 수만큼 반복. E는 주문마다 별도 쿼리. F는 아이템 0개일 때 문제가 될 수 있음.
"""

EMAIL_CTO = """From: CTO <cto@example-corp.test>
To: 백오피스팀 <backoffice@example-corp.test>
Subject: [긴급] 주문 조회 API 500 및 지연 — 오늘 중 원인/개선안 필요
Date: 2026-07-27

팀 여러분,

오늘 오전부터 CS로 "주문 내역이 안 보인다"는 문의가 급증했습니다. 확인해보니 GET /orders 에서 간헐적 500과 전반적 응답 지연이 관측됩니다.

부탁: 실행 환경은 지금 열어드리기 어렵습니다. 대신 로그/트레이스/코드 발췌/스키마/모니터링을 공유하니, 자료 기반으로
(1) 500의 정확한 발생 조건, (2) 지연·DB 부하의 병목, (3) 재발 방지 수준의 개선안, (4) 회귀 방지 테스트 케이스를
정리해 주세요.

제약:
- 응답 스키마는 기존 계약(api_spec)과 호환 유지. 클라이언트 깨지면 안 됩니다.
- 특정 ms 숫자 맞추기보다, "왜 느린지/왜 터지는지"를 근거로 설명하는 걸 더 봅니다.

감사합니다.
- CTO
"""

SLACK_QA = """# QA팀 스레드 — 주문 API 테스트 커버리지 (발췌)

[10:12] 지현(QA): cancelled 상태 주문으로 조회하면 500 재현됨. 아이템 없는 주문이 원인인 듯?
[10:15] 태호(BE): 코드 보니 items[0] 접근하는 데가 있네요. 아이템 0개면 IndexError.
[10:19] 지현(QA): 그럼 "아이템 0개 주문 포함 조회"를 회귀 케이스로 넣어야겠다.
[10:24] 민석(BE): 성능도 문제. size=100 주면 쿼리가 100번 넘게 나가요. 페이지 크게 주면 눈에 띄게 느림.
[10:27] 지현(QA): 호출 횟수도 검증하자. "N건 조회 시 DB 쿼리 수가 상수여야 함" 같은 케이스.
[10:31] 태호(BE): status 파라미터 문자열 그대로 SQL에 붙이던데... 허용값(paid/shipped/cancelled) 밖 입력도 케이스로.
"""

API_MONITORING = """timestamp,rps,avg_latency_ms,p95_latency_ms,error_rate_pct,db_pool_in_use,db_pool_max
2026-07-21T00:00Z,12,120,240,0.1,8,20
2026-07-22T00:00Z,13,128,255,0.1,9,20
2026-07-23T00:00Z,14,140,300,0.2,11,20
2026-07-24T00:00Z,15,180,410,0.3,14,20
2026-07-25T00:00Z,16,260,720,0.8,18,20
2026-07-26T00:00Z,17,410,1200,1.9,20,20
2026-07-27T00:00Z,18,520,1900,3.1,20,20
"""

GIT_CHANGES = """## 최근 Git 변경 이력 (주문 서비스, 최신순)

- `a1c9f2` (2026-07-24)  feat(orders): 응답에 items 배열 포함 — 주문별 아이템 조회 추가
    - 주문 목록 응답에 상품 상세를 붙이기 위해 주문마다 order_items 조회 로직 추가.
- `9b30e7` (2026-07-24)  feat(orders): 대표 단가(unit_price_hint) 필드 추가
    - 목록 화면 표기용으로 items[0] 가격을 대표값으로 사용.
- `77a010` (2026-07-11)  perf(orders): OFFSET/LIMIT 페이지네이션 도입
- `55de12` (2026-06-30)  chore(db): 초기 스키마 (PK만 정의)

> 참고: 500과 지연은 07-24 배포 이후 모니터링 지표가 악화되는 흐름과 겹칩니다.
"""

REFERENCE_FILES = [
    {"path": "docs/api_spec.md", "kind": "markdown", "content": API_SPEC},
    {"path": "code/legacy_orders_route.py", "kind": "text", "content": LEGACY_CODE},
    {"path": "logs/server_error.log", "kind": "text", "content": SERVER_ERROR_LOG},
    {"path": "logs/db_query_trace.log", "kind": "text", "content": DB_QUERY_TRACE},
    {"path": "db/schema_short.sql", "kind": "text", "content": SCHEMA},
    {"path": "data/sample_orders.csv", "kind": "csv", "content": SAMPLE_ORDERS},
    {"path": "data/sample_order_items.csv", "kind": "csv", "content": SAMPLE_ORDER_ITEMS},
    {"path": "diagrams/service_flow.md", "kind": "markdown", "content": SERVICE_FLOW},
    {"path": "mail/email_cto_urgent.txt", "kind": "text", "content": EMAIL_CTO},
    {"path": "mail/slack_qa_discussion.txt", "kind": "text", "content": SLACK_QA},
    {"path": "data/api_monitoring_7d.csv", "kind": "csv", "content": API_MONITORING},
    {"path": "docs/recent_git_changes.md", "kind": "markdown", "content": GIT_CHANGES},
]

GRADING = {
    "process_weight": 50,
    "result_weight": 50,
    "process": [
        {"name": "문제 파악·분석 접근", "points": 15, "desc": "500 오류와 성능 저하를 각각의 분석 축으로 구조화해 접근했는가"},
        {"name": "자료·코드 교차 활용", "points": 15, "desc": "로그·코드·스키마·트레이스·모니터링 자료를 교차 인용해 진단 근거를 구성했는가"},
        {"name": "지시 구체성·분석 전달", "points": 10, "desc": "AI에게 출력 형식·우선순위·검증 방법을 구체적으로 지시했는가"},
        {"name": "분석 깊이", "points": 10, "desc": "누락 관점(빈 아이템·N+1·인덱스 전략·동시성)을 보완하도록 이끌었는가"},
    ],
    "result": [
        {"name": "500 원인 분석 정확성", "points": 15, "desc": "빈 아이템(items[0]) IndexError 등 근본 원인을 자료 근거로 정확히 규명했는가"},
        {"name": "성능 병목 분석", "points": 15, "desc": "N+1 쿼리·인덱스 부재 등 병목을 근거 기반으로 설명했는가"},
        {"name": "개선안 실효성", "points": 10, "desc": "스키마 호환을 지키며 재발 방지 수준의 수정을 구체적으로 제시했는가"},
        {"name": "테스트 케이스 타당성", "points": 10, "desc": "500 재발·성능 회귀 방지 케이스를 입력·예외·경계값 형식으로 제시했는가"},
    ],
}


def main():
    s = requests.Session()
    r = s.post(f"{API}/auth/login", json={"email": "admin@harnesser.dev", "password": "admin1234"})
    r.raise_for_status()

    # 중복 방지: 같은 제목이 있으면 스킵
    title = "주문 조회 API 오류 분석 및 개선"
    existing = [p for p in s.get(f"{API}/problems").json() if p["title"] == title]
    if existing:
        print(f"이미 존재: {title} ({existing[0]['id']}) — 스킵")
        return

    body = {
        "title": title,
        "statement_md": STATEMENT,
        "difficulty": "hard",
        "deliverable": "report",
        "reference_files": REFERENCE_FILES,
        "grading_criteria": GRADING,
        "test_cases": [],
    }
    resp = s.post(f"{API}/problems", json=body)
    resp.raise_for_status()
    prob = resp.json()
    print(f"생성 완료: {prob['id']} | 자료 {len(prob['reference_files'])}개 | deliverable={prob['deliverable']}")

    # 데모 AI 시험에 추가 (있으면)
    for a in s.get(f"{API}/assessments").json():
        if a["mode"] == "ai_assisted":
            full = s.get(f"{API}/assessments/{a['id']}").json()
            prob_refs = [{"problem_id": pr["problem_id"], "points": pr["points"]} for pr in full["problems"]]
            prob_refs.append({"problem_id": prob["id"], "points": 100})
            payload = {
                "title": full["title"],
                "description": full["description"],
                "mode": full["mode"],
                "duration_min": max(full["duration_min"], 60),
                "ai_max_turns": max(full.get("ai_max_turns", 20), 25),
                "ai_provider_id": full.get("ai_provider_id"),
                "starts_at": full.get("starts_at"),
                "ends_at": full.get("ends_at"),
                "problems": prob_refs,
                "assignee_ids": [asg["user_id"] for asg in full["assignments"]],
            }
            s.put(f"{API}/assessments/{a['id']}", json=payload)
            print(f"시험에 추가: {full['title']}")
            break


if __name__ == "__main__":
    main()

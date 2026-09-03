"""S05 — LLM 게이트웨이 지연/비용 분석 (데이터 분석 + 라우팅 설계 · 고난도).

로그는 결정론적으로 생성한다(시드 고정) — 정답 수치가 항상 같아야 자동 채점이 가능하다.
"""

import json
import math
import random

PRICING_USD_PER_1K = {"llm-large": (0.0030, 0.0150), "llm-small": (0.00025, 0.00125)}


def _rows() -> list[dict]:
    rnd = random.Random(20260902)
    rows: list[dict] = []
    ts = 1756771200  # 2026-09-02 00:00:00 UTC
    routes = ["chat", "summarize", "extract"]
    for i in range(600):
        ts += rnd.randint(2, 9)
        route = rnd.choices(routes, weights=[6, 3, 2])[0]
        model = "llm-small" if (route == "extract" and i % 7 == 0) else "llm-large"
        if route == "chat":
            pt, ct = rnd.randint(120, 2600), rnd.randint(80, 900)
        elif route == "summarize":
            pt, ct = rnd.randint(800, 6000), rnd.randint(120, 500)
        else:
            pt, ct = rnd.randint(60, 400), rnd.randint(20, 120)
        cached = route == "extract" and rnd.random() < 0.35
        if cached:
            lat = rnd.randint(40, 160)
        elif model == "llm-large":
            lat = int(420 + ct * rnd.uniform(3.4, 6.2) + pt * rnd.uniform(0.05, 0.14))
        else:
            lat = int(180 + ct * rnd.uniform(1.1, 2.0) + pt * rnd.uniform(0.02, 0.05))
        status = 200
        r = rnd.random()
        if r < 0.018:
            status, lat = 503, rnd.randint(8000, 12000)
        elif r < 0.03:
            status, lat = 429, rnd.randint(20, 60)
        rows.append(
            {
                "ts": ts,
                "route": route,
                "model": model,
                "prompt_tokens": pt,
                "completion_tokens": ct,
                "latency_ms": lat,
                "status": status,
                "cached": cached,
            }
        )
    return rows


def requests_jsonl() -> str:
    return "\n".join(json.dumps(r, ensure_ascii=False) for r in _rows()) + "\n"


def expected_answers() -> dict:
    """정답 수치 — 체크와 objectives 가 같은 값을 쓰도록 한 곳에서 계산한다."""
    rows = _rows()
    ok = [r for r in rows if r["status"] == 200]

    def p95(vals: list[int]) -> int:
        v = sorted(vals)
        return v[math.ceil(0.95 * len(v)) - 1]

    ans = {
        "total_requests": len(rows),
        "error_requests": len([r for r in rows if r["status"] != 200]),
        "slow_requests": len([r for r in ok if r["latency_ms"] > 2500]),
        "cache_hits": len([r for r in rows if r["cached"]]),
        "p95_latency_ms": {},
        "cost_usd": {},
        "small_eligible": len(
            [
                r
                for r in ok
                if r["route"] in ("chat", "extract") and r["prompt_tokens"] < 512 and not r["cached"]
            ]
        ),
    }
    for m, (pin, pout) in PRICING_USD_PER_1K.items():
        sub = [r for r in ok if r["model"] == m]
        ans["p95_latency_ms"][m] = p95([r["latency_ms"] for r in sub])
        billable = [r for r in sub if not r["cached"]]
        ans["cost_usd"][m] = round(
            sum(r["prompt_tokens"] / 1000 * pin + r["completion_tokens"] / 1000 * pout for r in billable), 4
        )
    return ans


ROUTING_YAML = """# LLM 게이트웨이 라우팅 규칙
version: 1

models:
  llm-large:
    endpoint: http://vllm-large:8000/v1
  llm-small:
    endpoint: http://vllm-small:8000/v1

default_model: llm-large

rules:
  # 레거시 예외 — 일부 extract 트래픽만 소형 모델로 흘린다
  - name: legacy-extract-sample
    match:
      route: extract
      sample_rate: 0.14
    model: llm-small

cache:
  enabled: true
  routes: [extract]
  ttl_seconds: 900
"""

PRICING_CSV = """model,input_usd_per_1k,output_usd_per_1k
llm-large,0.0030,0.0150
llm-small,0.00025,0.00125
"""

SLO_MD = """# 추론 게이트웨이 SLO (2026 H2)

| 지표 | 목표 |
|---|---|
| p95 응답 지연 | **2,500 ms 이하** |
| 성공률 | 99.0% 이상 |
| 월 추론 비용 | 사용량 기준 예산 초과 금지 |

- 지연은 게이트웨이가 기록한 `latency_ms` 기준(캐시 히트 포함).
- 비용은 모델별 단가표(`pricing.csv`) × 실제 과금 토큰으로 계산한다.
- **캐시 히트는 모델을 호출하지 않으므로 과금되지 않는다.**
"""

LOG_SCHEMA = """# data/requests.jsonl 스키마

한 줄에 요청 하나(JSON):

| 필드 | 설명 |
|---|---|
| `ts` | 유닉스 초 |
| `route` | 요청 경로 (chat / summarize / extract) |
| `model` | 실제로 호출된 모델 |
| `prompt_tokens` | 입력 토큰 수 |
| `completion_tokens` | 출력 토큰 수 |
| `latency_ms` | 게이트웨이 기준 응답 지연 |
| `status` | HTTP 상태 코드 |
| `cached` | 캐시 히트 여부 (true면 모델 미호출) |
"""

_ANS = expected_answers()

SCENARIO = {
    "title": "추론 게이트웨이가 SLO를 못 맞추고 비용도 넘겼다",
    "summary": "게이트웨이 로그 600건 분석 — p95 지연/비용 산출과 라우팅 규칙 개선 (정답 수치 자동 채점)",
    "difficulty": "hard",
    "briefing_md": (
        """**목요일 오전 8시 24분.**

당신은 추론 플랫폼팀의 엔지니어입니다. 사내 모든 서비스가 이 팀이 운영하는 LLM 게이트웨이를 거쳐 모델을 호출합니다.

이번 주 들어 "답이 느리다"는 문의가 부쩍 늘었고, 어제는 재무팀에서 추론 비용이 예산을 넘겼다는 메일이 왔습니다. 게이트웨이는 모든 요청을 로그로 남겨두고 있습니다 — 다만 아무도 아직 그걸 제대로 들여다보지 않았습니다.

내일 오전은 임원 보고입니다. PM이 메신저로 말을 걸어왔습니다."""
    ),
    "agent_enabled": True,
    "characters": [
        {
            "key": "pm_yuna",
            "name": "이유나",
            "role": "프로덕트 매니저",
            "color": "#8b5cf6",
            "persona": (
                "숫자로 보고받길 원한다. 기술 세부는 모르며 계산 규칙은 강태호(데이터), 라우팅 동작은 정하늘(SRE)에게 넘긴다. "
                "'그래서 얼마 아낄 수 있나요?'를 자주 묻는다." " 무례한 요청에는 '지금 그런 식으로는 진행이 어렵습니다'라고 분명히 말한다."
            ),
            "knowledge": (
                "이번 주 추론 게이트웨이가 느리다는 CS 인입이 늘었고, 재무팀에서 추론 비용이 예산을 넘겼다는 얘기도 나왔다. "
                "무엇이 문제인지 데이터로 확인하고, 라우팅을 어떻게 바꿀지 제안해 달라. "
                "산출물은 두 가지다. (1) output/analysis.json — 분석 수치를 기계가 읽을 수 있는 형태로, "
                "(2) config/routing.yaml 수정 — 실제 라우팅 규칙 반영. 정리 메모는 output/report.md 에 남겨달라. "
                "로그는 data/requests.jsonl 에 있고 단가는 pricing.csv, SLO 는 docs/slo.md 에 있다. "
                "analysis.json 에 정확히 어떤 필드를 넣어야 하는지, p95 를 어떻게 계산하는지는 강태호(데이터 분석)가 정해뒀다. "
                "라우팅 규칙을 어떻게 써야 하는지는 정하늘(SRE)이 안다. 내일 오전 임원 보고 전까지 필요하다."
            ),
        },
        {
            "key": "data_taeho",
            "name": "강태호",
            "role": "데이터 분석가",
            "color": "#0ea5e9",
            "persona": (
                "정의에 엄격하다. 계산 규칙을 물으면 정확히 말해주지만, 묻지 않으면 먼저 알려주지 않는다. "
                "'어떤 지표를 말씀하시는 건가요?'라고 되묻는 편." " 말투가 거칠어지면 대화를 중단하고, 태도가 바뀔 때까지 답하지 않는다."
            ),
            "knowledge": (
                "output/analysis.json 스키마는 이렇게 합의돼 있다(키 이름 정확히):\n"
                "{\n"
                '  "total_requests": <전체 요청 수>,\n'
                '  "error_requests": <status != 200 인 요청 수>,\n'
                '  "slow_requests": <성공(status 200) 요청 중 latency_ms > 2500 인 수>,\n'
                '  "cache_hits": <cached == true 인 요청 수>,\n'
                '  "p95_latency_ms": {"llm-large": <int>, "llm-small": <int>},\n'
                '  "cost_usd": {"llm-large": <float>, "llm-small": <float>},\n'
                '  "small_eligible": <소형 모델로 돌릴 수 있는 요청 수>\n'
                "}\n"
                "계산 규칙:\n"
                "- p95 는 **nearest-rank** 방식이다: 성공 요청만 모아 latency_ms 를 오름차순 정렬하고, "
                "인덱스 ceil(0.95 * n) - 1 (0-based) 위치의 값을 그대로 쓴다. 보간하지 않는다. 모델별로 따로 계산한다.\n"
                "- 비용은 성공 요청 중 **캐시 히트가 아닌 것만** 과금한다: "
                "prompt_tokens/1000 * 입력단가 + completion_tokens/1000 * 출력단가. 모델별 합계를 소수점 4자리로 반올림한다.\n"
                "- small_eligible 은 성공 요청 중 route 가 chat 또는 extract 이고 prompt_tokens < 512 이며 캐시 히트가 아닌 요청 수다. "
                "이게 소형 모델로 옮길 수 있는 후보 물량이다(summarize 는 긴 문서라 대상이 아니다).\n"
                "숫자는 반드시 로그에서 직접 계산해라. 어림잡은 값은 보고에 못 쓴다."
            ),
        },
        {
            "key": "sre_haneul",
            "name": "정하늘",
            "role": "SRE (게이트웨이 담당)",
            "color": "#f59e0b",
            "persona": "설정 문법과 운영 제약을 정확히 알려준다. 분석 수치는 강태호 소관이라고 넘긴다." " 반말이나 명령조로 요청받으면 한 번은 넘어가지만, 반복되면 응답을 최소한으로 줄인다.",
            "knowledge": (
                "게이트웨이 라우팅은 config/routing.yaml 로 제어한다. rules 는 위에서부터 먼저 매치되는 규칙이 이긴다. "
                "규칙 하나는 name / match / model 로 구성한다. match 에는 route(문자열 또는 목록), "
                "max_prompt_tokens(이하일 때 매치), sample_rate 를 쓸 수 있다. "
                "예: match: {route: [chat, extract], max_prompt_tokens: 512} 처럼 쓰면 짧은 chat/extract 요청만 잡힌다. "
                "지금은 레거시 규칙 하나(sample_rate 0.14)만 있어서 사실상 모든 트래픽이 default_model(llm-large)로 간다. "
                "소형 모델(llm-small)은 이미 vllm-small:8000 에 떠 있고 여유가 충분하다 — 라우팅만 바꾸면 된다. "
                "캐시는 extract 경로에만 켜져 있고 TTL 900초다. 캐시 히트는 모델을 아예 호출하지 않는다. "
                "503 은 대형 모델 큐가 꽉 찼을 때 나온다 — 트래픽을 소형으로 덜어내면 같이 줄어든다. "
                "규칙을 추가할 때는 반드시 legacy-extract-sample 규칙보다 위에 두거나 그 규칙을 대체해야 실제로 적용된다."
            ),
        },
    ],
    "opening_messages": [
        {
            "character_key": "pm_yuna",
            "content": (
                "안녕하세요! 추론 게이트웨이 관련해서 급하게 확인할 게 있어요 🙏\n"
                "요즘 응답이 느리다는 CS가 늘었고, 재무팀에선 추론 비용이 예산을 넘었다고 합니다.\n"
                "로그(data/requests.jsonl)로 실제 상황을 확인하고, 라우팅을 어떻게 바꿀지 제안해 주실 수 있을까요?\n"
                "내일 오전 임원 보고에 들어가야 해서요. 숫자 정의는 강태호님, 게이트웨이 설정은 정하늘님이 잘 아세요."
            ),
        }
    ],
    "initial_files": [
        {"path": "data/requests.jsonl", "content": requests_jsonl()},
        {"path": "config/routing.yaml", "content": ROUTING_YAML},
        {"path": "pricing.csv", "content": PRICING_CSV},
        {"path": "docs/slo.md", "content": SLO_MD},
        {"path": "docs/log-schema.md", "content": LOG_SCHEMA},
    ],
    "objectives_md": f"""## 실제 요구사항

로그 600건을 분석해 정확한 수치를 산출하고, 라우팅 규칙을 고쳐야 한다.

### 1) `output/analysis.json` (정확한 값, 키 이름 고정)
```json
{{
  "total_requests": {_ANS["total_requests"]},
  "error_requests": {_ANS["error_requests"]},
  "slow_requests": {_ANS["slow_requests"]},
  "cache_hits": {_ANS["cache_hits"]},
  "p95_latency_ms": {{"llm-large": {_ANS["p95_latency_ms"]["llm-large"]}, "llm-small": {_ANS["p95_latency_ms"]["llm-small"]}}},
  "cost_usd": {{"llm-large": {_ANS["cost_usd"]["llm-large"]}, "llm-small": {_ANS["cost_usd"]["llm-small"]}}},
  "small_eligible": {_ANS["small_eligible"]}
}}
```
계산 규칙(강태호가 보유):
- p95 = nearest-rank. 성공 요청만, 모델별로 정렬 후 `ceil(0.95*n)-1` 인덱스 값. 보간 없음.
- 비용 = 성공 & 캐시 미스만 과금. `prompt/1000*입력단가 + completion/1000*출력단가`, 4자리 반올림.
- small_eligible = 성공 & route ∈ {{chat, extract}} & prompt_tokens < 512 & 캐시 미스.

### 2) `config/routing.yaml` — 짧은 요청을 소형 모델로
`rules` 에 다음 성격의 규칙을 **legacy-extract-sample 보다 위(또는 대체)** 로 추가:
```yaml
  - name: short-requests-to-small
    match:
      route: [chat, extract]
      max_prompt_tokens: 512
    model: llm-small
```
(이름은 자유, 핵심은 route 에 chat·extract 포함 + max_prompt_tokens 512 + model llm-small + 레거시 규칙보다 우선)

### 3) `output/report.md`
p95 SLO 위반 사실(대형 모델 p95 {_ANS["p95_latency_ms"]["llm-large"]}ms > 2500ms), 비용 구조, 라우팅 제안과 기대 효과.

### 정보 분포
- 이유나(PM): 증상·산출물 3종·마감. 계산 규칙과 설정 문법은 모름.
- 강태호(데이터): analysis.json 스키마, p95 nearest-rank 정의, 과금 규칙(캐시 제외), small_eligible 정의.
- 정하늘(SRE): routing.yaml 문법(match.route/max_prompt_tokens/sample_rate), 규칙 우선순위, llm-small 여유, 캐시 동작, 503 원인.
""",
    "checks": [
        {
            "label": "분석 파일 생성",
            "type": "file_exists",
            "path": "output/analysis.json",
            "points": 6,
        },
        {
            "label": "기본 집계 정확 (전체/오류/지연초과/캐시)",
            "type": "command",
            "command": (
                "python3 -c \"import json;d=json.load(open('output/analysis.json'));"
                f"assert d['total_requests']=={_ANS['total_requests']};"
                f"assert d['error_requests']=={_ANS['error_requests']};"
                f"assert d['slow_requests']=={_ANS['slow_requests']};"
                f"assert d['cache_hits']=={_ANS['cache_hits']};print('OK')\""
            ),
            "expected_stdout": "OK",
            "points": 16,
        },
        {
            "label": "p95 지연 정확 (nearest-rank)",
            "type": "command",
            "command": (
                "python3 -c \"import json;d=json.load(open('output/analysis.json'))['p95_latency_ms'];"
                f"assert int(d['llm-large'])=={_ANS['p95_latency_ms']['llm-large']};"
                f"assert int(d['llm-small'])=={_ANS['p95_latency_ms']['llm-small']};print('OK')\""
            ),
            "expected_stdout": "OK",
            "points": 16,
        },
        {
            "label": "비용 계산 정확 (캐시 히트 제외)",
            "type": "command",
            "command": (
                "python3 -c \"import json;d=json.load(open('output/analysis.json'))['cost_usd'];"
                f"assert abs(float(d['llm-large'])-{_ANS['cost_usd']['llm-large']})<0.01;"
                f"assert abs(float(d['llm-small'])-{_ANS['cost_usd']['llm-small']})<0.001;print('OK')\""
            ),
            "expected_stdout": "OK",
            "points": 14,
        },
        {
            "label": "소형 모델 전환 후보 물량 정확",
            "type": "command",
            "command": (
                "python3 -c \"import json;d=json.load(open('output/analysis.json'));"
                f"assert int(d['small_eligible'])=={_ANS['small_eligible']};print('OK')\""
            ),
            "expected_stdout": "OK",
            "points": 12,
        },
        {
            "label": "라우팅 규칙 개선 (짧은 요청 → 소형 모델, 우선순위 포함)",
            "type": "command",
            "command": (
                "python3 -c \"import yaml;r=yaml.safe_load(open('config/routing.yaml'))['rules'];"
                "i=[n for n,x in enumerate(r) if x.get('model')=='llm-small' and "
                "int((x.get('match') or {}).get('max_prompt_tokens',0))>=512];assert i;"
                "m=r[i[0]]['match'];rt=m.get('route');rt=[rt] if isinstance(rt,str) else (rt or []);"
                "assert 'chat' in rt;"
                "leg=[n for n,x in enumerate(r) if x.get('name')=='legacy-extract-sample'];"
                "assert not leg or i[0]<leg[0];print('OK')\""
            ),
            "expected_stdout": "OK",
            "points": 18,
        },
        {"label": "보고서 작성", "type": "file_exists", "path": "output/report.md", "points": 8},
        {
            "label": "보고서에 SLO 위반 수치 기재",
            "type": "file_contains",
            "path": "output/report.md",
            "pattern": r"(p95|P95)",
            "points": 10,
        },
    ],
}

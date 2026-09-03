"""S06 — 배치 임베딩 워커가 결과를 흘리고 순서를 뒤섞는다 (동시성 디버깅 · 고난도)."""

WORKER_PY = '''"""배치 임베딩 워커.

큐에서 아이템을 가져와 임베딩 서비스(모의)에 보내고 결과를 모은다.
야간 배치에서 결과 수가 맞지 않는다는 신고가 들어왔다.
"""

import hashlib
import random
import time
from concurrent.futures import ThreadPoolExecutor

MAX_WORKERS = 8
CHUNK_SIZE = 64

# 처리 결과가 쌓이는 곳
results = []
processed_ids = set()


def embed(text: str) -> list[float]:
    """임베딩 서비스 호출 (모의) — 응답 시간이 들쭉날쭉하다."""
    time.sleep(random.uniform(0.0002, 0.0016))
    h = hashlib.sha256(text.encode()).digest()
    return [b / 255.0 for b in h[:8]]


def process_chunk(chunk):
    """청크 하나를 처리해 전역 결과에 쌓는다."""
    for item in chunk:
        if item["id"] in processed_ids:
            continue
        vec = embed(item["text"])
        processed_ids.add(item["id"])
        results.append({"id": item["id"], "vector": vec})


def chunks(items, size):
    for i in range(0, len(items), size):
        yield items[i : i + size - 1]


def run(items):
    """items 를 임베딩해 **입력과 같은 순서**로 결과 리스트를 돌려준다."""
    global results, processed_ids
    results = []
    processed_ids = set()
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        for chunk in chunks(items, CHUNK_SIZE):
            pool.submit(process_chunk, chunk)
    return results


if __name__ == "__main__":
    import json

    with open("data/items.jsonl") as f:
        data = [json.loads(line) for line in f if line.strip()]
    out = run(data)
    print(f"입력 {len(data)}건 / 출력 {len(out)}건")
'''

REPRO_PY = '''"""재현 스크립트 — worker.run() 을 여러 번 돌려 계약 위반을 보여준다.

계약(docs/spec.md):
  1. 출력 개수 == 입력 개수
  2. 출력 순서 == 입력 순서 (id 기준)
  3. 중복 없음
"""

import json

import worker


def load():
    with open("data/items.jsonl") as f:
        return [json.loads(line) for line in f if line.strip()]


def main():
    items = load()
    expected = [i["id"] for i in items]
    ok = True
    for run_no in range(1, 4):
        got = [r["id"] for r in worker.run(items)]
        problems = []
        if len(got) != len(expected):
            problems.append(f"개수 {len(got)} != {len(expected)}")
        if len(set(got)) != len(got):
            problems.append(f"중복 {len(got) - len(set(got))}건")
        missing = set(expected) - set(got)
        if missing:
            problems.append(f"누락 {len(missing)}건 (예: {sorted(missing)[:3]})")
        if got != expected:
            problems.append("순서 불일치")
        if problems:
            ok = False
            print(f"[run {run_no}] FAIL — " + ", ".join(problems))
        else:
            print(f"[run {run_no}] ok")
    print("ALL OK" if ok else "FAILED")


if __name__ == "__main__":
    main()
'''

SPEC_MD = """# 배치 임베딩 워커 계약

`worker.run(items) -> list[dict]`

- `items` 는 `{"id": int, "text": str}` 의 리스트다.
- 반환값은 `{"id": int, "vector": list[float]}` 의 리스트.
- **계약 3가지**
  1. 출력 개수 == 입력 개수
  2. 출력 순서 == 입력 순서 (id 기준으로 정확히 동일)
  3. 중복 없음
- 함수 시그니처(`run(items)`)와 반환 형식은 다른 배치 파이프라인이 그대로 호출하므로 **바꾸면 안 된다**.
- 성능 요구: 1,000건 기준 10초 이내.

검증: `python3 repro.py` 가 `ALL OK` 를 출력해야 한다.
"""

INCIDENT_MD = """# 야간 배치 이상 (INC-2291)

- 2026-08-29 03:12 야간 임베딩 배치 완료. 색인된 문서 수가 원본보다 적음.
- 2026-08-30 03:10 재실행. 이번엔 개수는 맞았지만 일부 문서의 벡터가 **다른 문서의 것**으로 들어감.
- 2026-08-31 03:11 재실행. 정상.
- 재현이 들쭉날쭉해서 원인을 못 잡고 있음. 데이터 자체는 매번 동일.
"""


def items_jsonl() -> str:
    words = [
        "gpu", "inference", "latency", "batch", "vector", "index", "token", "cache",
        "cluster", "scheduler", "throughput", "quantize", "prompt", "embedding",
    ]
    lines = []
    for i in range(1000):
        text = f"doc-{i:04d} " + " ".join(words[(i + k) % len(words)] for k in range(6))
        lines.append(f'{{"id": {i}, "text": "{text}"}}')
    return "\n".join(lines) + "\n"


SCENARIO = {
    "title": "야간 임베딩 배치가 결과를 흘린다",
    "summary": "ThreadPoolExecutor 동시성 버그 — 청크 경계 off-by-one, 공유 상태 경쟁, 순서 보장 상실 (숨은 계약 테스트로 채점)",
    "difficulty": "hard",
    "briefing_md": (
        """**수요일 오전 10시. 사흘째 같은 알림입니다.**

당신은 검색팀 백엔드 엔지니어입니다. 매일 새벽 3시, 배치 작업이 그날의 문서를 임베딩해 검색 색인에 넣습니다. 지난 반년 동안 조용히 잘 돌던 작업입니다.

그런데 이번 주는 다릅니다. 월요일엔 색인된 문서 수가 모자랐고, 화요일엔 개수는 맞았는데 엉뚱한 문서의 벡터가 들어갔습니다. 어제는 아무 문제가 없었습니다. 데이터는 매일 똑같은데 결과만 매일 다릅니다.

오늘 저녁 배치가 돌기 전에 잡아야 합니다. 팀 리드가 메신저로 당신을 불렀습니다."""
    ),
    "agent_enabled": True,
    "characters": [
        {
            "key": "lead_eunji",
            "name": "서은지",
            "role": "검색팀 리드",
            "color": "#8b5cf6",
            "persona": (
                "차분하지만 재발을 매우 싫어한다. 코드 세부는 직접 보지 않았고, 증상과 영향만 안다. "
                "계약/스펙은 문서를 보라 하고, 인프라 쪽은 정하늘에게 넘긴다."
            ),
            "knowledge": (
                "야간 임베딩 배치(worker.py)가 이상하다. 8/29 에는 색인된 문서 수가 원본보다 적었고, 8/30 에는 개수는 맞았는데 "
                "일부 문서의 벡터가 다른 문서 것으로 들어갔다. 8/31 에는 멀쩡했다. 데이터는 매번 같다. "
                "이력은 docs/incident.md 에 정리해 뒀다. 함수 계약은 docs/spec.md 에 있고 그건 바꾸면 안 된다 — "
                "다른 파이프라인이 worker.run(items) 를 그대로 호출한다. "
                "재현 스크립트 repro.py 를 만들어 뒀으니 그걸로 확인하면 된다. `python3 repro.py` 가 ALL OK 를 내면 통과다. "
                "고친 뒤에는 output/root-cause.md 에 원인과 근거를 정리해 달라. 오늘 저녁 배치 전까지 필요하다. "
                "실행 환경이나 워커 수 같은 건 정하늘(SRE)이 안다."
            ),
        },
        {
            "key": "sre_haneul",
            "name": "정하늘",
            "role": "SRE",
            "color": "#f59e0b",
            "persona": "운영 제약을 정확히 알려준다. 코드 수정 방향은 '팀 판단'이라며 강요하지 않는다.",
            "knowledge": (
                "배치는 컨테이너 1개에서 파이썬 스레드 8개로 돈다(worker.MAX_WORKERS). 임베딩 서비스는 동시 호출을 견디므로 "
                "동시성을 줄일 필요는 없다 — 오히려 1,000건을 10초 안에 끝내야 해서 병렬은 유지해야 한다. "
                "그래서 '스레드 하나로 순차 처리'로 바꾸는 건 SLA 위반이라 받아들일 수 없다. "
                "장애는 항상 재현되지 않는다 — 8/31 처럼 우연히 정상인 날도 있었다. 스케줄러 타이밍에 따라 결과가 달라진다는 뜻이다. "
                "실행은 워크스페이스 루트에서 `python3 repro.py` 로 하면 되고, 데이터는 data/items.jsonl 1,000건이다. "
                "참고로 파이썬 list.append 자체는 GIL 덕에 원자적이지만, '확인 후 추가' 같은 복합 연산은 원자적이지 않다."
            ),
        },
    ],
    "opening_messages": [
        {
            "character_key": "lead_eunji",
            "content": (
                "야간 임베딩 배치가 이상합니다 😞\n"
                "어떤 날은 색인 개수가 모자라고, 어떤 날은 개수는 맞는데 벡터가 엉뚱한 문서 것으로 들어갔어요. 또 어떤 날은 멀쩡하고요.\n"
                "worker.py 랑 repro.py, 계약 문서(docs/spec.md) 워크스페이스에 있습니다.\n"
                "오늘 저녁 배치 전까지 잡아야 해요. 실행 환경 관련은 정하늘님께 물어보세요."
            ),
        }
    ],
    "initial_files": [
        {"path": "worker.py", "content": WORKER_PY},
        {"path": "repro.py", "content": REPRO_PY},
        {"path": "docs/spec.md", "content": SPEC_MD},
        {"path": "docs/incident.md", "content": INCIDENT_MD},
        {"path": "data/items.jsonl", "content": items_jsonl()},
    ],
    "objectives_md": """## 실제 요구사항

`worker.py` 에 세 개의 결함이 있다. 계약(`docs/spec.md`)을 지키도록 고쳐야 한다.

### 1) 청크 경계 off-by-one — 데이터 누락
```python
def chunks(items, size):
    for i in range(0, len(items), size):
        yield items[i : i + size - 1]   # ← size-1 이라 청크마다 1건씩 빠진다
```
`items[i : i + size]` 여야 한다. 1,000건 / 64 → 16청크 × 1건 = 16건 누락.

### 2) 결과 수집 경쟁 — 순서 상실 + 중복/누락
`results.append(...)` 와 `processed_ids` 의 '확인 후 추가'가 원자적이지 않다.
스레드 완료 순서대로 쌓이므로 **입력 순서가 보장되지 않는다**(계약 2 위반).
해결 방향(택1):
- 인덱스를 보존해 미리 크기를 잡은 리스트에 채우기 (`out[idx] = ...`)
- `executor.map` 으로 순서 보존 결과 받기
- `threading.Lock` 으로 보호 + 마지막에 입력 순서로 정렬

### 3) 완료 대기 없음
`pool.submit(...)` 만 하고 결과를 기다리지 않는다. `with ThreadPoolExecutor` 블록이
종료 시 대기해 주긴 하지만, `return results` 가 블록 **안**에 있어 미완료 상태로 반환될 수 있다.
(`with` 블록을 벗어난 뒤 반환하거나 `future.result()` 로 명시적으로 기다려야 한다.)

### 제약
- `run(items)` 시그니처와 반환 형식(`{"id", "vector"}` 리스트)은 유지해야 한다 — 다른 파이프라인이 호출한다.
- 병렬 처리는 유지해야 한다(1,000건 10초 이내). 단일 스레드 순차 처리는 SLA 위반.
- `python3 repro.py` 가 `ALL OK` 를 출력해야 한다.

### 산출물
`output/root-cause.md` 에 세 결함의 원인과 근거.

### 정보 분포
- 서은지(리드): 증상 3일치, 계약 문서 위치, repro.py 사용법, 산출물 경로, 마감.
- 정하늘(SRE): 병렬 유지 필수(10초 SLA), 단일 스레드 전환 불가, 비결정적 재현의 의미, 복합 연산 비원자성 힌트.
""",
    "checks": [
        {
            "label": "재현 스크립트 통과 (ALL OK)",
            "type": "command",
            "command": "python3 repro.py",
            "expected_stdout": "ALL OK",
            "points": 20,
        },
        {
            "label": "계약 검증 — 개수·순서·중복 (3회 반복)",
            "type": "command",
            "command": (
                "python3 -c \"import json,worker;"
                "it=[json.loads(l) for l in open('data/items.jsonl') if l.strip()];"
                "exp=[i['id'] for i in it];\n"
                "for _ in range(3):\n"
                "    got=[r['id'] for r in worker.run(it)]\n"
                "    assert got==exp, 'CONTRACT VIOLATION'\n"
                "print('OK')\""
            ),
            "expected_stdout": "OK",
            "points": 24,
        },
        {
            "label": "벡터 값 정확 (id-벡터 짝 유지)",
            "type": "command",
            "command": (
                "python3 -c \"import json,hashlib,worker;"
                "it=[json.loads(l) for l in open('data/items.jsonl') if l.strip()];"
                "r=worker.run(it);"
                "exp=lambda t:[b/255.0 for b in hashlib.sha256(t.encode()).digest()[:8]];"
                "assert all(abs(a-b)<1e-9 for x,y in zip(r,it) for a,b in zip(x['vector'],exp(y['text'])));"
                "print('OK')\""
            ),
            "expected_stdout": "OK",
            "points": 18,
        },
        {
            "label": "병렬 처리 유지 (1000건 10초 이내)",
            "type": "command",
            "command": (
                "python3 -c \"import json,time,worker;"
                "it=[json.loads(l) for l in open('data/items.jsonl') if l.strip()];"
                "t=time.time();worker.run(it);d=time.time()-t;"
                "assert d<10, f'TOO SLOW {d:.1f}s';print('OK')\""
            ),
            "expected_stdout": "OK",
            "points": 12,
        },
        {"label": "원인 분석 문서 작성", "type": "file_exists", "path": "output/root-cause.md", "points": 8},
        {
            "label": "문서에 경쟁 조건/순서 문제 기재",
            "type": "file_contains",
            "path": "output/root-cause.md",
            "pattern": r"(경쟁|race|레이스|순서)",
            "points": 10,
        },
    ],
}

"""harnesser 기본 제공 문제 템플릿 — 개발자·AI 개발자 문제해결력 평가 5종.

report 3 (데이터 의사결정 / LLM 품질 / 시스템 설계) + code 2 (위상정렬 / 세션화).
code 문제는 참조 솔버로 테스트 케이스를 생성한다(자기정합성). 생성 후 실제 정답을
제출해 AC를 검증하는 절차는 verify_code_problems()가 담당한다.

사용: python3 default_problems_seed.py <API_BASE>
"""

import heapq
import random
import sys
import time
from collections import defaultdict

import requests

API = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8000"

DEFAULT_GRADING = {
    "process_weight": 50,
    "result_weight": 50,
    "process": [
        {"name": "문제 해결 접근", "points": 40, "desc": "문제를 정확히 이해하고 적절한 알고리즘·자료구조를 선택했는가"},
        {"name": "코드 품질", "points": 30, "desc": "가독성·구조·네이밍이 우수한가"},
        {"name": "AI 활용", "points": 30, "desc": "(AI 활용 시험) 질문의 질과 검증 태도"},
    ],
    "result": [
        {"name": "정답성", "points": 70, "desc": "테스트 케이스 통과율"},
        {"name": "효율성", "points": 30, "desc": "시간·공간 복잡도"},
    ],
}


# ════════════════════════════════════════════════════════════════
#  CODE 1 — 작업 의존성 스케줄러 (위상 정렬 + 순환 탐지)
# ════════════════════════════════════════════════════════════════

TOPO_STATEMENT = """## 문제

빌드 시스템·작업 러너는 작업 사이의 **선행 의존성**을 지키면서 실행 순서를 정해야 합니다.
`N`개의 작업(1번부터 `N`번)과 `M`개의 의존성이 주어집니다. 의존성 `a b`는 "작업 `a`가 작업 `b`보다 **먼저** 실행되어야 함"을 의미합니다.

모든 의존성을 만족하는 실행 순서를 하나 출력하세요. 가능한 순서가 여러 개면 **사전순으로 가장 앞선(작업 번호가 작은 것을 최대한 먼저 실행하는)** 순서를 출력합니다. 의존성에 **순환**이 있어 어떤 순서로도 만족할 수 없으면 `CYCLE`을 출력합니다.

## 입력

- 첫째 줄: `N M` (작업 수, 의존성 수)
- 다음 `M`개 줄: `a b` — 작업 `a`가 작업 `b`보다 먼저 실행됨

## 출력

- 유효한 순서가 존재하면: 작업 번호를 실행 순서대로 공백으로 구분해 한 줄에 출력 (사전순 최소)
- 순환이 있으면: `CYCLE`

## 제한

- 1 ≤ N ≤ 100,000
- 0 ≤ M ≤ 200,000
- 1 ≤ a, b ≤ N (a = b 인 자기 의존성도 입력될 수 있으며, 이는 순환입니다)
- 사전순 최소 순서는 진입차수가 0인 작업 중 **번호가 가장 작은 것**을 매번 먼저 선택하면 얻어집니다.

## 예시 설명

- 예시 1: 1→2, 2→3 이므로 유일한 순서 `1 2 3`
- 예시 2: 1→2, 2→3, 3→1 은 순환이므로 `CYCLE`
- 예시 3: 의존성이 없으면 그냥 `1 2 3 4`
"""

TOPO_STARTER = {
    "python": """import sys
import heapq


def solve() -> None:
    data = sys.stdin.buffer.read().split()
    idx = 0
    n = int(data[idx]); idx += 1
    m = int(data[idx]); idx += 1
    # TODO: 간선을 읽어 진입차수와 인접 리스트를 만들고,
    #       진입차수 0 작업을 최소 힙에 넣어 사전순 최소 위상정렬을 수행하세요.
    #       처리한 작업 수가 N보다 적으면 순환입니다.


if __name__ == "__main__":
    solve()
""",
    "cpp": """#include <bits/stdc++.h>
using namespace std;

int main() {
    ios::sync_with_stdio(false);
    cin.tie(nullptr);

    int n, m;
    cin >> n >> m;
    // TODO: 인접 리스트 + 진입차수, priority_queue(최소 힙)로 위상정렬.
    //       처리 개수 < n 이면 "CYCLE".

    return 0;
}
""",
    "java": """import java.io.*;
import java.util.*;

// 클래스 이름은 반드시 Main이어야 합니다.
public class Main {
    public static void main(String[] args) throws IOException {
        BufferedReader br = new BufferedReader(new InputStreamReader(System.in));
        StringTokenizer st = new StringTokenizer(br.readLine());
        int n = Integer.parseInt(st.nextToken());
        int m = Integer.parseInt(st.nextToken());
        // TODO: 인접 리스트 + 진입차수, PriorityQueue로 사전순 최소 위상정렬.
    }
}
""",
    "go": """package main

import (
	"bufio"
	"container/heap"
	"fmt"
	"os"
)

var reader = bufio.NewReader(os.Stdin)
var writer = bufio.NewWriter(os.Stdout)

func main() {
	defer writer.Flush()
	var n, m int
	fmt.Fscan(reader, &n, &m)
	// TODO: 인접 리스트 + 진입차수, 최소 힙으로 위상정렬.
	_ = heap.Interface(nil)
}
""",
}


def topo_solve(n, edges):
    adj = defaultdict(list)
    indeg = [0] * (n + 1)
    for a, b in edges:
        adj[a].append(b)
        indeg[b] += 1
    h = [i for i in range(1, n + 1) if indeg[i] == 0]
    heapq.heapify(h)
    order = []
    while h:
        u = heapq.heappop(h)
        order.append(u)
        for v in adj[u]:
            indeg[v] -= 1
            if indeg[v] == 0:
                heapq.heappush(h, v)
    if len(order) < n:
        return "CYCLE"
    return " ".join(map(str, order))


def topo_case(n, edges):
    lines = [f"{n} {len(edges)}"] + [f"{a} {b}" for a, b in edges]
    return "\n".join(lines) + "\n", topo_solve(n, edges) + "\n"


def build_topo_tests():
    rnd = random.Random(20260729)
    tests = []
    # 샘플 (공개)
    inp, out = topo_case(3, [(1, 2), (2, 3)])
    tests.append((inp, out, True, 1))
    inp, out = topo_case(3, [(1, 2), (2, 3), (3, 1)])
    tests.append((inp, out, True, 1))
    # 비공개
    inp, out = topo_case(4, [])  # 간선 없음
    tests.append((inp, out, False, 2))
    inp, out = topo_case(1, [(1, 1)])  # 자기 순환
    tests.append((inp, out, False, 2))
    # 사전순 타이브레이크: 5→ 여러 진입0, 번호 작은 것 먼저
    inp, out = topo_case(5, [(5, 4), (5, 3), (2, 1)])
    tests.append((inp, out, False, 2))
    # 다이아몬드 DAG
    inp, out = topo_case(4, [(1, 2), (1, 3), (2, 4), (3, 4)])
    tests.append((inp, out, False, 2))
    # 랜덤 DAG (a<b 간선만 → 항상 무순환)
    for _ in range(2):
        n = rnd.randint(50, 400)
        edges = set()
        for _ in range(rnd.randint(n, n * 3)):
            a = rnd.randint(1, n - 1)
            b = rnd.randint(a + 1, n)
            edges.add((a, b))
        inp, out = topo_case(n, list(edges))
        tests.append((inp, out, False, 3))
    # 랜덤 그래프 (순환 포함 가능) — 결과가 CYCLE이든 순서든 참조 솔버 기준
    for _ in range(2):
        n = rnd.randint(50, 400)
        edges = [(rnd.randint(1, n), rnd.randint(1, n)) for _ in range(rnd.randint(n, n * 2))]
        inp, out = topo_case(n, edges)
        tests.append((inp, out, False, 3))
    # 대형 사슬 (성능)
    big = 60000
    inp, out = topo_case(big, [(i, i + 1) for i in range(1, big)])
    tests.append((inp, out, False, 3))
    return tests


# ════════════════════════════════════════════════════════════════
#  CODE 2 — 이벤트 세션화 & 집계
# ════════════════════════════════════════════════════════════════

SESSION_STATEMENT = """## 문제

사용자 행동 로그를 **세션**으로 묶는 것은 분석의 기본입니다. `N`개의 이벤트가 `(시각, 사용자)` 형태로 주어집니다(순서는 뒤섞여 있을 수 있습니다).

한 사용자의 이벤트를 시각 순으로 정렬했을 때, **직전 이벤트와의 시간 간격이 `G`보다 크면 새로운 세션이 시작**됩니다(간격이 `G` 이하이면 같은 세션). 각 사용자에 대해 **세션 수**와 **한 세션에 포함된 최대 이벤트 수**를 구하세요.

## 입력

- 첫째 줄: `N G` (이벤트 수, 세션 간격 임계값(초))
- 다음 `N`개 줄: `t u` — `t`는 정수 시각(초), `u`는 공백 없는 사용자 ID(영숫자, 1~20자)

## 출력

- 등장한 각 사용자에 대해 **사용자 ID 사전순**으로 한 줄씩: `u S M`
  - `S`: 세션 수, `M`: 한 세션에 포함된 최대 이벤트 수

## 제한

- 1 ≤ N ≤ 100,000
- 1 ≤ G ≤ 1,000,000,000
- 0 ≤ t ≤ 1,000,000,000 (같은 시각의 이벤트가 여러 개일 수 있으며, 간격 0 은 항상 같은 세션)

## 예시 설명

- 예시 1: alice = [0, 5, 100] → 0~5(간격5≤10) 같은 세션, 5~100(간격95>10) 새 세션 ⇒ 세션 2개, 최대 2개. bob = [3, 4] ⇒ 세션 1개, 최대 2개. 사전순 출력.
- 예시 2: 이벤트가 하나면 세션 1개, 최대 1개.
"""

SESSION_STARTER = {
    "python": """import sys
from collections import defaultdict


def solve() -> None:
    data = sys.stdin.buffer.read().split()
    idx = 0
    n = int(data[idx]); idx += 1
    g = int(data[idx]); idx += 1
    # TODO: (t, u)를 읽어 사용자별로 모으고, 시각 정렬 후 간격 > G 마다 새 세션.
    #       사용자 ID 사전순으로 "u 세션수 최대이벤트수" 출력.


if __name__ == "__main__":
    solve()
""",
    "cpp": """#include <bits/stdc++.h>
using namespace std;

int main() {
    ios::sync_with_stdio(false);
    cin.tie(nullptr);

    long long n, g;
    cin >> n >> g;
    // TODO: 사용자별 시각 수집 → 정렬 → 간격 > g 마다 세션 분할 → 집계.
    //       사용자 ID(map은 자동 사전순)로 출력.

    return 0;
}
""",
    "java": """import java.io.*;
import java.util.*;

// 클래스 이름은 반드시 Main이어야 합니다.
public class Main {
    public static void main(String[] args) throws IOException {
        BufferedReader br = new BufferedReader(new InputStreamReader(System.in));
        StringTokenizer st = new StringTokenizer(br.readLine());
        int n = Integer.parseInt(st.nextToken());
        long g = Long.parseLong(st.nextToken());
        // TODO: TreeMap<String, List<Long>> 로 모아 정렬·집계 후 사전순 출력.
    }
}
""",
    "go": """package main

import (
	"bufio"
	"fmt"
	"os"
	"sort"
)

var reader = bufio.NewReader(os.Stdin)
var writer = bufio.NewWriter(os.Stdout)

func main() {
	defer writer.Flush()
	var n, g int64
	fmt.Fscan(reader, &n, &g)
	// TODO: map[string][]int64 로 모아 정렬·집계, 사용자 ID 정렬 후 출력.
	_ = sort.Strings
}
""",
}


def session_solve(g, events):
    byuser = defaultdict(list)
    for t, u in events:
        byuser[u].append(t)
    out = []
    for u in sorted(byuser):
        ts = sorted(byuser[u])
        sessions = 1
        cur = 1
        maxs = 1
        prev = ts[0]
        for t in ts[1:]:
            if t - prev > g:
                sessions += 1
                cur = 1
            else:
                cur += 1
            if cur > maxs:
                maxs = cur
            prev = t
        out.append(f"{u} {sessions} {maxs}")
    return "\n".join(out)


def session_case(g, events):
    lines = [f"{len(events)} {g}"] + [f"{t} {u}" for t, u in events]
    return "\n".join(lines) + "\n", session_solve(g, events) + "\n"


def build_session_tests():
    rnd = random.Random(19920815)
    tests = []
    inp, out = session_case(10, [(0, "alice"), (5, "alice"), (100, "alice"), (3, "bob"), (4, "bob")])
    tests.append((inp, out, True, 1))
    inp, out = session_case(60, [(42, "solo")])
    tests.append((inp, out, True, 1))
    # 같은 시각 다수 + 뒤섞인 순서
    inp, out = session_case(5, [(10, "u"), (10, "u"), (16, "u"), (10, "u"), (100, "u")])
    tests.append((inp, out, False, 2))
    # 경계: 간격이 정확히 G (같은 세션)
    inp, out = session_case(10, [(0, "x"), (10, "x"), (21, "x")])
    tests.append((inp, out, False, 2))
    # 여러 사용자 사전순
    inp, out = session_case(3, [(1, "charlie"), (1, "Alice"), (5, "charlie"), (2, "bob")])
    tests.append((inp, out, False, 2))
    # 랜덤 대형
    for _ in range(3):
        n = rnd.randint(300, 3000)
        g = rnd.randint(1, 50)
        users = [f"u{rnd.randint(1, 40)}" for _ in range(n)]
        events = [(rnd.randint(0, 500), users[i]) for i in range(n)]
        inp, out = session_case(g, events)
        tests.append((inp, out, False, 3))
    return tests


# 참조 정답 (검증용, Python)
TOPO_REF_SOLUTION = """import sys, heapq
from collections import defaultdict
def main():
    d = sys.stdin.buffer.read().split()
    i = 0
    n = int(d[i]); i+=1
    m = int(d[i]); i+=1
    adj = defaultdict(list); indeg = [0]*(n+1)
    for _ in range(m):
        a = int(d[i]); b = int(d[i+1]); i+=2
        adj[a].append(b); indeg[b]+=1
    h = [x for x in range(1,n+1) if indeg[x]==0]; heapq.heapify(h)
    order=[]
    while h:
        u=heapq.heappop(h); order.append(u)
        for v in adj[u]:
            indeg[v]-=1
            if indeg[v]==0: heapq.heappush(h,v)
    print("CYCLE" if len(order)<n else " ".join(map(str,order)))
main()
"""

SESSION_REF_SOLUTION = """import sys
from collections import defaultdict
def main():
    d = sys.stdin.buffer.read().split()
    i=0
    n=int(d[i]); i+=1
    g=int(d[i]); i+=1
    by=defaultdict(list)
    for _ in range(n):
        t=int(d[i]); u=d[i+1].decode(); i+=2
        by[u].append(t)
    out=[]
    for u in sorted(by):
        ts=sorted(by[u]); s=1; cur=1; mx=1; prev=ts[0]
        for t in ts[1:]:
            if t-prev>g: s+=1; cur=1
            else: cur+=1
            if cur>mx: mx=cur
            prev=t
        out.append(f"{u} {s} {mx}")
    sys.stdout.write("\\n".join(out)+"\\n")
main()
"""


# ════════════════════════════════════════════════════════════════
#  REPORT 문제 3종 — 아래 build_report_problems()에서 구성
# ════════════════════════════════════════════════════════════════

from report_problems import REPORT_PROBLEMS  # noqa: E402


def build_code_problems():
    return [
        {
            "title": "작업 의존성 스케줄러",
            "difficulty": "medium",
            "deliverable": "code",
            "statement_md": TOPO_STATEMENT,
            "starter_code": TOPO_STARTER,
            "grading_criteria": DEFAULT_GRADING,
            "time_limit_ms": 2000,
            "memory_limit_mb": 256,
            "_tests": build_topo_tests(),
            "_ref": TOPO_REF_SOLUTION,
        },
        {
            "title": "이벤트 세션화 & 집계",
            "difficulty": "medium",
            "deliverable": "code",
            "statement_md": SESSION_STATEMENT,
            "starter_code": SESSION_STARTER,
            "grading_criteria": DEFAULT_GRADING,
            "time_limit_ms": 2000,
            "memory_limit_mb": 256,
            "_tests": build_session_tests(),
            "_ref": SESSION_REF_SOLUTION,
        },
    ]


def to_test_cases(tests):
    return [
        {"input": inp, "expected_output": out, "is_sample": sample, "weight": w}
        for (inp, out, sample, w) in tests
    ]


def create_problem(s, spec):
    existing = [p for p in s.get(f"{API}/problems").json() if p["title"] == spec["title"]]
    if existing:
        print(f"  이미 존재: {spec['title']} — 스킵")
        return existing[0]["id"], False
    body = {
        "title": spec["title"],
        "statement_md": spec["statement_md"],
        "difficulty": spec.get("difficulty", "medium"),
        "deliverable": spec.get("deliverable", "code"),
        "time_limit_ms": spec.get("time_limit_ms", 2000),
        "memory_limit_mb": spec.get("memory_limit_mb", 256),
        "starter_code": spec.get("starter_code", {}),
        "reference_files": spec.get("reference_files", []),
        "grading_criteria": spec.get("grading_criteria", DEFAULT_GRADING),
        "test_cases": to_test_cases(spec["_tests"]) if "_tests" in spec else [],
    }
    r = s.post(f"{API}/problems", json=body)
    r.raise_for_status()
    pid = r.json()["id"]
    n_tc = len(body["test_cases"])
    n_rf = len(body["reference_files"])
    print(f"  생성: {spec['title']} [{body['deliverable']}] 테스트{n_tc} 자료{n_rf}")
    return pid, True


def wait_exec(s, ex_id, timeout=120):
    t0 = time.time()
    while time.time() - t0 < timeout:
        d = s.get(f"{API}/executions/{ex_id}").json()
        if d["status"] in ("done", "error"):
            return d
        time.sleep(1.5)
    return {"status": "timeout"}


def candidate_session(s):
    """검증용 응시자 세션 확보 — 비밀번호를 알려진 값으로 리셋 후 로그인."""
    cands = s.get(f"{API}/admin/users?role=candidate").json()
    if not cands:
        return None
    cid = cands[0]["id"]
    s.patch(f"{API}/admin/users/{cid}", json={"password": "verify1234"})
    cs = requests.Session()
    r = cs.post(f"{API}/auth/login", json={"email": cands[0]["email"], "password": "verify1234"})
    return cs if r.status_code == 200 else None


def verify_code_problem(admin_s, cs, assessment_id, problem_id, ref_solution):
    """정답(파이썬)을 응시자로 제출해 AC를 확인 — 테스트 케이스 정합성 검증.

    기존 attempt는 관리자 세션으로 삭제(응시자는 자기 attempt 삭제 불가).
    """
    rows = cs.get(f"{API}/my/assignments").json()
    a = next((x for x in rows if x["assessment_id"] == assessment_id), None)
    if not a:
        print("    (검증 스킵: 배정 없음)")
        return None
    if a.get("attempt_id"):
        admin_s.delete(f"{API}/attempts/{a['attempt_id']}")
    at = cs.post(f"{API}/assessments/{assessment_id}/attempts").json()
    if "id" not in at:
        print(f"    (검증 스킵: attempt 생성 실패 — {at})")
        return None
    ex = cs.post(
        f"{API}/attempts/{at['id']}/executions",
        json={"problem_id": problem_id, "kind": "submit", "language": "python", "code": ref_solution},
    ).json()
    res = wait_exec(cs, ex["id"])
    verdict = res.get("verdict")
    score = res.get("score")
    print(f"    검증 제출: verdict={verdict} score={score}")
    cs.delete(f"{API}/attempts/{at['id']}")
    return verdict == "AC" and score == 100.0


def ensure_assessment(s, title, mode, duration, turns, problem_specs):
    """(title) 시험을 만들거나 갱신하고 problem_specs를 배정. problem_specs=[(pid,points)]."""
    assessments = s.get(f"{API}/assessments").json()
    cand = next(
        (x["email"] for x in s.get(f"{API}/admin/users?role=candidate").json()),
        None,
    )
    users = s.get(f"{API}/admin/users?role=candidate").json()
    assignee_ids = [u["id"] for u in users]
    existing = next((a for a in assessments if a["title"] == title), None)
    payload = {
        "title": title,
        "description": "harnesser 기본 제공 템플릿 시험입니다.",
        "mode": mode,
        "duration_min": duration,
        "ai_max_turns": turns,
        "ai_provider_id": None,
        "starts_at": None,
        "ends_at": None,
        "problems": [{"problem_id": pid, "points": pts} for pid, pts in problem_specs],
        "assignee_ids": assignee_ids,
    }
    if existing:
        full = s.get(f"{API}/assessments/{existing['id']}").json()
        # 기존 문제 유지 + 새 문제 추가(중복 제거)
        have = {p["problem_id"] for p in full["problems"]}
        merged = [{"problem_id": p["problem_id"], "points": p["points"]} for p in full["problems"]]
        for pid, pts in problem_specs:
            if pid not in have:
                merged.append({"problem_id": pid, "points": pts})
        payload["problems"] = merged
        payload["mode"] = full["mode"]
        payload["duration_min"] = max(full["duration_min"], duration)
        payload["ai_max_turns"] = max(full.get("ai_max_turns", turns), turns)
        payload["ai_provider_id"] = full.get("ai_provider_id")
        r = s.put(f"{API}/assessments/{existing['id']}", json=payload)
        r.raise_for_status()
        print(f"  시험 갱신: {title} → 문제 {len(payload['problems'])}개")
        return existing["id"]
    r = s.post(f"{API}/assessments", json=payload)
    r.raise_for_status()
    aid = r.json()["id"]
    print(f"  시험 생성: {title} → 문제 {len(problem_specs)}개")
    return aid


def main():
    s = requests.Session()
    s.post(f"{API}/auth/login", json={"email": "admin@harnesser.dev", "password": "admin1234"}).raise_for_status()

    print("[1] code 문제 생성")
    code_specs = build_code_problems()
    code_ids = {}
    for spec in code_specs:
        pid, _ = create_problem(s, spec)
        code_ids[spec["title"]] = (pid, spec["_ref"])

    print("[2] report 문제 생성")
    report_ids = {}
    for spec in REPORT_PROBLEMS:
        pid, _ = create_problem(s, spec)
        report_ids[spec["title"]] = pid

    print("[3] 시험 배선")
    # 코딩 시험(standard)에 code 2문제 추가
    coding_aid = ensure_assessment(
        s,
        "백엔드 개발자 코딩 테스트 (데모)",
        "standard",
        120,
        20,
        [(code_ids["작업 의존성 스케줄러"][0], 150), (code_ids["이벤트 세션화 & 집계"][0], 150)],
    )
    # AI 활용 문제해결 평가(ai_assisted)에 report 3문제
    ensure_assessment(
        s,
        "AI 활용 문제해결 평가 (데모)",
        "ai_assisted",
        90,
        25,
        [(report_ids[t], 100) for t in report_ids],
    )

    if "--no-verify" in sys.argv:
        print("[4] 검증 스킵(--no-verify)")
        print("\n완료.")
        return

    print("[4] code 문제 정답 검증 (AC 확인)")
    cs = candidate_session(s)
    all_ac = True
    if cs is None:
        print("  (검증용 응시자 세션 확보 실패 — 스킵)")
    else:
        for title, (pid, ref) in code_ids.items():
            print(f"  {title}")
            ac = verify_code_problem(s, cs, coding_aid, pid, ref)
            if ac is False:
                all_ac = False
                print(f"    ✗ AC 실패 — 테스트 케이스 점검 필요")
    print("\n완료." + ("" if all_ac else " (일부 code 문제 검증 실패!)"))


if __name__ == "__main__":
    main()

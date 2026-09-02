"""기본 시나리오 검증 — 참조 해답을 적용하면 자동 체크가 전부 통과하는가.

시나리오가 "풀 수 있게" 설계됐는지, 체크가 실제로 동작하는지를 증명한다.
초기 상태에서는 체크가 대부분 실패해야 하고(문제가 성립), 참조 해답 적용 후에는
전부 통과해야 한다(정답이 존재).

사용법: python3 test_scenarios.py [--only "시나리오 제목 일부"]
"""

import sys
import time

import requests

from reference_solutions import REFERENCE_COMMANDS, REFERENCE_SOLUTIONS

API = "http://localhost:8100"
ok = fail = 0
only = None
if "--only" in sys.argv:
    only = sys.argv[sys.argv.index("--only") + 1]


def check(name, cond, detail=""):
    global ok, fail
    if cond:
        ok += 1
        print(f"  PASS {name}")
    else:
        fail += 1
        print(f"  FAIL {name} {detail}")


ad = requests.Session()
ad.post(f"{API}/auth/login", json={"email": "admin@odysseus.dev", "password": "admin1234"})

scenarios = ad.get(f"{API}/scenarios").json()
by_title = {s["title"]: s for s in scenarios}
print(f"등록된 시나리오 {len(scenarios)}개")

for title, files in REFERENCE_SOLUTIONS.items():
    if only and only not in title:
        continue
    print(f"\n── {title}")
    if title not in by_title:
        check(f"{title}: 시나리오 존재", False, "미등록")
        continue
    scenario_id = by_title[title]["id"]

    # 이 시나리오만 담은 임시 시험 + 응시 생성
    assessment = ad.post(
        f"{API}/assessments",
        json={
            "title": f"[검증] {title}",
            "description": "참조 해답 검증용 임시 시험",
            "duration_min": 120,
            "agent_max_turns": 0,
            "scenarios": [{"scenario_id": scenario_id, "points": 100}],
            "assignee_ids": [],
        },
    ).json()
    attempt = ad.post(f"{API}/assessments/{assessment['id']}/attempts").json()
    attempt_id = attempt["id"]
    base = f"{API}/attempts/{attempt_id}/scenarios/{scenario_id}"

    try:
        # 1) 초기 상태 — 문제가 성립하는가 (체크가 만점이면 안 된다)
        before = ad.post(f"{API}/review/attempts/{attempt_id}/checks", timeout=300).json()["scenarios"][0]
        check(
            f"초기 상태는 미완성 ({before['earned']}/{before['total']}점)",
            before["earned"] < before["total"],
            f"초기부터 만점 — 문제가 성립하지 않음",
        )

        # 2) 참조 해답 적용
        for path, content in files.items():
            r = ad.put(f"{base}/files/content", json={"path": path, "content": content})
            if r.status_code != 200:
                check(f"파일 저장 {path}", False, r.text[:120])

        # 3) 필요한 명령 실행 (산출물 생성)
        for command in REFERENCE_COMMANDS.get(title, []):
            run = ad.post(f"{base}/run", json={"command": command}).json()
            done = None
            for _ in range(60):
                time.sleep(1)
                done = ad.get(f"{API}/executions/{run['id']}").json()
                if done["status"] in ("done", "error"):
                    break
            check(
                f"참조 실행: {command}",
                done and done["exit_code"] == 0,
                f"exit={done and done.get('exit_code')} err={(done or {}).get('stderr', '')[:200]}",
            )

        # 4) 참조 해답이면 모든 체크 통과
        after = ad.post(f"{API}/review/attempts/{attempt_id}/checks", timeout=600).json()["scenarios"][0]
        failed = [c for c in after["checks"] if not c["passed"]]
        check(
            f"참조 해답 만점 ({after['earned']}/{after['total']}점)",
            not failed,
            "실패: " + "; ".join(f"{c['label']} — {c['detail'][:80]}" for c in failed),
        )
    finally:
        ad.delete(f"{API}/attempts/{attempt_id}")
        ad.delete(f"{API}/assessments/{assessment['id']}")

print(f"\n=== {ok} passed, {fail} failed ===")
sys.exit(1 if fail else 0)

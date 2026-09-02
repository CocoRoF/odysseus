"""다중 시나리오 순차 진행 검증 — 잠금·제출·되돌아가기 금지·자동 종료."""

import sys

import requests

API = "http://localhost:8100"
ok = fail = 0


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
for r in ad.get(f"{API}/review/attempts").json():
    ad.delete(f"{API}/attempts/{r['id']}")

scenarios = ad.get(f"{API}/scenarios").json()[:3]
assessment = ad.post(f"{API}/assessments", json={
    "title": "[검증] 순차 진행", "description": "", "duration_min": 120, "agent_max_turns": 0,
    "scenarios": [{"scenario_id": s["id"], "points": 100} for s in scenarios],
    "assignee_ids": [],
}).json()
at = ad.post(f"{API}/assessments/{assessment['id']}/attempts").json()
aid = at["id"]
ids = [s["scenario_id"] for s in sorted(at["scenarios"], key=lambda x: x["ordinal"])]

check("시작 시 첫 문제만 진행 중", at["current_ordinal"] == 0
      and [s["status"] for s in at["scenarios"]] == ["in_progress", "locked", "locked"],
      str([s["status"] for s in at["scenarios"]]))
check("잠긴 문제의 브리핑은 비공개",
      all(s["briefing_md"] == "" for s in at["scenarios"] if s["status"] == "locked"), "")

# 잠긴 문제 접근 차단
r = ad.get(f"{API}/attempts/{aid}/scenarios/{ids[1]}/files")
check("잠긴 문제 읽기 차단 (423)", r.status_code == 423, str(r.status_code))
r = ad.put(f"{API}/attempts/{aid}/scenarios/{ids[1]}/files/content", json={"path": "x.txt", "content": "x"})
check("잠긴 문제 쓰기 차단 (423)", r.status_code == 423, str(r.status_code))

# 현재 문제는 정상 동작
r = ad.put(f"{API}/attempts/{aid}/scenarios/{ids[0]}/files/content", json={"path": "note.txt", "content": "작업"})
check("현재 문제 작업 가능", r.status_code == 200, str(r.status_code))

# 순서를 건너뛴 제출은 거부
r = ad.post(f"{API}/attempts/{aid}/scenarios/{ids[1]}/complete")
check("건너뛰기 제출 거부 (409)", r.status_code == 409, str(r.status_code))

# 1번 제출 → 2번으로
nxt = ad.post(f"{API}/attempts/{aid}/scenarios/{ids[0]}/complete").json()
check("제출 후 다음 문제로 이동", nxt["current_ordinal"] == 1
      and [s["status"] for s in nxt["scenarios"]] == ["completed", "in_progress", "locked"],
      str([s["status"] for s in nxt["scenarios"]]))
check("진행 중 문제의 브리핑 공개", nxt["scenarios"][1]["briefing_md"] != "", "")
check("아직 시험은 진행 중", nxt["status"] == "in_progress", nxt["status"])

# 되돌아가기 금지 (읽기는 허용, 쓰기는 차단)
r = ad.get(f"{API}/attempts/{aid}/scenarios/{ids[0]}/files")
check("제출한 문제 읽기는 허용", r.status_code == 200, str(r.status_code))
r = ad.put(f"{API}/attempts/{aid}/scenarios/{ids[0]}/files/content", json={"path": "note.txt", "content": "수정"})
check("제출한 문제 수정 차단 (423)", r.status_code == 423, str(r.status_code))
r = ad.post(f"{API}/attempts/{aid}/scenarios/{ids[0]}/run", json={"command": "echo hi"})
check("제출한 문제 실행 차단 (423)", r.status_code == 423, str(r.status_code))

# 마지막까지 진행 → 자동 종료
ad.post(f"{API}/attempts/{aid}/scenarios/{ids[1]}/complete")
last = ad.post(f"{API}/attempts/{aid}/scenarios/{ids[2]}/complete").json()
check("마지막 문제 제출 시 시험 종료", last["status"] == "submitted", last["status"])
check("모든 문제 완료 표시",
      all(s["status"] == "completed" for s in last["scenarios"]),
      str([s["status"] for s in last["scenarios"]]))

# 종료 후에는 작업 불가
r = ad.put(f"{API}/attempts/{aid}/scenarios/{ids[2]}/files/content", json={"path": "y.txt", "content": "y"})
check("종료 후 작업 차단 (400)", r.status_code == 400, str(r.status_code))

# 이벤트 기록
events = {e["type"] for e in ad.get(f"{API}/review/attempts/{aid}/events").json()}
check("scenario_completed 이벤트 기록", "scenario_completed" in events and "attempt_submitted" in events, str(events))

# 단일 시나리오 시험은 곧바로 종료 버튼 (hasNext=false 조건)
single = ad.post(f"{API}/assessments", json={
    "title": "[검증] 단일", "duration_min": 60, "agent_max_turns": 0,
    "scenarios": [{"scenario_id": scenarios[0]["id"], "points": 100}], "assignee_ids": []}).json()
sat = ad.post(f"{API}/assessments/{single['id']}/attempts").json()
check("단일 시나리오는 current=0, 총 1개", sat["current_ordinal"] == 0 and len(sat["scenarios"]) == 1, "")
fin = ad.post(f"{API}/attempts/{sat['id']}/scenarios/{sat['scenarios'][0]['scenario_id']}/complete").json()
check("단일 시나리오 제출 = 시험 종료", fin["status"] == "submitted", fin["status"])

ad.delete(f"{API}/attempts/{aid}")
ad.delete(f"{API}/attempts/{sat['id']}")
ad.delete(f"{API}/assessments/{assessment['id']}")
ad.delete(f"{API}/assessments/{single['id']}")
print(f"\n=== {ok} passed, {fail} failed ===")
sys.exit(1 if fail else 0)

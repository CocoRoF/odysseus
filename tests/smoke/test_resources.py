"""자원 관리 E2E — 계측·강제 종료·고아 정리·권한.

"종료 버튼을 눌렀다"가 아니라 **프로세스가 실제로 사라졌는가**를 본다.
한 번은 컨테이너에 CAP_KILL 이 없어 종료가 조용히 무력했던 적이 있다.

호스트에서 실행:  python3 tests/smoke/test_resources.py
"""

import sys
import threading
import time

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
for a in ad.get(f"{API}/review/attempts").json():
    ad.delete(f"{API}/attempts/{a['id']}")
assessments = ad.get(f"{API}/assessments").json()


def new_attempt(title_part):
    spec = next(a for a in assessments if title_part in a["title"])
    at = ad.post(f"{API}/assessments/{spec['id']}/attempts").json()
    at = ad.get(f"{API}/attempts/{at['id']}").json()
    return at["id"], at["scenarios"][0]["scenario_id"]


def fire(aid, sid, command):
    """실행을 띄우고 즉시 돌아온다 (결과는 기다리지 않는다)."""
    threading.Thread(
        target=lambda: ad.post(
            f"{API}/attempts/{aid}/scenarios/{sid}/run", json={"command": command}
        ),
        daemon=True,
    ).start()


def wait_active(predicate, timeout=15):
    deadline = time.time() + timeout
    while time.time() < deadline:
        rows = ad.get(f"{API}/admin/resources").json().get("active", [])
        hit = [r for r in rows if predicate(r)]
        if hit:
            return hit[0]
        time.sleep(0.7)
    return None


aid, sid = new_attempt("매출")

print("\n── 계측 ──")
st, snap = 0, ad.get(f"{API}/admin/resources")
snap = snap.json()
check("러너 스냅샷 도착", snap["online"], str(snap)[:120])
check("동시 실행 수 보고", isinstance(snap.get("concurrency"), int), str(snap.get("concurrency")))
c = snap["container"]
check("컨테이너 메모리 상한 보고", bool(c.get("memory_limit_bytes")), str(c))
check("코어 수 보고", bool(c.get("cpu_count")), str(c))

fire(aid, sid, "python3 -c 'a=bytearray(300*1024*1024); print(sum(sum(range(50000000)) for _ in range(5)))'")
row = wait_active(lambda r: "bytearray" in r.get("command", ""))
check("실행이 활성 목록에 나타남", row is not None, "")
if row:
    peak_cpu = peak_mem = 0
    for _ in range(10):
        rows = ad.get(f"{API}/admin/resources").json()["active"]
        cur = next((r for r in rows if r["execution_id"] == row["execution_id"]), None)
        if not cur:
            break
        peak_cpu = max(peak_cpu, cur["cpu_percent"])
        peak_mem = max(peak_mem, cur["memory_bytes"])
        time.sleep(1)
    check("CPU 사용률이 실제로 측정됨", peak_cpu > 20, f"peak {peak_cpu}%")
    check("메모리 사용량이 실제로 측정됨", peak_mem > 200 * 1024 * 1024, f"peak {peak_mem // 1048576}MB")

print("\n── 응시자에게는 자기 것만 ──")
other_aid, other_sid = new_attempt("인프라")
fire(aid, sid, "sleep 25")
mine = wait_active(lambda r: r.get("command") == "sleep 25")
check("실행 등록", mine is not None)
if mine:
    a_view = ad.get(f"{API}/attempts/{aid}/resources").json()
    b_view = ad.get(f"{API}/attempts/{other_aid}/resources").json()
    check("자기 세션에는 보인다", a_view["running"] >= 1, str(a_view)[:120])
    check("남의 세션에는 안 보인다", b_view["running"] == 0, str(b_view)[:120])
    check("CPU 상한을 함께 알려 준다", a_view["cpu_capacity_percent"] >= 100, str(a_view)[:80])

    print("\n── 강제 종료 (프로세스가 실제로 사라지는가) ──")
    t0 = time.time()
    r = ad.post(f"{API}/admin/resources/executions/{mine['execution_id']}/kill")
    check("종료 요청 수락", r.status_code == 200, str(r.status_code))
    gone = False
    for _ in range(12):
        time.sleep(1)
        rows = ad.get(f"{API}/admin/resources").json()["active"]
        if not any(x["execution_id"] == mine["execution_id"] for x in rows):
            gone = True
            break
    # sleep 25 는 타임아웃(30초)보다 짧다 — 5초 안에 사라졌다면 정말 죽인 것이다
    check("실행이 즉시 사라진다", gone and time.time() - t0 < 8, f"{time.time() - t0:.1f}초")
    ex = ad.get(f"{API}/executions/{mine['execution_id']}").json()
    check("기록도 종료 상태로 닫힌다", ex["status"] in ("error", "done"), ex["status"])

print("\n── 세션 종료 ──")
sessions = ad.get(f"{API}/admin/resources").json()["sessions"]
check("진행 중 세션이 보고된다", any(s["attempt_id"] == other_aid for s in sessions), str(len(sessions)))
target = next(s for s in sessions if s["attempt_id"] == other_aid)
check("세션에 응시자·시험이 붙는다", bool(target["user_name"]) and bool(target["assessment_title"]), str(target)[:140])
r = ad.post(f"{API}/admin/resources/attempts/{other_aid}/terminate").json()
check("세션 종료 수락", r.get("ok") is True, str(r))
after = ad.get(f"{API}/attempts/{other_aid}").json()
check("응시가 제출 처리된다", after["status"] != "in_progress", after["status"])
sessions = ad.get(f"{API}/admin/resources").json()["sessions"]
check("목록에서 사라진다", not any(s["attempt_id"] == other_aid for s in sessions))

print("\n── 고아 정리 ──")
r = ad.post(f"{API}/admin/resources/cleanup").json()
check("정리 응답 형식", "closed_attempts" in r and "freed_executions" in r, str(r))

print("\n── 권한 ──")
anon = requests.Session()
check("비로그인 대시보드 차단", anon.get(f"{API}/admin/resources").status_code in (401, 403))
cand = requests.Session()
cand.post(f"{API}/auth/login", json={"email": "candidate@odysseus.dev", "password": "cand1234"})
check("응시자 대시보드 차단", cand.get(f"{API}/admin/resources").status_code == 403)
check("응시자 강제 종료 차단",
      cand.post(f"{API}/admin/resources/attempts/{aid}/terminate").status_code == 403)
check("남의 자원 조회 차단", cand.get(f"{API}/attempts/{aid}/resources").status_code == 403)

print(f"\n{ok} passed, {fail} failed")
sys.exit(1 if fail else 0)

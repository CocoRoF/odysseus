"""ODY-015 검증 — 동시 시작 요청이 응시를 하나만 만드는지 (개발 스택, 호스트에서 실행).

  API_URL=http://127.0.0.1:8100 python3 tests/security/test_attempt_race.py
"""

import json
import os
import sys
import threading
import urllib.error
import urllib.request
from http.cookiejar import CookieJar

API = os.environ.get("API_URL", "http://127.0.0.1:8100")
ok = fail = 0


def check(name, cond, detail=""):
    global ok, fail
    if cond:
        ok += 1
        print(f"  PASS {name}")
    else:
        fail += 1
        print(f"  FAIL {name} {str(detail)[:240]}")


def session(email, password):
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(CookieJar()))
    st, _ = call(op, "POST", "/auth/login", {"email": email, "password": password})
    assert st == 200, f"login {email} {st}"
    return op


def call(op, method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f"{API}{path}", data=data, method=method, headers={"Content-Type": "application/json"})
    try:
        with op.open(req, timeout=120) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, raw.decode(errors="replace")


admin = session("admin@odysseus.dev", "admin1234")
_, attempts = call(admin, "GET", "/review/attempts")
for a in attempts or []:
    call(admin, "DELETE", f"/attempts/{a['id']}")
_, assessments = call(admin, "GET", "/assessments")
# 응시자에게 배정된 시험을 쓴다 (데모 시드: 첫 시험이 응시자 배정)
cand = session("candidate@odysseus.dev", "cand1234")
_, mine = call(cand, "GET", "/my/assignments")
target = (mine or [{}])[0].get("assessment_id") or assessments[0]["id"]
target_title = next((a["title"] for a in assessments if a["id"] == target), None)


def candidate_rows():
    _, rows = call(admin, "GET", "/review/attempts")
    return [
        a for a in (rows or [])
        if (a.get("user") or {}).get("email") == "candidate@odysseus.dev"
        and (a.get("assessment_id") == target or a.get("assessment_title") == target_title)
    ]

print("\n── 동시에 12번 시작 → 응시는 하나 ──")
results = []
lock = threading.Lock()


def start():
    st, body = call(cand, "POST", f"/assessments/{target}/attempts")
    with lock:
        results.append((st, (body or {}).get("id") if isinstance(body, dict) else None))


threads = [threading.Thread(target=start) for _ in range(12)]
for t in threads:
    t.start()
for t in threads:
    t.join()
codes = [r[0] for r in results]
ids = {r[1] for r in results if r[1]}
check("모든 요청이 200 (idempotent)", codes.count(200) == 12, codes)
check("돌아온 응시 id 는 하나", len(ids) == 1, ids)
rows = candidate_rows()
active = [a for a in rows if not a.get("superseded")]
check("DB 에도 활성 응시 1건", len(active) == 1 and len(rows) == 1, [(a["id"][:8], a.get("superseded"), a.get("status")) for a in rows])
aid = next(iter(ids)) if ids else None

print("\n── 초기 파일이 한 벌만 물질화됐다 ──")
if aid:
    _, at = call(cand, "GET", f"/attempts/{aid}")
    sid = at["scenarios"][0]["scenario_id"]
    _, files = call(cand, "GET", f"/attempts/{aid}/scenarios/{sid}/files")
    paths = [f["path"] for f in (files["files"] if isinstance(files, dict) else files)]
    check("초기 파일 중복 없음", len(paths) == len(set(paths)) and len(paths) > 0, paths[:10])

print("\n── 재응시 동시 요청도 활성 응시 하나 ──")
results = []


def retake():
    st, body = call(admin, "POST", f"/attempts/{aid}/retake")
    with lock:
        results.append((st, (body or {}).get("id") if isinstance(body, dict) else None))


threads = [threading.Thread(target=retake) for _ in range(6)]
for t in threads:
    t.start()
for t in threads:
    t.join()
rows = candidate_rows()
active = [a for a in rows if not a.get("superseded")]
check("재응시 6회 동시 → 활성 1건, 나머지 superseded", len(active) == 1 and len(rows) >= 2, [(a["id"][:8], a.get("superseded")) for a in rows])
check("재응시 응답은 전부 200", all(r[0] == 200 for r in results), [r[0] for r in results])

print("\n── 유일 인덱스가 있다 (앱을 우회해도 막힌다) ──")
_, sysinfo = call(admin, "GET", "/healthz")
print("  (인덱스 존재는 하네스가 psql 로 확인)")

for a in rows:
    call(admin, "DELETE", f"/attempts/{a['id']}")
print(f"\n{ok} passed, {fail} failed")
sys.exit(1 if fail else 0)

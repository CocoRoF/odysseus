"""ODY-005 검증 — 출력 폭주가 러너 메모리를 먹지 못하고, 상한에서 잘리거나 끊기는지 (개발 스택, 호스트에서 실행).

  API_URL=http://127.0.0.1:8100 python3 tests/security/test_runner_output_flood.py

러너 컨테이너 메모리는 하네스가 `docker stats` 로 같이 잰다 — 여기서는 결과의 형태와 시간을 본다.
"""

import json
import os
import sys
import threading
import time
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


op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(CookieJar()))


def call(method, path, body=None):
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


st, _ = call("POST", "/auth/login", {"email": "admin@odysseus.dev", "password": "admin1234"})
assert st == 200, f"login {st}"
_, attempts = call("GET", "/review/attempts")
for a in attempts or []:
    call("DELETE", f"/attempts/{a['id']}")
_, assessments = call("GET", "/assessments")
_, attempt = call("POST", f"/assessments/{assessments[0]['id']}/attempts")
aid = attempt["id"]
sid = attempt["scenarios"][0]["scenario_id"]
base = f"/attempts/{aid}/scenarios/{sid}"


def run(command, timeout=90):
    t0 = time.time()
    st, ex = call("POST", f"{base}/run", {"command": command})
    assert st == 200, f"run {st} {ex}"
    for _ in range(timeout * 2):
        time.sleep(0.5)
        _, d = call("GET", f"/executions/{ex['id']}")
        if d["status"] in ("done", "error"):
            d["_elapsed"] = time.time() - t0
            return d
    d["_elapsed"] = time.time() - t0
    return d


MB = 1024 * 1024

print("\n── stdout 20MB (보존 상한 4MB) ──")
d = run("python3 -c \"import sys\nfor _ in range(20): sys.stdout.write('A'*1048576)\"; echo; echo END-MARK >&2")
check("실행은 정상 종료", d["status"] == "done", d["status"])
check("stdout 은 보존 상한(4MB) 이하", len(d["stdout"] or "") <= 4 * MB + 16, len(d["stdout"] or ""))
check("잘렸다는 안내", "만 보존" in (d["stderr"] or ""), d["stderr"][-200:])
check("stderr 는 살아 있다", "END-MARK" in (d["stderr"] or ""), d["stderr"][-200:])

print("\n── stderr 폭주 5MB (보존 8KB) ──")
d = run("python3 -c \"import sys\nfor _ in range(5): sys.stderr.write('E'*1048576)\"; echo out-ok")
check("실행은 정상 종료", d["status"] == "done" and "out-ok" in (d["stdout"] or ""), d)
check("stderr 는 작은 상한으로 잘림", len(d["stderr"] or "") <= 16 * 1024, len(d["stderr"] or ""))

print("\n── 폭주 (64MB 초과) 는 끊는다 ──")
t0 = time.time()
d = run("yes | head -c 300000000; echo never-here")
check("총량 상한에서 실행이 중단된다 (error)", d["status"] == "error" and "넘어 실행을 중단" in (d["stderr"] or ""), f"{d['status']} {d['stderr'][-160:]}")
check("제한 시간(30초)까지 기다리지 않는다", d["_elapsed"] < 25, f"{d['_elapsed']:.1f}s")
check("보존된 stdout 은 상한 이하", len(d["stdout"] or "") <= 4 * MB + 16, len(d["stdout"] or ""))
check("중단 뒤 명령은 이어지지 않는다", "never-here" not in (d["stdout"] or ""))

print("\n── 여러 자식이 동시에 쏟아내도 ──")
d = run("for i in 1 2 3 4 5 6; do yes $i & done; sleep 20; echo survived")
check("동시 폭주도 상한에서 끊긴다", d["status"] == "error" and d["_elapsed"] < 25, f"{d['status']} {d['_elapsed']:.1f}s")

print("\n── 다른 응시자의 실행은 영향이 없다 ──")
_, attempt2 = call("POST", f"/assessments/{assessments[-1]['id']}/attempts") if len(assessments) > 1 else (None, None)
other = {}
if attempt2:
    b2 = f"/attempts/{attempt2['id']}/scenarios/{attempt2['scenarios'][0]['scenario_id']}"

    def bystander():
        st, ex = call("POST", f"{b2}/run", {"command": "sleep 2; echo bystander-ok"})
        for _ in range(120):
            time.sleep(0.5)
            _, dd = call("GET", f"/executions/{ex['id']}")
            if dd["status"] in ("done", "error"):
                other["d"] = dd
                return

    t = threading.Thread(target=bystander)
    t.start()
    d = run("yes | head -c 200000000")
    t.join(timeout=60)
    dd = other.get("d") or {}
    check("옆 실행은 정상 완료", dd.get("status") == "done" and "bystander-ok" in (dd.get("stdout") or ""), dd)
    call("DELETE", f"/attempts/{attempt2['id']}")

print("\n── 슬롯 회복 ──")
d = run("echo still-alive")
check("이후 실행 정상", "still-alive" in (d["stdout"] or ""), d)
d = run("printf 'small\\n'; printf 'err\\n' >&2")
check("작은 출력은 그대로 (안내 없음)", (d["stdout"] or "").strip() == "small" and (d["stderr"] or "").strip() == "err", d)

call("DELETE", f"/attempts/{aid}")
print(f"\n{ok} passed, {fail} failed")
sys.exit(1 if fail else 0)

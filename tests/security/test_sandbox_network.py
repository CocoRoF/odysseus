"""ODY-003 검증 — 응시자 명령이 네트워크에 닿지 못하는지 실행해서 확인한다 (개발 스택, 호스트에서 실행).

  API_URL=http://127.0.0.1:8100 python3 tests/security/test_sandbox_network.py

러너는 redis·api 와 같은 내부 망에 있지만, 응시자 명령은 실행 전용 네트워크 네임스페이스(루프백만)
안에서 돌아야 한다. 설정을 읽어서가 아니라 명령을 돌려서 증명한다.
"""

import json
import os
import sys
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
        print(f"  FAIL {name} {str(detail)[:220]}")


op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(CookieJar()))


def call(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f"{API}{path}", data=data, method=method, headers={"Content-Type": "application/json"})
    try:
        with op.open(req, timeout=90) as r:
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


def run(command, timeout=60):
    st, ex = call("POST", f"/attempts/{aid}/scenarios/{sid}/run", {"command": command})
    assert st == 200, f"run {st} {ex}"
    for _ in range(timeout * 2):
        time.sleep(0.5)
        _, d = call("GET", f"/executions/{ex['id']}")
        if d["status"] in ("done", "error"):
            return d
    return d


print("\n── 응시자 명령의 네트워크 ──")
d = run("cat /proc/net/dev | awk 'NR>2{print $1}'")
ifaces = [l.strip().rstrip(":") for l in (d["stdout"] or "").splitlines() if l.strip()]
check("인터페이스는 lo 뿐", ifaces == ["lo"], ifaces)

d = run("python3 -c \"import socket; socket.create_connection(('redis', 6379), 3); print('CONNECTED')\"")
check("redis 에 연결 불가", d["exit_code"] != 0 and "CONNECTED" not in (d["stdout"] or ""), (d["stderr"] or "")[-160:])

d = run("python3 -c \"import socket; socket.create_connection(('api', 8000), 3); print('CONNECTED')\"")
check("api 에 연결 불가", d["exit_code"] != 0 and "CONNECTED" not in (d["stdout"] or ""), (d["stderr"] or "")[-160:])

d = run("python3 -c \"import urllib.request; print(urllib.request.urlopen('http://api:8000/healthz', timeout=3).read())\"")
check("api HTTP 도 불가", d["exit_code"] != 0, (d["stderr"] or "")[-160:])

d = run("getent hosts redis api example.com; echo rc=$?")
check("이름 풀이 불가 (redis/api/외부)", "rc=2" in (d["stdout"] or "") or "rc=1" in (d["stdout"] or ""), d["stdout"])

d = run(
    "python3 - <<'PY'\n"
    "import redis\n"
    "try:\n"
    "    r = redis.Redis(host='redis', port=6379, socket_connect_timeout=3); print('PING', r.ping())\n"
    "except Exception as e:\n"
    "    print('BLOCKED', type(e).__name__)\n"
    "PY"
)
check("문서의 재현 스크립트(redis 클라이언트)는 BLOCKED", "BLOCKED" in (d["stdout"] or "") and "PING" not in (d["stdout"] or ""), d["stdout"])

print("\n── 루프백은 살아 있다 (로컬 서버 개발 가능) ──")
d = run("python3 -c \"import socket; s=socket.socket(); s.bind(('127.0.0.1', 0)); print('bind', s.getsockname()[1] > 0)\"")
check("127.0.0.1 바인드 가능", "bind True" in (d["stdout"] or ""), d)
d = run(
    "python3 -m http.server 8765 --bind 127.0.0.1 >/dev/null 2>&1 & sleep 1; "
    "python3 -c \"import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:8765/', timeout=3).status)\"; kill %1"
)
check("로컬 HTTP 서버 기동 후 자기 접속 200", "200" in (d["stdout"] or ""), d)

print("\n── 위조 작업은 실행되지 않는다 (서명) ──")
print("  (러너 로그의 'DROPPED unsigned/forged job' 은 하네스가 확인한다)")

call("DELETE", f"/attempts/{aid}")
print(f"\n{ok} passed, {fail} failed")
sys.exit(1 if fail else 0)

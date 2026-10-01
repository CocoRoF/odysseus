"""ODY-021 검증 — 명령의 제어문자는 입력에서 거부되고, 러너 로그에는 이스케이프되어 남는지 (개발 스택, 호스트).

  API_URL=http://127.0.0.1:8100 python3 tests/security/test_log_injection.py
러너 로그 줄은 하네스가 `docker logs` 로 확인한다 (여기서는 마커를 심는다).
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
assert st == 200
_, attempts = call("GET", "/review/attempts")
for a in attempts or []:
    call("DELETE", f"/attempts/{a['id']}")
_, assessments = call("GET", "/assessments")
_, at = call("POST", f"/assessments/{assessments[0]['id']}/attempts")
aid, sid = at["id"], at["scenarios"][0]["scenario_id"]
base = f"/attempts/{aid}/scenarios/{sid}"


def run(cmd):
    st, ex = call("POST", f"{base}/run", {"command": cmd})
    if st != 200:
        return st, ex
    for _ in range(60):
        time.sleep(0.5)
        _, d = call("GET", f"/executions/{ex['id']}")
        if d["status"] in ("done", "error"):
            return st, d
    return st, d


print("\n── 입력 단계에서 거부 ──")
for label, cmd in [
    ("ESC (ANSI)", "echo \x1b[2J\x1b[H pwned"),
    ("캐리지리턴", "echo ok\r[runner] fake line"),
    ("NUL", "echo a\x00b"),
    ("C1 제어문자", "echo a\x85b"),
    ("bidi 제어(RLO)", "echo ‮evil"),
    ("줄 구분자 U+2028", "echo a b"),
]:
    st, body = run(cmd)
    check(f"{label} → 400", st == 400 and "제어문자" in str(body), (st, str(body)[:80]))

print("\n── 정상 입력은 그대로 ──")
st, d = run("printf 'a\\tb\\n'")
check("탭·개행 이스케이프 문자열은 정상", st == 200 and d["status"] == "done" and "a\tb" in (d["stdout"] or ""), d)
st, d = run("cat <<'EOF' > multi.txt\nline1\nline2\nEOF\nwc -l multi.txt")
check("여러 줄(heredoc) 명령은 허용", st == 200 and "2 multi.txt" in (d["stdout"] or ""), d)
st, d = run("echo LOGMARK-ODY021 ; echo 'quote\"mix'")
check("로그 마커 명령 실행", st == 200 and "LOGMARK-ODY021" in (d["stdout"] or ""), d)

print("\n── 에이전트 도구 경로도 같은 규칙 (내부 도구 실행 표면) ──")
print("  (validate_command 를 공유한다 — 소스 계약은 하네스에서 확인)")

call("DELETE", f"/attempts/{aid}")
print(f"\n{ok} passed, {fail} failed")
sys.exit(1 if fail else 0)

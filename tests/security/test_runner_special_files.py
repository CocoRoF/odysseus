"""ODY-004 검증 — 산출물 수집기가 심볼릭 링크·FIFO·장치·남의 파일을 따라가지 않는지 (개발 스택, 호스트에서 실행).

  API_URL=http://127.0.0.1:8100 python3 tests/security/test_runner_special_files.py

각 항목은 응시자 명령으로 함정을 만들고, 워크스페이스에 무엇이 반영됐는지와 실행이 제때 끝났는지를 본다.
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


def files():
    _, f = call("GET", f"{base}/files")
    rows = f["files"] if isinstance(f, dict) else f
    return {r["path"]: r for r in rows}


def content(path):
    st, c = call("GET", f"{base}/files/content?path={urllib.parse.quote(path)}")
    return (c or {}).get("content", "") if st == 200 else None


import urllib.parse

print("\n── 심볼릭 링크 ──")
d = run("ln -s /etc/passwd leaked.txt; ln -s /etc /etc-link; ln -s data data-link; ln -s /dev/zero zero.txt; echo made")
check("실행이 정상 종료", d["status"] == "done" and "made" in (d["stdout"] or ""), d)
fs = files()
check("/etc/passwd 링크가 워크스페이스에 반영되지 않음", "leaked.txt" not in fs, list(fs)[:10])
check("장치 링크(/dev/zero)도 반영되지 않음 (무한 읽기 없음)", "zero.txt" not in fs and d["_elapsed"] < 20, f"{d['_elapsed']:.1f}s")
check("디렉터리 링크를 따라가지 않음", not any(p.startswith("etc-link/") or p.startswith("data-link/") for p in fs), [p for p in fs if "link" in p][:5])
check("응시자에게 안내가 남는다", "심볼릭 링크" in (d["stderr"] or ""), d["stderr"])
check("changed_files 에 링크가 없다", not any(c.get("path") == "leaked.txt" for c in (d["changed_files"] or [])), d["changed_files"])

print("\n── FIFO / 소켓 ──")
d = run("mkfifo result.txt; python3 -c \"import socket; s=socket.socket(socket.AF_UNIX); s.bind('sock.txt')\"; echo fifo-made")
check("FIFO 가 있어도 수집이 멈추지 않는다", d["status"] == "done" and d["_elapsed"] < 20, f"{d['status']} {d['_elapsed']:.1f}s")
fs = files()
check("FIFO·소켓은 반영되지 않음", "result.txt" not in fs and "sock.txt" not in fs, list(fs)[:10])
check("FIFO 안내", "FIFO" in (d["stderr"] or ""), d["stderr"])

print("\n── 정상 산출물은 그대로 ──")
d = run("echo hello > made.txt; mkdir -p out/deep; echo nested > out/deep/n.txt; rm -f made_before.txt; echo ok")
fs = files()
check("일반 파일 반영", content("made.txt") == "hello\n")
check("하위 폴더 파일 반영", content("out/deep/n.txt") == "nested\n")
d = run("rm made.txt; echo removed")
fs = files()
check("삭제도 감지", "made.txt" not in fs, list(fs)[:10])

print("\n── 크기 상한 ──")
d = run("head -c 500000 /dev/urandom | base64 > big.txt; echo big-made")
check("상한 초과 파일은 조용히 제외 (실행은 정상)", d["status"] == "done" and "big.txt" not in files(), d)

print("\n── 링크 함정 뒤에도 슬롯이 살아 있다 ──")
d = run("echo still-alive")
check("이후 실행 정상", "still-alive" in (d["stdout"] or ""), d)

call("DELETE", f"/attempts/{aid}")
print(f"\n{ok} passed, {fail} failed")
sys.exit(1 if fail else 0)

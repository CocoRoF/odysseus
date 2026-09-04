"""ODY-010 검증 — 속도·동시성·비용 상한 (개발 스택, 호스트에서 엣지를 통해 실행).

  EDGE_URL=http://127.0.0.1:3100/api python3 tests/security/test_rate_limits.py

엣지(nginx)와 api 양쪽의 상한을 본다. LLM 공급자는 없어도 된다 — 상한은 공급자 호출 전에 걸린다.
"""

import json
import os
import sys
import threading
import time
import urllib.error
import urllib.request
from http.cookiejar import CookieJar

EDGE = os.environ.get("EDGE_URL", "http://127.0.0.1:3100/api")
ok = fail = 0


def check(name, cond, detail=""):
    global ok, fail
    if cond:
        ok += 1
        print(f"  PASS {name}")
    else:
        fail += 1
        print(f"  FAIL {name} {str(detail)[:240]}")


def make_session():
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(CookieJar()))


def call(op, method, path, body=None, headers=None):
    data = json.dumps(body).encode() if body is not None else None
    h = {"Content-Type": "application/json", **(headers or {})}
    req = urllib.request.Request(f"{EDGE}{path}", data=data, method=method, headers=h)
    try:
        with (op or make_session()).open(req, timeout=60) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw else None), dict(r.headers)
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            body = json.loads(raw)
        except Exception:
            body = raw.decode(errors="replace")
        return e.code, body, dict(e.headers)


print("\n── 로그인: 이메일별 실패 잠금 (지수 backoff) ──")
victim = "victim-lock@example.com"  # 데모 계정을 잠그면 다른 스모크가 오염된다 — 없는 계정도 실패로 센다
codes = []
for i in range(7):
    st, body, hdr = call(None, "POST", "/auth/login", {"email": victim, "password": f"wrong-{i}"}, headers={"CF-Connecting-IP": "203.0.113.7"})
    codes.append(st)
    time.sleep(0.15)
check("처음 5회는 401, 6회째부터 429", codes[:5] == [401] * 5 and 429 in codes[5:], codes)
st, body, hdr = call(None, "POST", "/auth/login", {"email": victim, "password": "whatever"}, headers={"CF-Connecting-IP": "203.0.113.7"})
check("잠긴 동안은 어떤 비밀번호도 429 (401 로 존재 여부를 알려주지 않음)", st == 429, st)
check("429 에 Retry-After", "Retry-After" in hdr or "retry-after" in {k.lower() for k in hdr}, hdr)
st, body, hdr = call(None, "POST", "/auth/login", {"email": "admin@odysseus.dev", "password": "admin1234"}, headers={"CF-Connecting-IP": "203.0.113.8"})
check("다른 계정(다른 IP)은 영향 없음", st == 200, st)

print("\n── 로그인: IP 별 속도 (엣지 분당 10 + api) ──")
codes = []
for i in range(16):
    st, _, _ = call(None, "POST", "/auth/login", {"email": f"nobody{i}@example.com", "password": "x"}, headers={"CF-Connecting-IP": "198.51.100.5"})
    codes.append(st)
check("같은 IP 의 빠른 로그인 시도는 429 로 막힌다", codes.count(429) >= 3, codes)

admin = make_session()
st, _, _ = call(admin, "POST", "/auth/login", {"email": "admin@odysseus.dev", "password": "admin1234"}, headers={"CF-Connecting-IP": "203.0.113.9"})
assert st == 200, f"admin login {st}"
_, attempts, _ = call(admin, "GET", "/review/attempts")
for a in attempts or []:
    call(admin, "DELETE", f"/attempts/{a['id']}")
_, assessments, _ = call(admin, "GET", "/assessments")
_, at, _ = call(admin, "POST", f"/assessments/{assessments[0]['id']}/attempts")
aid, sid = at["id"], at["scenarios"][0]["scenario_id"]
base = f"/attempts/{aid}/scenarios/{sid}"
_, scen, _ = call(admin, "GET", f"/attempts/{aid}")
ckey = (scen["scenarios"][0].get("characters") or [{}])[0].get("key", "pm")

print("\n── 메신저: 응시별 속도 ──")
codes = []
for i in range(8):
    st, _, hdr = call(admin, "POST", f"{base}/messenger/{ckey}", {"content": f"안녕하세요 {i}"})
    codes.append(st)
check("순간 6건 뒤에는 429 (공급자 유무와 무관)", 429 in codes[6:], codes)

print("\n── 실행: 응시별 동시 실행 상한 ──")
st1, e1, _ = call(admin, "POST", f"{base}/run", {"command": "sleep 4; echo a"})
st2, e2, _ = call(admin, "POST", f"{base}/run", {"command": "sleep 4; echo b"})
st3, e3, hdr = call(admin, "POST", f"{base}/run", {"command": "echo c"})
check("2개까지는 접수, 3번째는 429", st1 == 200 and st2 == 200 and st3 == 429, (st1, st2, st3, str(e3)[:80]))
check("429 에 Retry-After", any(k.lower() == "retry-after" for k in hdr), hdr)
time.sleep(6)
st4, e4, _ = call(admin, "POST", f"{base}/run", {"command": "echo d"})
check("끝난 뒤에는 다시 접수", st4 == 200, st4)

print("\n── 참고자료: 사용자별 속도 ──")
codes = []
for i in range(18):
    st, _, _ = call(admin, "GET", f"/reference/web/page?url=ftp://example.com/{i}")
    codes.append(st)
check("페이지 열기 순간 15건 뒤 429", codes.count(429) >= 1 and codes[0] in (400, 403), codes)
codes = []
for i in range(7):
    st, _, _ = call(admin, "POST", f"{base}/github/clone?owner=nobody&name=nothing-{i}")
    codes.append(st)
# 같은 사용자 버킷을 앞선 스모크가 이미 썼을 수 있어 정확한 번째는 보지 않는다 — 처음은 통과, 이어지면 429
check("clone 은 분당 10·순간 5 — 연달아 부르면 429", codes[0] != 429 and 429 in codes, codes)

print("\n── 엣지: IP 별 API 폭주 ──")
results = []
lock = threading.Lock()


def hammer():
    for _ in range(20):
        st, _, _ = call(None, "GET", "/healthz", headers={"CF-Connecting-IP": "192.0.2.44"})
        with lock:
            results.append(st)


threads = [threading.Thread(target=hammer) for _ in range(12)]
for t in threads:
    t.start()
for t in threads:
    t.join()
check("240 건 동시 요청 중 일부는 429 (초당 30·순간 60)", results.count(429) >= 20, f"429={results.count(429)} 200={results.count(200)}")
st, _, _ = call(None, "GET", "/healthz", headers={"CF-Connecting-IP": "192.0.2.45"})
check("다른 IP 는 그대로 200", st == 200, st)

call(admin, "DELETE", f"/attempts/{aid}")
print(f"\n{ok} passed, {fail} failed")
sys.exit(1 if fail else 0)

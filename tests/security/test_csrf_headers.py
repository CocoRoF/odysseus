"""ODY-024 검증 — 보안 헤더와 Origin 기반 CSRF 방어 (개발 스택, 호스트에서 엣지를 통해).

  EDGE_URL=http://127.0.0.1:3100 python3 tests/security/test_csrf_headers.py
"""

import json
import os
import sys
import urllib.error
import urllib.request

EDGE = os.environ.get("EDGE_URL", "http://127.0.0.1:3100").rstrip("/")
ok = fail = 0


def check(name, cond, detail=""):
    global ok, fail
    if cond:
        ok += 1
        print(f"  PASS {name}")
    else:
        fail += 1
        print(f"  FAIL {name} {str(detail)[:240]}")


def req(method, path, body=None, headers=None, token=None):
    data = json.dumps(body).encode() if body is not None else None
    h = {"Content-Type": "application/json", **(headers or {})}
    if token:
        h["Cookie"] = f"odysseus_token={token}"
    r = urllib.request.Request(f"{EDGE}{path}", data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(r, timeout=30) as resp:
            raw = resp.read()
            return resp.status, raw.decode(errors="replace"), {k.lower(): v for k, v in resp.headers.items()}
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode(errors="replace"), {k.lower(): v for k, v in e.headers.items()}


host = EDGE.split("://", 1)[1]
own_origin = EDGE  # 엣지의 실제 출처 (http://127.0.0.1:3100 등)

print("\n── 보안 헤더 ──")
for label, path in [("메인 UI", "/login"), ("API", "/api/healthz")]:
    st, _, h = req("GET", path)
    csp = h.get("content-security-policy", "")
    check(f"{label}: CSP frame-ancestors 'none'", "frame-ancestors 'none'" in csp, csp)
    check(f"{label}: object-src 'none' · base-uri · form-action", "object-src 'none'" in csp and "base-uri" in csp and "form-action" in csp, csp)
    check(f"{label}: X-Frame-Options DENY", h.get("x-frame-options", "").upper() == "DENY", h.get("x-frame-options"))
    check(f"{label}: Referrer-Policy no-referrer", h.get("referrer-policy") == "no-referrer", h.get("referrer-policy"))
    check(f"{label}: Permissions-Policy", "camera=()" in h.get("permissions-policy", ""), h.get("permissions-policy"))
    check(f"{label}: X-Content-Type-Options nosniff", h.get("x-content-type-options") == "nosniff", h.get("x-content-type-options"))

print("\n── CSRF: Origin 검사 (엣지 경유 변경 요청) ──")
login = {"email": "admin@odysseus.dev", "password": "admin1234"}
st, body, h = req("POST", "/api/auth/login", login, headers={"Origin": own_origin})
check("같은 출처 Origin → 200", st == 200, (st, body[:80]))
token = h.get("set-cookie", "").split("odysseus_token=", 1)[1].split(";", 1)[0] if "set-cookie" in h else ""
st, body, _ = req("POST", "/api/auth/login", login, headers={"Origin": "https://evil.example"})
check("다른 출처 Origin → 403", st == 403, (st, body[:80]))
st, body, _ = req("POST", "/api/auth/login", login, headers={"Origin": f"http://sibling.{host.split(':')[0]}"})
check("같은 site 의 다른 origin(형제 서브도메인) → 403", st == 403, (st, body[:80]))
st, body, _ = req("POST", "/api/auth/login", login, headers={"Sec-Fetch-Site": "cross-site"})
check("Origin 없이 Sec-Fetch-Site: cross-site → 403", st == 403, (st, body[:80]))
st, body, _ = req("POST", "/api/auth/login", login, headers={"Sec-Fetch-Site": "same-site"})
check("Sec-Fetch-Site: same-site(형제) → 403", st == 403, (st, body[:80]))
st, body, _ = req("POST", "/api/auth/login", login, headers={"Sec-Fetch-Site": "same-origin"})
check("Sec-Fetch-Site: same-origin → 200", st == 200, (st, body[:80]))
st, body, _ = req("POST", "/api/auth/login", login)
check("Origin·Sec-Fetch 둘 다 없는 비브라우저 요청은 통과 (쿠키가 없으니 CSRF 아님)", st == 200, (st, body[:80]))
if token:
    st, body, _ = req("POST", "/api/auth/logout", headers={"Origin": "https://evil.example"}, token=token)
    check("쿠키가 있어도 다른 출처의 상태 변경(로그아웃) → 403", st == 403, (st, body[:80]))
    st, body, _ = req("GET", "/api/auth/me", headers={"Origin": "https://evil.example"}, token=token)
    check("GET 은 Origin 과 무관 (읽기는 CORS 가 막는다)", st == 200, st)
    st, body, _ = req("POST", "/api/auth/logout", headers={"Origin": own_origin}, token=token)
    check("같은 출처의 로그아웃은 200", st == 200, st)

print(f"\n{ok} passed, {fail} failed")
sys.exit(1 if fail else 0)

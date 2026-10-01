"""ODY-014 검증 — Secure 쿠키·HTTPS 강제·HSTS·리다이렉트 (호스트에서 엣지를 통해).

  MODE=production EDGE_URL=http://127.0.0.1:3100 API_URL=http://127.0.0.1:8100 python3 tests/security/test_tls_cookie.py
  MODE=development ... (개발 모드에서는 강제가 꺼져 있어야 한다)

운영 모드 스택은 EDGE_HTTPS_ONLY=on, ODYSSEUS_ENV=production, BOOTSTRAP_ADMIN_* 로 띄운다.
Cloudflare 뒤의 HTTPS 접속은 CF-Visitor 헤더로 흉내 낸다 (엣지가 그것으로 스킴을 판정한다).
"""

import json
import os
import sys
import urllib.error
import urllib.request

EDGE = os.environ.get("EDGE_URL", "http://127.0.0.1:3100").rstrip("/")
API = os.environ.get("API_URL", "http://127.0.0.1:8100").rstrip("/")
MODE = os.environ.get("MODE", "production")
EMAIL = os.environ.get("ADMIN_EMAIL", "admin@odysseus.dev")
PASSWORD = os.environ.get("ADMIN_PASSWORD", "admin1234")
ok = fail = 0


def check(name, cond, detail=""):
    global ok, fail
    if cond:
        ok += 1
        print(f"  PASS {name}")
    else:
        fail += 1
        print(f"  FAIL {name} {str(detail)[:240]}")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


opener = urllib.request.build_opener(NoRedirect)


def req(base, method, path, body=None, headers=None):
    data = json.dumps(body).encode() if body is not None else None
    h = {"Content-Type": "application/json", **(headers or {})}
    r = urllib.request.Request(f"{base}{path}", data=data, method=method, headers=h)
    try:
        with opener.open(r, timeout=30) as resp:
            return resp.status, resp.read().decode(errors="replace"), {k.lower(): v for k, v in resp.headers.items()}
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode(errors="replace"), {k.lower(): v for k, v in e.headers.items()}


CF_HTTPS = {"CF-Visitor": '{"scheme":"https"}', "CF-Connecting-IP": "203.0.113.10"}
CF_HTTP = {"CF-Visitor": '{"scheme":"http"}', "CF-Connecting-IP": "203.0.113.11"}
login = {"email": EMAIL, "password": PASSWORD}

if MODE == "production":
    print("\n── 운영 모드: 평문은 거부·리다이렉트, HTTPS 만 통과 ──")
    st, body, h = req(EDGE, "GET", "/api/healthz")
    check("평문 GET 은 301 → https", st == 301 and h.get("location", "").startswith("https://"), (st, h.get("location")))
    st, body, h = req(EDGE, "GET", "/api/healthz", headers=CF_HTTPS)
    check("Cloudflare https 로 온 GET 은 200", st == 200, st)
    check("https 응답에 HSTS", "max-age=31536000" in h.get("strict-transport-security", ""), h.get("strict-transport-security"))
    st, body, h = req(EDGE, "POST", "/api/auth/login", login, headers=CF_HTTP)
    check("Cloudflare 가 http 라고 하면 로그인은 301 (엣지) 또는 403 (api)", st in (301, 403), (st, body[:80]))
    st, body, h = req(EDGE, "POST", "/api/auth/login", login, headers={"X-Forwarded-Proto": "https", "X-Forwarded-For": "203.0.113.12"})
    check("임의의 X-Forwarded-Proto: https 는 믿지 않는다 (평문 → 301/403)", st in (301, 403), (st, body[:80]))
    st, body, h = req(EDGE, "POST", "/api/auth/login", login, headers=CF_HTTPS)
    check("https 로그인 200", st == 200, (st, body[:120]))
    cookie = h.get("set-cookie", "")
    check("쿠키에 Secure", "secure" in cookie.lower(), cookie)
    check("쿠키에 HttpOnly", "httponly" in cookie.lower(), cookie)
    check("쿠키에 SameSite=lax", "samesite=lax" in cookie.lower(), cookie)
    st, body, h = req(API, "GET", "/healthz")
    check("api 직접 호출(프록시 흔적 없음)은 영향 없음", st == 200, st)
    st, body, h = req(API, "POST", "/auth/login", login)
    check("api 직접 로그인(배포 스크립트 경로)도 200", st == 200, (st, body[:80]))
    st, body, h = req(API, "POST", "/auth/login", login, headers={"X-Forwarded-For": "1.2.3.4"})
    check("프록시 흔적은 있는데 https 가 아니면 api 가 403", st == 403, (st, body[:80]))
else:
    print("\n── 개발 모드: 강제 없음 ──")
    st, body, h = req(EDGE, "GET", "/api/healthz")
    check("평문 GET 200 (리다이렉트 없음)", st == 200, st)
    check("HSTS 없음", "strict-transport-security" not in h, h.get("strict-transport-security"))
    st, body, h = req(EDGE, "POST", "/api/auth/login", login)
    check("평문 로그인 200", st == 200, (st, body[:80]))
    check("쿠키에 Secure 없음 (로컬 http 에서 동작해야 한다)", "secure" not in h.get("set-cookie", "").lower(), h.get("set-cookie"))

print(f"\n{ok} passed, {fail} failed")
sys.exit(1 if fail else 0)

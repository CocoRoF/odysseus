"""ODY-006 검증 — 참고자료 프록시가 내부 주소로 가지 않는지 (api 컨테이너 안에서 실행, 개발 스택).

  docker cp tests/security/test_ssrf.py <api>:/tmp/
  docker exec -e PYTHONPATH=/app <api> python3 /tmp/test_ssrf.py

컨테이너 안 127.0.0.1:9911 에 '내부 서비스' 를 띄워 두고, 여러 경로로 거기에 닿으려 한다:
직접 주소, 루프백으로 풀리는 공개 호스트명, IPv4-mapped IPv6, 십진/8진 표기, 도커 내부 이름(api/redis/postgres),
링크로컬 메타데이터, 비표준 포트, 그리고 **공인 사이트의 리다이렉트** (httpbin.org/redirect-to).
정상 사이트와 정상 리다이렉트(http→https)는 여전히 열려야 한다.
"""

import http.server
import json
import os
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request
from http.cookiejar import CookieJar

API = "http://127.0.0.1:8000"
MARK = "SECRET_TEST_MARKER_7f3a"
ok = fail = 0


def check(name, cond, detail=""):
    global ok, fail
    if cond:
        ok += 1
        print(f"  PASS {name}")
    else:
        fail += 1
        print(f"  FAIL {name} {str(detail)[:240]}")


class Internal(http.server.BaseHTTPRequestHandler):
    hits = 0

    def do_GET(self):
        Internal.hits += 1
        body = f"<html><title>internal</title><body>{MARK}</body></html>".encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


srv = http.server.ThreadingHTTPServer(("127.0.0.1", 9911), Internal)
threading.Thread(target=srv.serve_forever, daemon=True).start()

op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(CookieJar()))


def call(method, path, body=None):
    import time as _t

    for _ in range(30):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(f"{API}{path}", data=data, method=method, headers={"Content-Type": "application/json"})
        try:
            with op.open(req, timeout=60) as r:
                raw = r.read()
                return r.status, (json.loads(raw) if raw else None)
        except urllib.error.HTTPError as e:
            raw = e.read()
            if e.code == 429:  # 속도 제한(ODY-010)은 이 테스트의 관심사가 아니다 — Retry-After 만큼 기다렸다 다시
                _t.sleep(float(e.headers.get("Retry-After", "2")))
                continue
            try:
                return e.code, json.loads(raw)
            except Exception:
                return e.code, raw.decode(errors="replace")
    return 429, "rate limited"


st, _ = call("POST", "/auth/login", {"email": "admin@odysseus.dev", "password": "admin1234"})
assert st == 200, f"login {st}"


def page(url):
    return call("GET", "/reference/web/page?" + urllib.parse.urlencode({"url": url}))


def render(url):
    return call("GET", "/reference/web/render?" + urllib.parse.urlencode({"url": url, "asset_base": "http://localhost:3100/api/reference/web/asset"}))


print("\n── 직접 내부 주소 ──")
for label, url in [
    ("루프백 IP", "http://127.0.0.1:9911/"),
    ("localhost", "http://localhost:9911/"),
    ("IPv6 루프백", "http://[::1]:9911/"),
    ("IPv4-mapped IPv6", "http://[::ffff:127.0.0.1]:9911/"),
    ("십진 표기", "http://2130706433:9911/"),
    ("0.0.0.0", "http://0.0.0.0:9911/"),
    ("도커 내부 이름 api", "http://api:8000/openapi.json"),
    ("도커 내부 이름 redis", "http://redis:6379/"),
    ("도커 내부 이름 postgres", "http://postgres:5432/"),
    ("메타데이터 링크로컬", "http://169.254.169.254/latest/meta-data/"),
    ("사설 대역", "http://10.0.0.1/"),
    ("사설 대역 172.16", "http://172.16.0.1/"),
    ("사설 대역 192.168", "http://192.168.1.1/"),
    ("IPv6 ULA", "http://[fd00::1]/"),
    ("사용자 정보 포함", "http://user:pw@example.com/"),
    ("비표준 포트(공인 호스트)", "http://example.com:8000/"),
    ("스킴 file", "file:///etc/passwd"),
    ("스킴 ftp", "ftp://example.com/"),
]:
    st, body = page(url)
    check(f"{label} 거부 ({st})", st in (400, 403) and MARK not in json.dumps(body), f"{st} {str(body)[:100]}")

print("\n── 루프백으로 풀리는 공개 호스트명 (DNS 기반 우회) ──")
st, body = page("http://localtest.me:9911/")
check(f"localtest.me → 127.0.0.1 거부 ({st})", st in (400, 403) and MARK not in json.dumps(body), str(body)[:100])
check("내부 서비스에 요청이 전혀 닿지 않았다", Internal.hits == 0, f"hits={Internal.hits}")

print("\n── 공인 사이트의 리다이렉트로 내부 진입 ──")
redirect_ok = False
for base in ("https://httpbin.org/redirect-to?url=", "https://httpbingo.org/redirect-to?url="):
    target = base + urllib.parse.quote("http://127.0.0.1:9911/", safe="")
    st, body = page(target)
    if st == 502 and "ConnectError" in str(body):
        continue  # 리다이렉터 자체에 못 닿음 — 다음 후보
    redirect_ok = True
    check(f"302 → 127.0.0.1 은 거부 ({st})", st in (400, 403) and MARK not in json.dumps(body), f"{st} {str(body)[:120]}")
    st, body = render(target)
    check(f"render 경로도 거부 ({st})", st in (400, 403) and MARK not in json.dumps(body), f"{st} {str(body)[:120]}")
    target2 = base + urllib.parse.quote("http://api:8000/openapi.json", safe="")
    st, body = page(target2)
    check(f"302 → api:8000 도 거부 ({st})", st in (400, 403) and "openapi" not in json.dumps(body), f"{st} {str(body)[:120]}")
    break
if not redirect_ok:
    print("  (외부 리다이렉터에 닿지 못해 리다이렉트 검증은 건너뜀)")
check("리다이렉트 시도 뒤에도 내부 서비스 hit 0", Internal.hits == 0, f"hits={Internal.hits}")

print("\n── 정상 경로는 열린다 ──")
st, body = page("http://example.com/")
if st == 502:
    print("  (외부 인터넷에 닿지 못해 정상 경로 검증은 건너뜀)")
else:
    check("example.com 읽기", st == 200 and "Example Domain" in body.get("text", ""), f"{st} {str(body)[:100]}")
    st, body = page("http://github.com/")
    check("http→https 정상 리다이렉트는 따라간다", st == 200 and body.get("url", "").startswith("https://github.com"), f"{st} {str(body)[:100]}")
    st, body = render("https://example.com/")
    check("render 정상", st == 200 and "<html" in body.get("html", "").lower(), f"{st} {str(body)[:100]}")

srv.shutdown()
print(f"\n{ok} passed, {fail} failed")
sys.exit(1 if fail else 0)

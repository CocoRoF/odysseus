"""ODY-020 검증 — 서명 자산 URL 의 TTL·범위 바인딩, 기록 URL 의 쿼리 제거 (api 컨테이너 안에서).

  docker cp tests/security/test_asset_scope.py <api>:/tmp/
  docker exec -e PYTHONPATH=/app <api> python3 /tmp/test_asset_scope.py
"""

import sys
import time

from odysseus_api import web_render
from odysseus_api.routers.reference import _url_for_log

ok = fail = 0


def check(name, cond, detail=""):
    global ok, fail
    if cond:
        ok += 1
        print(f"  PASS {name}")
    else:
        fail += 1
        print(f"  FAIL {name} {str(detail)[:200]}")


SECRET = "s" * 40
URL = "https://cdn.example.com/a/b.css?v=1"

print("\n── 서명 자산: 범위(응시) 바인딩 ──")
u, exp, sig = web_render.sign_asset(URL, SECRET, scope="attempt-A")
check("같은 범위로 검증 → URL", web_render.verify_asset(u, exp, sig, SECRET, scope="attempt-A") == URL)
check("다른 범위로 검증 → 거부", web_render.verify_asset(u, exp, sig, SECRET, scope="attempt-B") is None)
check("범위 없이 검증 → 거부", web_render.verify_asset(u, exp, sig, SECRET, scope="") is None)
check("다른 시크릿 → 거부", web_render.verify_asset(u, exp, sig, "x" * 40, scope="attempt-A") is None)
check("TTL 은 15분", web_render.ASSET_TTL_S == 15 * 60, web_render.ASSET_TTL_S)
check("만료 뒤 → 거부", web_render.verify_asset(u, exp, sig, SECRET, scope="attempt-A", now=time.time() + 16 * 60) is None)
href = web_render.asset_url("http://h/api/reference/web/asset", URL, SECRET, "attempt-A")
check("asset_url 에 a=범위 가 붙는다", "&a=attempt-A" in href, href)

print("\n── 렌더 결과의 자산 링크가 범위를 품는다 ──")
html = b'<html><head><link rel="stylesheet" href="/s.css"></head><body><img src="/i.png"></body></html>'
res = web_render.render_page("https://site.example/p", html, asset_base="http://h/api/reference/web/asset", secret=SECRET, scope="attempt-A")
check("img 프록시 URL 에 a=attempt-A", "a=attempt-A" in res.html, res.html[:300])
css = web_render.rewrite_css("body{background:url(/bg.png)}", "https://site.example/p", "http://h/api/reference/web/asset", SECRET, "attempt-A")
check("CSS url() 도 범위 포함", "a=attempt-A" in css, css)

print("\n── 기록용 URL 은 쿼리·userinfo 제거 ──")
check("쿼리 제거", _url_for_log("https://ex.com/path?q=secret&token=abc") == "https://ex.com/path")
check("userinfo 제거", _url_for_log("https://user:pw@ex.com/p") == "https://ex.com/p")
check("비표준 포트는 남김", _url_for_log("http://ex.com:8080/x?y=1") == "http://ex.com:8080/x")
check("경로 없으면 /", _url_for_log("https://ex.com?x=1") == "https://ex.com/")

print(f"\n{ok} passed, {fail} failed")
sys.exit(1 if fail else 0)

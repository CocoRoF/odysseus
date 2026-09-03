"""인터넷 앱 렌더러 계약 — 무엇이 살아남고 무엇이 반드시 죽는가.

  docker cp tests/smoke/test_web_render.py odysseus-api-1:/tmp/
  docker exec -e PYTHONPATH=/app odysseus-api-1 python3 /tmp/test_web_render.py
"""
import html as _html
import re
import sys
import time

from odysseus_api.web_render import asset_url, render_page, rewrite_css, sign_asset, verify_asset

ok = fail = 0
_SIG = re.compile(r"u=([^&\"']+)&exp=(\d+)&sig=([0-9a-f]+)")


def targets(fragment: str, secret: str) -> list[str]:
    """직렬화된 HTML/CSS 안의 프록시 URL 들을 풀어 원래 주소 목록으로 (속성의 &amp; 를 되돌린다)."""
    out = []
    for m in _SIG.finditer(_html.unescape(fragment)):
        t = verify_asset(m.group(1), m.group(2), m.group(3), secret)
        if t:
            out.append(t)
    return out



def check(name, cond, detail=""):
    global ok, fail
    if cond:
        ok += 1
        print(f"  PASS {name}")
    else:
        fail += 1
        print(f"  FAIL {name} {detail}")


SECRET = "test-secret"
ASSET = "https://exam.example.com/api/reference/web/asset"
PAGE = "https://docs.example.org/guide/intro.html?x=1"

HTML = b"""<!doctype html><html><head>
<meta http-equiv="refresh" content="0;url=https://evil.example/">
<base href="https://evil.example/">
<title>vLLM  Docs \xe2\x80\x94 Intro</title>
<link rel="stylesheet" href="/static/site.css">
<style>body{background:url(/bg.png)} @import url(x.css);</style>
<script>alert(1)</script>
</head><body onload="alert(2)">
<nav><a href="/guide/next.html" onclick="steal()">Next</a> <a href="javascript:alert(3)">js</a></nav>
<h1 style="color:red;background:url(../h.png)">Intro</h1>
<p>Hello <b>world</b> <custom-el>custom</custom-el></p>
<img src="/img/a.png" srcset="/img/a@2x.png 2x" data-src="/img/real.png">
<img data-src="/img/lazy.png">
<form action="/login"><input name="pw"><button>Go</button></form>
<iframe src="https://evil.example/"></iframe>
<svg onload="x()"><script>y()</script></svg>
<video src="/v.mp4"></video>
<pre><code>print("hi")</code></pre>
<table><tr><td>cell</td></tr></table>
<!-- comment -->
</body></html>"""

r1 = render_page(PAGE, HTML, asset_base=ASSET, secret=SECRET)
check("외부 CSS 목록을 알려 준다", r1.stylesheets == ["https://docs.example.org/static/site.css"], str(r1.stylesheets))
r = render_page(PAGE, HTML, asset_base=ASSET, secret=SECRET, inline_css={r1.stylesheets[0]: "h1{font-size:2em} .x{background:url(/s.png)}"})
h = r.html

print("\n── 반드시 죽어야 하는 것 ──")
check("스크립트 제거", "alert(1)" not in h and "steal()" not in h and "y()" not in h)
check("인라인 이벤트 제거", "onload" not in h and "onclick" not in h)
check("javascript: 링크 제거", "javascript:" not in h)
check("meta refresh 제거", "refresh" not in h.lower().split("<body")[1] and "evil.example" not in h)
check("iframe/form/input/button/video/svg 제거", all(t not in h for t in ("<iframe", "<form", "<input", "<button", "<video", "<svg")))
check("주석 제거", "comment" not in h)
check("<base> 무시 — 상대 경로는 페이지 기준", "docs.example.org" in h and "evil.example" not in h)

print("\n── 살아남아야 하는 것 ──")
check("제목", r.title == "vLLM Docs — Intro", r.title)
check("본문 구조", all(t in h for t in ("<h1", "<p>", "<b>", "<pre>", "<code>", "<table>", "<td>")))
check("커스텀 엘리먼트는 태그만 벗기고 글은 남긴다", "custom" in h and "<custom-el" not in h)
check("읽기용 텍스트", "Hello world custom" in r.text and "cell" in r.text, r.text[:80])

print("\n── 링크는 우리가 가로챈다 ──")
check("href → data-href (절대경로)", 'data-href="https://docs.example.org/guide/next.html"' in h)
check("원래 href 는 없다", 'href="/guide/next.html"' not in h)
check("브릿지 스크립트가 nonce 로 심긴다", re.search(r'<script nonce="[A-Za-z0-9_\-]+">', h) is not None)
check("브릿지가 navigate 를 postMessage 한다", "odysseus:navigate" in h)

print("\n── 자산은 서명된 프록시로만 ──")
imgs = re.findall(r'<img[^>]+src="([^"]+)"', h)
check("img src 가 프록시를 지난다", imgs and all(u.startswith(ASSET + "?u=") for u in imgs), str(imgs)[:160])
img_targets = [t for u in imgs for t in targets(u, SECRET)]
check("lazy data-src 를 실제 src 로 승격", any("lazy.png" in t for t in img_targets), str(img_targets))
check("data-src 가 있으면 자리표시자 대신 그것을 쓴다", any("real.png" in t for t in img_targets), str(img_targets))
check("srcset 도 프록시", 'srcset="' + ASSET in h)
h1_tag = re.search(r"<h1[^>]*>", h).group(0)
check("인라인 style 의 url() 도 프록시", any(t == "https://docs.example.org/h.png" for t in targets(h1_tag, SECRET)), h1_tag[:160])
check("<style> 의 url() 도 프록시, @import 는 제거", ASSET in h and "@import" not in h)
check("외부 CSS 가 인라인된다", "font-size:2em" in h and 'data-from="https://docs.example.org/static/site.css"' in h)
check("CSS 는 원래 그 CSS 의 URL 기준으로 해석", any(t == "https://docs.example.org/s.png" for t in targets(h, SECRET)), str([t for t in targets(h, SECRET) if "s.png" in t]))

print("\n── CSP ──")
csp = re.search(r'Content-Security-Policy" content="([^"]+)"', h).group(1)
check("default-src 'none'", "default-src 'none'" in csp)
check("img/font 는 프록시 오리진만", "img-src https://exam.example.com data:" in csp and "font-src https://exam.example.com" in csp)
check("script 는 nonce 만", re.search(r"script-src 'nonce-[A-Za-z0-9_\-]+'", csp) is not None and "unsafe-inline" not in csp.split("script-src")[1].split(";")[0])
check("connect/frame/form 차단", all(x in csp for x in ("connect-src 'none'", "frame-src 'none'", "form-action 'none'")))

print("\n── 서명 ──")
u, exp, sig = sign_asset("https://a.b/c.png", SECRET)
check("서명 검증 통과", verify_asset(u, exp, sig, SECRET) == "https://a.b/c.png")
check("서명 위조 거부", verify_asset(u, exp, "0" * 32, SECRET) is None)
check("다른 비밀로는 거부", verify_asset(u, exp, sig, "other") is None)
check("만료 거부", verify_asset(u, exp, sig, SECRET, now=time.time() + 7 * 3600) is None)
check("URL 바꿔치기 거부", verify_asset(u.replace("a", "b", 1), exp, sig, SECRET) is None)

print("\n── CSS 재작성 ──")
css = rewrite_css("a{background:url('/x.png')} b{behavior:url(#default#x)} @font-face{src:url(f.woff2)} c{background:url(data:image/png;base64,AAA)}",
                  "https://s.example/css/site.css", ASSET, SECRET)
check("상대 url 은 CSS 위치 기준", "https://s.example/x.png" in targets(css, SECRET), str(targets(css, SECRET)))
check("behavior 제거", "behavior" not in css)
check("data: URL 은 그대로", "data:image/png;base64,AAA" in css)
check("폰트도 프록시", css.count(ASSET) >= 2)

print("\n── 빈/깨진 입력 ──")
e = render_page(PAGE, b"", asset_base=ASSET, secret=SECRET)
check("빈 문서도 조립된다", "<html>" in e.html and e.title == "")
b = render_page(PAGE, b"<p>unclosed <b>bold", asset_base=ASSET, secret=SECRET)
check("깨진 HTML 도 복구된다", "bold" in b.text)

print(f"\n{ok} passed, {fail} failed")
sys.exit(1 if fail else 0)

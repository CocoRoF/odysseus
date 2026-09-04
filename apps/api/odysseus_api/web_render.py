"""인터넷 앱의 페이지 렌더링 — 외부 HTML 을 시험장 안에서 안전하게 보여 준다.

원칙은 하나다: **응시자의 브라우저는 외부에 직접 닿지 않는다.** 페이지도, 그
안의 이미지·CSS·폰트도 전부 이 서버가 대신 받아 온다. 그래서 무엇을 찾아봤는지
기록이 남고, 페이지가 응시자 PC 로 무언가를 흘려보낼 수도 없다.

정제 규칙은 허용 목록이다 — 아는 태그·속성만 살리고 나머지는 버린다.
  · script/iframe/object/embed/form/svg/video 등은 내용째 제거
  · on* 속성, javascript: URL, srcdoc, formaction 제거
  · <a href> 는 data-href 로 바꾸고, 우리가 심은 nonce 스크립트 하나가 클릭을
    부모 창(인터넷 앱)에 postMessage 로 넘긴다 — 샌드박스 안에서 스스로 이동할
    방법은 없다
  · <img src/srcset>, CSS 의 url(), <link rel=stylesheet> 는 서명된 프록시 URL 로
    재작성한다. 서명(HMAC)에는 만료가 있어 URL 을 복사해 두어도 오래 못 쓴다
  · CSP <meta> 를 맨 앞에 심어, 정제를 빠져나간 무언가가 있더라도 브라우저가
    막게 한다 (script 는 nonce 만, img/font 는 프록시 오리진만, connect 는 없음)
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import re
import secrets
import time
import urllib.parse
from dataclasses import dataclass, field

from lxml import etree, html as lhtml

# ── 서명된 프록시 URL ─────────────────────────────────────────────

ASSET_TTL_S = 15 * 60  # 서명 URL 은 짧게 산다 — 재생·공유 창을 줄인다 (ODY-020)


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _unb64(text: str) -> bytes:
    pad = "=" * (-len(text) % 4)
    return base64.urlsafe_b64decode(text + pad)


def sign_asset(url: str, secret: str, *, scope: str = "", now: float | None = None) -> tuple[str, str, str]:
    """(u, exp, sig) — 쿼리 파라미터 세 개. 쿠키 없이도 프록시가 요청을 믿을 수 있다.

    scope(응시 id 등)를 서명에 섞는다 — 다른 응시·다른 사용자의 렌더에서 나온 URL 은 여기서 통하지 않는다.
    """
    exp = str(int((now or time.time()) + ASSET_TTL_S))
    u = _b64(url.encode())
    sig = hmac.new(secret.encode(), f"{u}.{exp}.{scope}".encode(), hashlib.sha256).hexdigest()[:32]
    return u, exp, sig


def verify_asset(u: str, exp: str, sig: str, secret: str, *, scope: str = "", now: float | None = None) -> str | None:
    """서명이 맞고 만료 전이면 원래 URL, 아니면 None."""
    try:
        if int(exp) < (now or time.time()):
            return None
    except ValueError:
        return None
    want = hmac.new(secret.encode(), f"{u}.{exp}.{scope}".encode(), hashlib.sha256).hexdigest()[:32]
    if not hmac.compare_digest(want, sig):
        return None
    try:
        return _unb64(u).decode()
    except Exception:  # noqa: BLE001
        return None


def asset_url(asset_base: str, url: str, secret: str, scope: str = "") -> str:
    u, exp, sig = sign_asset(url, secret, scope=scope)
    tail = f"&a={scope}" if scope else ""
    return f"{asset_base}?u={u}&exp={exp}&sig={sig}{tail}"


# ── CSS 재작성 ───────────────────────────────────────────────────

_CSS_URL = re.compile(r"url\(\s*(['\"]?)([^'\")]+)\1\s*\)", re.I)
_CSS_IMPORT = re.compile(r"@import\s+[^;]+;", re.I)
_CSS_DANGER = re.compile(r"(expression\s*\(|behavior\s*:|-moz-binding\s*:|javascript\s*:)", re.I)


def rewrite_css(css: str, base_url: str, asset_base: str, secret: str, scope: str = "") -> str:
    """CSS 안의 url() 을 프록시로, @import 는 제거(외부 연쇄 로드 차단)."""
    css = _CSS_IMPORT.sub("", css)
    css = _CSS_DANGER.sub("/* removed */", css)

    def swap(m: re.Match) -> str:
        raw = m.group(2).strip()
        if raw.startswith("data:"):
            return m.group(0)
        absolute = urllib.parse.urljoin(base_url, raw)
        if not absolute.startswith(("http://", "https://")):
            return "url()"
        return f'url("{asset_url(asset_base, absolute, secret, scope)}")'

    return _CSS_URL.sub(swap, css)


# ── HTML 정제·재작성 ─────────────────────────────────────────────

# 내용째 버리는 태그 — 실행되거나, 바깥으로 나가거나, 그릴 수 없는 것들
DROP_WITH_CONTENT = {
    "script", "noscript", "style", "iframe", "frame", "frameset", "object", "embed",
    "applet", "form", "input", "button", "select", "textarea", "option", "svg", "math",
    "video", "audio", "canvas", "template", "link", "meta", "base", "head", "title",
}
# 태그는 버리되 안의 글은 남기는 것 (span 으로 치환)
UNWRAP = {"font", "center", "marquee", "blink", "label", "fieldset", "legend"}
# 살리는 태그
ALLOWED = {
    "html", "body", "div", "span", "p", "br", "hr", "wbr",
    "h1", "h2", "h3", "h4", "h5", "h6",
    "a", "img", "picture", "source", "figure", "figcaption",
    "ul", "ol", "li", "dl", "dt", "dd",
    "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption", "colgroup", "col",
    "pre", "code", "kbd", "samp", "var", "blockquote", "q", "cite",
    "strong", "b", "em", "i", "u", "s", "small", "sub", "sup", "mark", "abbr", "time", "del", "ins",
    "article", "section", "nav", "aside", "header", "footer", "main", "address",
    "details", "summary",
}
GLOBAL_ATTRS = {"id", "class", "title", "lang", "dir", "style", "role", "hidden", "colspan", "rowspan",
                "align", "valign", "width", "height", "alt", "datetime", "open", "start", "type", "reversed"}
_JS_URL = re.compile(r"^\s*(javascript|vbscript|data:text/html)", re.I)

BASE_STYLE = """
html{color-scheme:light}
body{margin:0;padding:16px 20px;font:15px/1.6 -apple-system,'Segoe UI',Roboto,'Noto Sans KR',sans-serif;color:#1f2937;background:#fff;word-break:break-word}
img,video{max-width:100%;height:auto}
pre{overflow:auto;background:#f6f8fa;padding:12px;border-radius:8px}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.92em}
table{border-collapse:collapse;max-width:100%}
a[data-href]{color:#1d4ed8;cursor:pointer}
[hidden]{display:none!important}
"""

# 링크 클릭·우클릭을 부모(인터넷 앱)로 넘긴다. 원본 스크립트는 전부 사라졌고 CSP 가
# 이 nonce 만 허용하므로, 샌드박스 안에서 도는 코드는 이것뿐이다.
BRIDGE_SCRIPT = """
(function(){
  function post(msg){ try{ parent.postMessage(msg, '*'); }catch(e){} }
  document.addEventListener('click', function(e){
    var a = e.target && e.target.closest ? e.target.closest('a[data-href]') : null;
    if(!a) return;
    e.preventDefault();
    post({type:'odysseus:navigate', url:a.getAttribute('data-href')});
  }, true);
  document.addEventListener('contextmenu', function(e){
    e.preventDefault();
    var a = e.target && e.target.closest ? e.target.closest('a[data-href]') : null;
    var sel = String(window.getSelection ? window.getSelection() : '');
    post({type:'odysseus:contextmenu', x:e.clientX, y:e.clientY, selection:sel, link:a?a.getAttribute('data-href'):null});
  }, true);
  document.addEventListener('keydown', function(e){
    if((e.ctrlKey||e.metaKey) && (e.key==='c'||e.key==='C')){
      var sel = String(window.getSelection ? window.getSelection() : '');
      if(sel) post({type:'odysseus:copy', text:sel});
    }
  }, true);
})();
"""


@dataclass
class RenderResult:
    html: str
    title: str
    text: str
    stylesheets: list[str] = field(default_factory=list)  # 인라인해 달라고 요청할 외부 CSS URL 들
    dropped: dict = field(default_factory=dict)


def _absolute(base: str, raw: str | None) -> str | None:
    if not raw:
        return None
    raw = raw.strip()
    if _JS_URL.match(raw):
        return None
    if raw.startswith("data:"):
        return raw if raw.startswith("data:image/") else None
    absolute = urllib.parse.urljoin(base, raw)
    return absolute if absolute.startswith(("http://", "https://")) else None


def _rewrite_srcset(base: str, srcset: str, asset_base: str, secret: str) -> str | None:
    out = []
    for part in srcset.split(","):
        bits = part.strip().split()
        if not bits:
            continue
        absolute = _absolute(base, bits[0])
        if not absolute:
            continue
        proxied = absolute if absolute.startswith("data:") else asset_url(asset_base, absolute, secret, scope)
        out.append(" ".join([proxied] + bits[1:]))
    return ", ".join(out) or None


def render_page(
    page_url: str,
    raw_html: bytes | str,
    *,
    asset_base: str,
    secret: str,
    inline_css: dict[str, str] | None = None,
    declared_charset: str | None = None,
    scope: str = "",
) -> RenderResult:
    """정제된 전체 HTML 문서를 만든다.

    inline_css 가 없으면 1차 결과에 `stylesheets`(가져와야 할 외부 CSS URL)가
    담긴다. 호출자가 그걸 받아 온 뒤 다시 부르면 <style> 로 심어 준다.
    """
    text_html = _decode_html(raw_html, declared_charset) if isinstance(raw_html, bytes) else raw_html
    text_html = _XML_PROLOG.sub("", text_html, count=1)  # XHTML 프롤로그는 lxml 이 거부한다
    doc = lhtml.document_fromstring(text_html) if text_html.strip() else lhtml.fromstring("<html><body></body></html>")

    title = ""
    title_el = doc.find(".//title")
    if title_el is not None and title_el.text:
        title = " ".join(title_el.text.split())[:200]

    # 원본이 <base href> 로 기준 URL 을 바꿔 두었을 수 있다 — 우리가 절대경로화하므로 무시
    base = page_url
    dropped: dict[str, int] = {}
    stylesheets: list[str] = []
    inline_css = inline_css or {}
    nonce = secrets.token_urlsafe(16)

    # 외부 스타일시트 목록 (head 에서 걷어내기 전에 수집)
    for link in doc.iter("link"):
        rel = (link.get("rel") or "").lower()
        if "stylesheet" in rel:
            absolute = _absolute(base, link.get("href"))
            if absolute and absolute not in stylesheets and len(stylesheets) < 12:
                stylesheets.append(absolute)
    # 인라인 <style> 은 재작성해서 살린다
    inline_styles: list[str] = []
    for st in doc.iter("style"):
        if st.text and len(inline_styles) < 30:
            inline_styles.append(rewrite_css(st.text, base, asset_base, secret, scope)[:200_000])

    body = doc.find("body")
    if body is None:
        body = lhtml.fromstring("<body></body>")
        doc.append(body)

    # ── 정제: 뒤에서 앞으로 돌며 제거/치환 (순회 중 트리 변경 안전) ──
    for el in list(body.iter()):
        if not isinstance(el.tag, str):  # 주석·처리 지시
            parent = el.getparent()
            if parent is not None:
                parent.remove(el)
            continue
        tag = el.tag.lower()
        if tag in DROP_WITH_CONTENT:
            dropped[tag] = dropped.get(tag, 0) + 1
            el.drop_tree()
            continue
        if tag in UNWRAP:
            el.tag = "span"
            tag = "span"
        elif tag not in ALLOWED:
            dropped[tag] = dropped.get(tag, 0) + 1
            el.drop_tag()  # 태그만 벗기고 내용은 남긴다 (custom element 등)
            continue

        # lazy-load 이미지는 src 없이 data-src 만 두는 경우가 많다 — 속성 정리로 지워지기
        # 전에 먼저 챙겨 둔다
        lazy_src = None
        if tag == "img" and not el.get("src"):
            lazy_src = el.get("data-src") or el.get("data-original") or el.get("data-lazy-src")

        # 속성 정리
        for name in list(el.attrib):
            lname = name.lower()
            value = el.get(name) or ""
            if lname.startswith("on") or lname in ("srcdoc", "formaction", "ping", "xlink:href", "background"):
                del el.attrib[name]
                continue
            if lname == "style":
                el.set(name, rewrite_css(value, base, asset_base, secret, scope)[:4000])
                continue
            if lname == "href" and tag == "a":
                absolute = _absolute(base, value)
                del el.attrib[name]
                if absolute and not absolute.startswith("data:"):
                    el.set("data-href", absolute)
                continue
            if lname == "src" and tag in ("img", "source"):
                # lazy-load 자리표시자 대신 실제 주소를 쓰는 사이트가 많다
                real = el.get("data-src") or el.get("data-original") or value
                absolute = _absolute(base, real)
                if absolute:
                    el.set("src", absolute if absolute.startswith("data:") else asset_url(asset_base, absolute, secret, scope))
                else:
                    del el.attrib[name]
                continue
            if lname in ("srcset", "data-srcset") and tag in ("img", "source"):
                rewritten = _rewrite_srcset(base, value, asset_base, secret)
                del el.attrib[name]
                if rewritten:
                    el.set("srcset", rewritten)
                continue
            if lname in GLOBAL_ATTRS or lname.startswith("aria-"):
                continue
            del el.attrib[name]
        if tag == "img" and not el.get("src") and lazy_src:
            absolute = _absolute(base, lazy_src)
            if absolute:
                el.set("src", absolute if absolute.startswith("data:") else asset_url(asset_base, absolute, secret, scope))
        if tag == "img":
            el.set("loading", "lazy")
            el.set("referrerpolicy", "no-referrer")

    # data-* 잔여 제거 (data-href 만 남긴다)
    for el in body.iter():
        if not isinstance(el.tag, str):
            continue
        for name in list(el.attrib):
            if name.startswith("data-") and name != "data-href":
                del el.attrib[name]

    text = " ".join(body.text_content().split())[:120_000]

    # ── 문서 조립 ──
    proxy_origin = urllib.parse.urlsplit(asset_base)
    origin = f"{proxy_origin.scheme}://{proxy_origin.netloc}"
    csp = (
        "default-src 'none'; "
        f"img-src {origin} data:; "
        f"font-src {origin} data:; "
        "style-src 'unsafe-inline'; "
        f"script-src 'nonce-{nonce}'; "
        "connect-src 'none'; frame-src 'none'; media-src 'none'; object-src 'none'; "
        "base-uri 'none'; form-action 'none'"
    )
    head_parts = [
        '<meta charset="utf-8">',
        f'<meta http-equiv="Content-Security-Policy" content="{csp}">',
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
        f"<title>{_esc(title)}</title>",
        f"<style>{BASE_STYLE}</style>",
    ]
    for url in stylesheets:
        css = inline_css.get(url)
        if css:
            head_parts.append(f"<style data-from=\"{_esc(url)}\">{rewrite_css(css, url, asset_base, secret, scope)[:400_000]}</style>")
    for css in inline_styles:
        head_parts.append(f"<style>{css}</style>")
    head_parts.append(f'<script nonce="{nonce}">{BRIDGE_SCRIPT}</script>')

    body_html = etree.tostring(body, encoding="unicode", method="html")
    full = f"<!doctype html><html><head>{''.join(head_parts)}</head>{body_html}</html>"
    return RenderResult(html=full, title=title, text=text, stylesheets=stylesheets, dropped=dropped)


_XML_PROLOG = re.compile(r"^\s*<\?xml[^>]*\?>", re.I)
_META_CHARSET = re.compile(rb"<meta[^>]+charset=[\"']?\s*([A-Za-z0-9_\-]+)", re.I)


def _decode_html(raw: bytes, declared: str | None = None) -> str:
    """바이트 → 문자열. 헤더가 알려 준 charset → <meta charset> → UTF-8 순.

    lxml 에 바이트를 그대로 주면 선언이 없을 때 latin-1 로 읽어 한글이 깨진다
    ("vLLM Docs — Intro" 가 "â" 로 보였다). 우리가 먼저 풀어서 준다.
    """
    candidates = []
    if declared:
        candidates.append(declared)
    m = _META_CHARSET.search(raw[:8192])
    if m:
        candidates.append(m.group(1).decode("ascii", errors="ignore"))
    candidates += ["utf-8", "cp949", "euc-kr"]
    for enc in candidates:
        try:
            return raw.decode(enc)
        except (LookupError, UnicodeDecodeError):
            continue
    return raw.decode("utf-8", errors="replace")


def _esc(text: str) -> str:
    return (
        text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")
    )

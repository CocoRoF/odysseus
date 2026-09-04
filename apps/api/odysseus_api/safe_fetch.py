"""바깥 웹으로 나가는 요청의 단일 통로 (ODY-006, SSRF 방어).

참고자료 프록시는 응시자가 준 URL 을 서버가 대신 연다. 그래서 "어디로 연결되는가" 를
클라이언트 라이브러리에 맡기지 않고 여기서 직접 정한다:

  1. 호스트 이름을 **한 번** 해석하고, 나온 모든 주소가 공인 주소일 때만 진행한다.
     사설·루프백·링크로컬·멀티캐스트·예약·미지정 대역(IPv4/IPv6, IPv4-mapped 포함)은 거부.
  2. 연결은 **해석된 IP 로 직접** 한다. 원래 호스트 이름은 Host 헤더와 TLS SNI/인증서 검증에만
     쓴다 — 검사와 연결 사이에 DNS 가 바뀌어도(rebinding) 검사한 주소로만 간다.
  3. 리다이렉트는 자동으로 따라가지 않는다. 매 hop 마다 스킴·호스트·포트·주소를 다시 검사한다.
  4. 포트는 80/443 만. 프록시 환경변수는 믿지 않는다 (trust_env=False).
  5. 본문은 상한까지만 스트리밍으로 받는다.
  6. 모든 hop 과 거부를 `odysseus.egress` 로거에 남긴다 (URL 은 300자까지).
"""

from __future__ import annotations

import ipaddress
import logging
import socket
import urllib.parse
from dataclasses import dataclass, field

import httpx

log = logging.getLogger("odysseus.egress")

ALLOWED_PORTS = frozenset({80, 443})
MAX_REDIRECTS = 5


class UnsafeUrl(Exception):
    """정책상 열 수 없는 주소. 메시지는 사용자에게 보여 줘도 되는 문장이다."""


@dataclass
class FetchedResponse:
    url: str  # 최종 URL (리다이렉트 뒤)
    status_code: int
    headers: httpx.Headers
    content: bytes
    truncated: bool = False
    hops: list[str] = field(default_factory=list)

    @property
    def charset_encoding(self) -> str | None:
        ctype = self.headers.get("content-type", "")
        for part in ctype.split(";")[1:]:
            k, _, v = part.strip().partition("=")
            if k.lower() == "charset" and v:
                return v.strip().strip('"').strip("'")
        return None

    @property
    def text(self) -> str:
        enc = self.charset_encoding or "utf-8"
        try:
            return self.content.decode(enc, errors="replace")
        except LookupError:
            return self.content.decode("utf-8", errors="replace")


def _ip_is_public(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    return not (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_unspecified
        or (isinstance(ip, ipaddress.IPv6Address) and ip.is_site_local)
    )


def resolve_public(hostname: str) -> list[str]:
    """호스트를 해석해 **모든** 주소가 공인일 때만 주소 목록을 돌려준다."""
    host = hostname.strip().rstrip(".").lower()
    if not host:
        raise UnsafeUrl("주소에 호스트가 없습니다")
    try:
        infos = socket.getaddrinfo(host, None, proto=socket.IPPROTO_TCP)
    except OSError:
        raise UnsafeUrl("주소를 찾을 수 없습니다")
    addrs: list[str] = []
    for info in infos:
        raw = info[4][0]
        try:
            ip = ipaddress.ip_address(raw.split("%", 1)[0])
        except ValueError:
            raise UnsafeUrl("주소를 해석할 수 없습니다")
        if not _ip_is_public(ip):
            raise UnsafeUrl("내부 주소는 열 수 없습니다")
        if raw not in addrs:
            addrs.append(raw)
    if not addrs:
        raise UnsafeUrl("주소를 찾을 수 없습니다")
    return addrs


def check_url(url: str) -> tuple[str, str, int, list[str]]:
    """(스킴, 호스트, 포트, 공인 주소들). 정책 위반이면 UnsafeUrl."""
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise UnsafeUrl("http/https 주소만 열 수 있습니다")
    if parsed.username or parsed.password:
        raise UnsafeUrl("사용자 정보가 든 주소는 열 수 없습니다")
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    addrs = resolve_public(parsed.hostname)  # 주소 검사가 먼저 — 내부 주소는 포트와 무관하게 403
    if port not in ALLOWED_PORTS:
        raise UnsafeUrl("80/443 포트만 열 수 있습니다")
    return parsed.scheme, parsed.hostname, port, addrs


def assert_public_url(url: str) -> str:
    """빠른 사전 검사 — 실제 보호는 safe_get 이 연결 시점에 다시 한다."""
    check_url(url)
    return url


def _pinned_request_url(url: str, ip: str, port: int) -> str:
    """URL 의 호스트를 해석된 IP 로 바꾼 것 — 연결은 이 주소로 간다."""
    parts = urllib.parse.urlsplit(url)
    host = f"[{ip}]" if ":" in ip else ip
    netloc = f"{host}:{port}"
    return urllib.parse.urlunsplit((parts.scheme, netloc, parts.path or "/", parts.query, ""))


async def safe_get(
    url: str,
    *,
    timeout: float = 20.0,
    max_bytes: int = 3 * 1024 * 1024,
    headers: dict | None = None,
    purpose: str = "fetch",
) -> FetchedResponse:
    """정책을 지키며 GET. 리다이렉트는 hop 마다 다시 검사한다. 실패는 httpx.HTTPError 또는 UnsafeUrl."""
    hops: list[str] = []
    current = url
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=False, trust_env=False) as client:
        for _ in range(MAX_REDIRECTS + 1):
            try:
                scheme, host, port, addrs = check_url(current)
            except UnsafeUrl as e:
                log.warning("egress denied purpose=%s url=%s reason=%s hops=%d", purpose, current[:300], e, len(hops))
                raise
            ip = addrs[0]
            hops.append(current)
            req_headers = {"Host": host if port in (80, 443) else f"{host}:{port}", **(headers or {})}
            extensions = {"sni_hostname": host} if scheme == "https" else {}
            pinned = _pinned_request_url(current, ip, port)
            try:
                async with client.stream("GET", pinned, headers=req_headers, extensions=extensions) as resp:
                    log.info("egress purpose=%s url=%s ip=%s status=%s", purpose, current[:300], ip, resp.status_code)
                    if resp.status_code in (301, 302, 303, 307, 308) and resp.headers.get("location"):
                        nxt = urllib.parse.urljoin(current, resp.headers["location"])
                        await resp.aclose()
                        if len(hops) > MAX_REDIRECTS:
                            raise UnsafeUrl("리다이렉트가 너무 많습니다")
                        current = nxt
                        continue
                    chunks: list[bytes] = []
                    got = 0
                    truncated = False
                    async for chunk in resp.aiter_bytes():
                        if got + len(chunk) > max_bytes:
                            chunks.append(chunk[: max_bytes - got])
                            truncated = True
                            break
                        chunks.append(chunk)
                        got += len(chunk)
                    return FetchedResponse(
                        url=current,
                        status_code=resp.status_code,
                        headers=resp.headers,
                        content=b"".join(chunks),
                        truncated=truncated,
                        hops=hops,
                    )
            except httpx.HTTPError as e:
                log.warning("egress failed purpose=%s url=%s ip=%s error=%s", purpose, current[:300], ip, type(e).__name__)
                raise
    raise UnsafeUrl("리다이렉트가 너무 많습니다")

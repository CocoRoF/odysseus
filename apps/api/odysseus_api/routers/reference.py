"""참고 자료 표면 — GitHub 앱과 인터넷(웹 검색) 앱의 백엔드.

시험 환경은 네트워크가 차단된 러너 위에서 돌지만, 실무에서는 문서를 찾아보는 것이
당연하다. 그래서 **API 서버가 대리 조회**해 주는 좁은 통로를 둔다:

  · GitHub — 저장소 검색 / 코드 열람 / `git clone`(워크스페이스로 물질화)
  · 인터넷 — 웹 검색과 읽기 전용 페이지 보기

임의의 호스트로 나가지 않도록 GitHub 경로는 서버가 조립하고, 페이지 열람은
스킴·사설 IP를 검사한다. 조회 행위는 이벤트로 남아 평가 자료가 된다.
"""

import asyncio
import io
import ipaddress
import re
import socket
import tarfile
import time
import urllib.parse
import uuid
from html import unescape

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy.ext.asyncio import AsyncSession

from .. import workspace as ws
from ..config import settings as app_settings
from ..db import get_db
from ..deps import get_current_user
from ..models import AppSetting, Attempt, Event, User
from .attempts import get_attempt_for, require_own_active, scenario_in_attempt

router = APIRouter(tags=["reference"])

# ── 설정 ─────────────────────────────────────────────────────────

REFERENCE_KEY = "reference"
REFERENCE_DEFAULTS: dict = {
    "github_enabled": True,
    "github_token": "",          # 없으면 비인증(시간당 60회 제한)
    "web_enabled": True,
    "search_provider": "duckduckgo",  # duckduckgo | google
    "search_api_key": "",        # google Custom Search API key
    "search_cx": "",             # google Custom Search engine id
}


async def get_reference_settings(db: AsyncSession) -> dict:
    row = await db.get(AppSetting, REFERENCE_KEY)
    return {**REFERENCE_DEFAULTS, **(row.value if row else {})}


# ── 응답 캐시 (호출 절약 + 레이트리밋 회피) ───────────────────────

_CACHE: dict[str, tuple[float, object]] = {}
_CACHE_TTL_S = 300.0
_CACHE_MAX = 400


def _cache_get(key: str):
    hit = _CACHE.get(key)
    if not hit:
        return None
    ts, value = hit
    if time.time() - ts > _CACHE_TTL_S:
        _CACHE.pop(key, None)
        return None
    return value


def _cache_put(key: str, value) -> None:
    if len(_CACHE) >= _CACHE_MAX:
        _CACHE.pop(next(iter(_CACHE)), None)
    _CACHE[key] = (time.time(), value)


# ── 공통 ─────────────────────────────────────────────────────────

UA = "odysseus-exam/1.0 (reference browser)"
GITHUB_API = "https://api.github.com"
NAME_RE = re.compile(r"^[A-Za-z0-9._-]{1,100}$")


def _check_name(*parts: str) -> None:
    for p in parts:
        if not NAME_RE.match(p or ""):
            raise HTTPException(400, f"허용되지 않는 이름입니다: {p!r}")


async def _github_get(path: str, settings_row: dict, *, params: dict | None = None) -> object:
    """GitHub REST 호출 — 경로는 서버가 조립하므로 임의 호스트로 나가지 않는다."""
    key = f"gh:{path}:{sorted((params or {}).items())}"
    cached = _cache_get(key)
    if cached is not None:
        return cached
    headers = {"Accept": "application/vnd.github+json", "User-Agent": UA}
    token = (settings_row.get("github_token") or "").strip()
    if token:
        headers["Authorization"] = f"Bearer {token}"
    try:
        # 이름이 바뀐 저장소는 301 로 새 경로를 알려준다 — 따라가야 정식 이름을 얻는다
        async with httpx.AsyncClient(timeout=20, follow_redirects=True) as client:
            resp = await client.get(f"{GITHUB_API}{path}", headers=headers, params=params)
    except httpx.HTTPError as e:
        raise HTTPException(502, f"GitHub에 연결할 수 없습니다: {e}")
    if resp.status_code == 403 and "rate limit" in resp.text.lower():
        raise HTTPException(429, "GitHub 조회 한도를 초과했습니다. 잠시 후 다시 시도하세요")
    if resp.status_code == 404:
        raise HTTPException(404, "GitHub에서 찾을 수 없습니다")
    if resp.status_code >= 400:
        raise HTTPException(502, f"GitHub 오류 ({resp.status_code})")
    data = resp.json()
    _cache_put(key, data)
    return data


async def _log(
    db: AsyncSession,
    user: User,
    attempt_id: uuid.UUID | None,
    scenario_id: uuid.UUID | None,
    type_: str,
    payload: dict,
) -> None:
    """응시 중이라면 조회 행위를 기록 — '무엇을 찾아봤는가'가 평가 자료가 된다."""
    if not attempt_id:
        return
    attempt = await db.get(Attempt, attempt_id)
    if not attempt or attempt.user_id != user.id or attempt.status != "in_progress":
        return
    db.add(Event(attempt_id=attempt_id, scenario_id=scenario_id, type=type_, payload=payload))
    await db.commit()


# ── 실행 환경 스펙 ([컴퓨터 정보] 화면) ─────────────────────────

RUNNER_ENV_KEY = "odysseus:runner:env"


@router.get("/reference/system")
async def system_info(_: User = Depends(get_current_user)):
    """워크스테이션 사양 — 러너가 뜰 때 스스로 조사해 Redis 에 올려 둔 것을 읽는다.

    설치 목록을 여기에 적어 두면 이미지와 어긋난다. 실제로 조사한 값만 보여준다.
    """
    from ..runqueue import get_redis

    try:
        raw = await get_redis().get(RUNNER_ENV_KEY)
    except Exception:
        raw = None
    if not raw:
        raise HTTPException(503, "실행 환경 정보를 아직 수집하지 못했습니다")
    import json as _json

    spec = _json.loads(raw)
    # 응시자에게는 **자기 작업 공간**의 사양만 보여준다. 호스트의 커널·코어 수·
    # 총 메모리는 시험과 무관한 서버 내부 정보이므로 내보내지 않는다.
    return {
        "os": spec.get("os"),
        "isolated": spec.get("isolated", False),
        "languages": spec.get("languages", []),
        "shells": spec.get("shells", []),
        "tools": spec.get("tools", []),
        "python_packages": spec.get("python_packages", []),
        "limits": spec.get("limits", {}),
    }


# ── 설정 조회 (응시자도 필요) ────────────────────────────────────


@router.get("/reference/config")
async def reference_config(_: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    s = await get_reference_settings(db)
    return {
        "github_enabled": bool(s["github_enabled"]),
        "web_enabled": bool(s["web_enabled"]),
        "search_provider": s["search_provider"],
    }


# ── GitHub ───────────────────────────────────────────────────────


def _repo_brief(r: dict) -> dict:
    return {
        "full_name": r.get("full_name"),
        "owner": (r.get("owner") or {}).get("login"),
        "name": r.get("name"),
        "description": r.get("description"),
        "language": r.get("language"),
        "stars": r.get("stargazers_count", 0),
        "forks": r.get("forks_count", 0),
        "watchers": r.get("subscribers_count", r.get("watchers_count", 0)),
        "topics": r.get("topics") or [],
        "updated_at": r.get("pushed_at") or r.get("updated_at"),
        "archived": bool(r.get("archived")),
        "default_branch": r.get("default_branch") or "main",
        "html_url": r.get("html_url"),
        "homepage": r.get("homepage"),
        "license": ((r.get("license") or {}) or {}).get("spdx_id"),
        "avatar": (r.get("owner") or {}).get("avatar_url"),
    }


@router.get("/reference/github/search")
async def github_search(
    q: str = Query(min_length=1, max_length=200),
    page: int = Query(1, ge=1, le=10),
    attempt_id: uuid.UUID | None = None,
    scenario_id: uuid.UUID | None = None,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    s = await get_reference_settings(db)
    if not s["github_enabled"]:
        raise HTTPException(403, "이 시험에서는 GitHub 조회가 비활성화되어 있습니다")
    data = await _github_get(
        "/search/repositories", s, params={"q": q, "per_page": 20, "page": page}
    )
    await _log(db, user, attempt_id, scenario_id, "reference_search", {"source": "github", "q": q[:200]})
    return {
        "total": data.get("total_count", 0),
        "items": [_repo_brief(r) for r in data.get("items", [])],
    }


@router.get("/reference/github/repo")
async def github_repo(
    owner: str,
    name: str,
    attempt_id: uuid.UUID | None = None,
    scenario_id: uuid.UUID | None = None,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    _check_name(owner, name)
    s = await get_reference_settings(db)
    if not s["github_enabled"]:
        raise HTTPException(403, "이 시험에서는 GitHub 조회가 비활성화되어 있습니다")
    repo = await _github_get(f"/repos/{owner}/{name}", s)
    brief = _repo_brief(repo)
    readme = None
    try:
        raw = await _github_get(f"/repos/{owner}/{name}/readme", s)
        import base64

        if raw.get("encoding") == "base64":
            readme = {
                "path": raw.get("path"),
                "content": base64.b64decode(raw.get("content", "")).decode("utf-8", errors="replace")[:200_000],
            }
    except HTTPException:
        readme = None
    await _log(
        db, user, attempt_id, scenario_id, "reference_open",
        {"source": "github", "repo": brief["full_name"]},
    )
    return {"repo": brief, "readme": readme}


@router.get("/reference/github/tree")
async def github_tree(
    owner: str,
    name: str,
    path: str = "",
    ref: str = "",
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    _check_name(owner, name)
    s = await get_reference_settings(db)
    if not s["github_enabled"]:
        raise HTTPException(403, "이 시험에서는 GitHub 조회가 비활성화되어 있습니다")
    clean = "/".join(seg for seg in path.split("/") if seg and seg not in (".", ".."))
    params = {"ref": ref} if ref else None
    data = await _github_get(f"/repos/{owner}/{name}/contents/{clean}", s, params=params)
    if isinstance(data, dict):  # 파일 하나를 가리킨 경우
        return {"path": clean, "entries": [], "file": data.get("path")}
    entries = [
        {"name": e.get("name"), "path": e.get("path"), "type": e.get("type"), "size": e.get("size", 0)}
        for e in data
    ]
    entries.sort(key=lambda e: (e["type"] != "dir", e["name"].lower()))
    return {"path": clean, "entries": entries}


@router.get("/reference/github/file")
async def github_file(
    owner: str,
    name: str,
    path: str = Query(min_length=1),
    ref: str = "",
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    import base64

    _check_name(owner, name)
    s = await get_reference_settings(db)
    if not s["github_enabled"]:
        raise HTTPException(403, "이 시험에서는 GitHub 조회가 비활성화되어 있습니다")
    clean = "/".join(seg for seg in path.split("/") if seg and seg not in (".", ".."))
    params = {"ref": ref} if ref else None
    data = await _github_get(f"/repos/{owner}/{name}/contents/{clean}", s, params=params)
    if isinstance(data, list):
        raise HTTPException(400, "디렉터리입니다")
    if data.get("encoding") != "base64":
        raise HTTPException(415, "표시할 수 없는 파일입니다")
    raw = base64.b64decode(data.get("content", ""))
    if b"\x00" in raw[:4096]:
        raise HTTPException(415, "바이너리 파일은 표시할 수 없습니다")
    return {
        "path": data.get("path"),
        "size": data.get("size", 0),
        "content": raw.decode("utf-8", errors="replace")[:400_000],
    }


# ── git clone → 워크스페이스 물질화 ──────────────────────────────

CLONE_MAX_FILES = 300
CLONE_MAX_FILE_BYTES = 256 * 1024
CLONE_MAX_TOTAL_BYTES = 4 * 1024 * 1024
CLONE_SKIP_DIRS = {".git", "node_modules", "__pycache__", ".venv", "dist", "build", ".next"}
CLONE_SKIP_EXT = {
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".svg", ".pdf", ".zip", ".gz", ".tar",
    ".woff", ".woff2", ".ttf", ".eot", ".mp4", ".mp3", ".wav", ".so", ".dll", ".dylib",
    ".exe", ".bin", ".class", ".jar", ".pyc", ".wasm",
}


def _extract_tar(blob: bytes) -> tuple[list[tuple[str, str]], dict]:
    """tar.gz → [(경로, 내용)]. 텍스트 파일만, 상한을 넘으면 건너뛴다."""
    files: list[tuple[str, str]] = []
    stats = {"skipped_binary": 0, "skipped_large": 0, "truncated": False}
    total = 0
    with tarfile.open(fileobj=io.BytesIO(blob), mode="r:gz") as tar:
        for member in tar:
            if not member.isfile():
                continue
            parts = member.name.split("/")[1:]  # 최상위 <repo>-<sha>/ 제거
            if not parts:
                continue
            if any(p in CLONE_SKIP_DIRS for p in parts[:-1]):
                continue
            rel = "/".join(parts)
            if any(rel.lower().endswith(ext) for ext in CLONE_SKIP_EXT):
                stats["skipped_binary"] += 1
                continue
            if member.size > CLONE_MAX_FILE_BYTES:
                stats["skipped_large"] += 1
                continue
            if len(files) >= CLONE_MAX_FILES or total + member.size > CLONE_MAX_TOTAL_BYTES:
                stats["truncated"] = True
                break
            fh = tar.extractfile(member)
            if not fh:
                continue
            raw = fh.read()
            if b"\x00" in raw[:4096]:
                stats["skipped_binary"] += 1
                continue
            files.append((rel, raw.decode("utf-8", errors="replace")))
            total += member.size
    return files, stats


CLONE_ROOT = "github"


@router.post("/attempts/{attempt_id}/scenarios/{scenario_id}/github/clone")
async def github_clone(
    attempt_id: uuid.UUID,
    scenario_id: uuid.UUID,
    owner: str,
    name: str,
    ref: str = "",
    dest: str = "",
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """저장소를 워크스페이스로 가져온다 (러너에는 네트워크가 없으므로 서버가 대신 받는다)."""
    _check_name(owner, name)
    attempt = await require_own_active(attempt_id, user, db)
    await scenario_in_attempt(attempt, scenario_id, db, user, mutate=True)
    s = await get_reference_settings(db)
    if not s["github_enabled"]:
        raise HTTPException(403, "이 시험에서는 GitHub 조회가 비활성화되어 있습니다")

    repo = await _github_get(f"/repos/{owner}/{name}", s)
    # 이름이 바뀐 저장소는 API 가 새 경로로 알려준다 — 아카이브는 정식 이름으로 받아야 한다
    canonical = (repo.get("full_name") or f"{owner}/{name}").split("/")
    c_owner, c_name = (canonical + [name])[:2]
    branch = ref or repo.get("default_branch") or "main"
    quoted = urllib.parse.quote(branch)
    base = f"https://codeload.github.com/{c_owner}/{c_name}/tar.gz"
    resp = None
    try:
        async with httpx.AsyncClient(timeout=60, follow_redirects=True) as client:
            for candidate in (f"{base}/refs/heads/{quoted}", f"{base}/refs/tags/{quoted}", f"{base}/{quoted}"):
                resp = await client.get(candidate, headers={"User-Agent": UA})
                if resp.status_code < 400:
                    break
    except httpx.HTTPError as e:
        raise HTTPException(502, f"저장소를 내려받지 못했습니다: {e}")
    if resp is None or resp.status_code >= 400:
        raise HTTPException(502, f"'{branch}' 를 내려받지 못했습니다 ({resp.status_code if resp else '연결 실패'})")

    # 참고 저장소는 워크스페이스의 github/<repo> 아래 모인다 — 터미널의 `git clone` 도 같은 규약
    root = ws.normalize_path(dest.strip() or f"{CLONE_ROOT}/{c_name}")
    existing = await ws.list_files(db, attempt_id, scenario_id)
    if any(f.path.startswith(root + "/") for f in existing):
        raise HTTPException(
            409, f"fatal: destination path '{root}' already exists and is not an empty directory."
        )
    files, stats = await asyncio.to_thread(_extract_tar, resp.content)
    written = 0
    # 왜 잘렸는지는 구분해서 알린다 — 저장소가 큰 것과 워크스페이스가 찬 것은 다른 문제다
    limit = "repo" if stats["truncated"] else ""
    for rel, content in files:
        try:
            await ws.save_file(
                db, attempt_id, scenario_id, f"{root}/{rel}", content, actor="git", record_event=False
            )
            written += 1
        except ws.WorkspaceError:
            limit = "workspace"
            stats["truncated"] = True
            break
    db.add(
        Event(
            attempt_id=attempt_id,
            scenario_id=scenario_id,
            type="github_clone",
            payload={"repo": f"{owner}/{name}", "ref": branch, "dest": root, "files": written},
        )
    )
    await db.commit()
    return {
        "repo": f"{c_owner}/{c_name}",
        "dest": root,
        "ref": branch,
        "files": written,
        "skipped_binary": stats["skipped_binary"],
        "skipped_large": stats["skipped_large"],
        "truncated": stats["truncated"],
        "limit": limit,
        "commit": (repo.get("default_branch") or branch),
    }


# ── 인터넷 (웹 검색 + 읽기 전용 페이지) ──────────────────────────

_DDG_RESULT = re.compile(
    r'<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="(?P<href>[^"]+)"[^>]*>(?P<title>.*?)</a>'
    r'.*?class="[^"]*result__snippet[^"]*"[^>]*>(?P<snippet>.*?)</a>',
    re.S,
)
_TAG = re.compile(r"<[^>]+>")


def _strip(html: str) -> str:
    return unescape(_TAG.sub("", html)).strip()


def _ddg_link(href: str) -> str:
    if href.startswith("//"):
        href = "https:" + href
    parsed = urllib.parse.urlparse(href)
    if parsed.netloc.endswith("duckduckgo.com") and parsed.path.startswith("/l/"):
        qs = urllib.parse.parse_qs(parsed.query)
        return (qs.get("uddg") or [href])[0]
    return href


async def _search_duckduckgo(q: str) -> list[dict]:
    async with httpx.AsyncClient(timeout=20, follow_redirects=True) as client:
        resp = await client.get(
            "https://html.duckduckgo.com/html/",
            params={"q": q},
            headers={"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36"},
        )
    out = []
    for m in _DDG_RESULT.finditer(resp.text):
        link = _ddg_link(unescape(m.group("href")))
        out.append({"title": _strip(m.group("title")), "url": link, "snippet": _strip(m.group("snippet"))})
        if len(out) >= 15:
            break
    return out


async def _search_google(q: str, key: str, cx: str) -> list[dict]:
    async with httpx.AsyncClient(timeout=20) as client:
        resp = await client.get(
            "https://www.googleapis.com/customsearch/v1",
            params={"key": key, "cx": cx, "q": q, "num": 10},
        )
    if resp.status_code >= 400:
        raise HTTPException(502, f"검색 API 오류 ({resp.status_code})")
    return [
        {"title": it.get("title", ""), "url": it.get("link", ""), "snippet": it.get("snippet", "")}
        for it in resp.json().get("items", [])
    ]


@router.get("/reference/web/search")
async def web_search(
    q: str = Query(min_length=1, max_length=300),
    attempt_id: uuid.UUID | None = None,
    scenario_id: uuid.UUID | None = None,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    s = await get_reference_settings(db)
    if not s["web_enabled"]:
        raise HTTPException(403, "이 시험에서는 웹 검색이 비활성화되어 있습니다")
    key = f"web:{s['search_provider']}:{q}"
    results = _cache_get(key)
    if results is None:
        try:
            if s["search_provider"] == "google" and s["search_api_key"] and s["search_cx"]:
                results = await _search_google(q, s["search_api_key"], s["search_cx"])
            else:
                results = await _search_duckduckgo(q)
        except httpx.HTTPError as e:
            raise HTTPException(502, f"검색에 실패했습니다: {e}")
        _cache_put(key, results)
    await _log(db, user, attempt_id, scenario_id, "reference_search", {"source": "web", "q": q[:200]})
    return {"provider": s["search_provider"], "results": results}


def _is_public_url(url: str) -> str:
    """스킴·사설 IP 검사 — 내부망으로 나가는 요청을 막는다."""
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise HTTPException(400, "http/https 주소만 열 수 있습니다")
    try:
        infos = socket.getaddrinfo(parsed.hostname, None)
    except OSError:
        raise HTTPException(400, "주소를 찾을 수 없습니다")
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved:
            raise HTTPException(403, "내부 주소는 열 수 없습니다")
    return url


_SCRIPT_STYLE = re.compile(r"<(script|style|noscript|svg)[^>]*>.*?</\1>", re.S | re.I)
_BLOCK_END = re.compile(r"</(p|div|section|article|li|h[1-6]|tr|blockquote|pre)>", re.I)
_BR = re.compile(r"<br\s*/?>", re.I)
_TITLE = re.compile(r"<title[^>]*>(.*?)</title>", re.S | re.I)


@router.get("/reference/web/page")
async def web_page(
    url: str = Query(min_length=8, max_length=2000),
    attempt_id: uuid.UUID | None = None,
    scenario_id: uuid.UUID | None = None,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """읽기 전용 페이지 보기 — 스크립트를 걷어낸 텍스트만 돌려준다."""
    s = await get_reference_settings(db)
    if not s["web_enabled"]:
        raise HTTPException(403, "이 시험에서는 웹 열람이 비활성화되어 있습니다")
    _is_public_url(url)
    cached = _cache_get(f"page:{url}")
    if cached is None:
        try:
            async with httpx.AsyncClient(timeout=25, follow_redirects=True, max_redirects=5) as client:
                resp = await client.get(
                    url,
                    headers={"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36"},
                )
        except httpx.HTTPError as e:
            raise HTTPException(502, f"페이지를 열 수 없습니다: {e}")
        ctype = resp.headers.get("content-type", "")
        if "html" not in ctype and "text" not in ctype:
            raise HTTPException(415, f"열 수 없는 형식입니다 ({ctype.split(';')[0] or '알 수 없음'})")
        html = resp.text[:2_000_000]
        title_m = _TITLE.search(html)
        body = _SCRIPT_STYLE.sub(" ", html)
        body = _BR.sub("\n", body)
        body = _BLOCK_END.sub("\n\n", body)
        text = unescape(_TAG.sub("", body))
        text = re.sub(r"[ \t]+", " ", text)
        text = re.sub(r"\n{3,}", "\n\n", text).strip()[:120_000]
        cached = {
            "url": str(resp.url),
            "title": _strip(title_m.group(1)) if title_m else str(resp.url),
            "text": text,
        }
        _cache_put(f"page:{url}", cached)
    await _log(db, user, attempt_id, scenario_id, "reference_open", {"source": "web", "url": url[:300]})
    return cached


# ── 인터넷: 실제 렌더링 (정제된 HTML + 서명된 자산 프록시) ─────────

_BROWSER_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
_ASSET_BASE_RE = re.compile(r"^https?://[A-Za-z0-9.\-]+(?::\d+)?(?:/[A-Za-z0-9._\-]+)*/reference/web/asset$")
_ASSET_TYPES = ("image/", "font/", "text/css", "application/font", "application/x-font", "application/octet-stream")
_ASSET_MAX = 6 * 1024 * 1024
_PAGE_MAX = 3 * 1024 * 1024
_CSS_MAX = 600 * 1024


async def _fetch_css_bundle(urls: list[str]) -> dict[str, str]:
    """외부 스타일시트를 병렬로 받아 온다. 하나가 실패해도 나머지는 살린다."""
    import asyncio as _aio

    async def one(client: httpx.AsyncClient, url: str) -> tuple[str, str]:
        try:
            _is_public_url(url)
            r = await client.get(url, headers={"User-Agent": _BROWSER_UA})
            if r.status_code < 400 and "css" in r.headers.get("content-type", "text/css"):
                return url, r.text[:_CSS_MAX]
        except Exception:  # noqa: BLE001
            pass
        return url, ""

    async with httpx.AsyncClient(timeout=10, follow_redirects=True) as client:
        pairs = await _aio.gather(*(one(client, u) for u in urls))
    return {u: css for u, css in pairs if css}


@router.get("/reference/web/render")
async def web_render(
    url: str = Query(min_length=8, max_length=2000),
    asset_base: str = Query(min_length=16, max_length=400),
    attempt_id: uuid.UUID | None = None,
    scenario_id: uuid.UUID | None = None,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """페이지를 받아 정제·재작성한 완전한 HTML 문서를 돌려준다 (샌드박스 iframe 용).

    asset_base 는 클라이언트가 자기 오리진으로 만든 프록시 주소다 — 서버는 어떤
    도메인 뒤에 있는지 모르므로 클라이언트가 알려 준다. 형태만 검사한다.
    """
    from ..web_render import render_page

    s = await get_reference_settings(db)
    if not s["web_enabled"]:
        raise HTTPException(403, "이 시험에서는 웹 열람이 비활성화되어 있습니다")
    if not _ASSET_BASE_RE.match(asset_base):
        raise HTTPException(400, "asset_base 형식이 올바르지 않습니다")
    _is_public_url(url)

    global _LAST_ASSET_BASE
    _LAST_ASSET_BASE = asset_base
    cache_key = f"render:{url}:{asset_base}"
    cached = _cache_get(cache_key)
    if cached is None:
        try:
            async with httpx.AsyncClient(timeout=25, follow_redirects=True, max_redirects=5) as client:
                resp = await client.get(url, headers={"User-Agent": _BROWSER_UA, "Accept-Language": "ko,en;q=0.8"})
        except httpx.HTTPError as e:
            raise HTTPException(502, f"페이지를 열 수 없습니다: {e}")
        ctype = resp.headers.get("content-type", "")
        if "html" not in ctype and "xml" not in ctype:
            raise HTTPException(415, f"열 수 없는 형식입니다 ({ctype.split(';')[0] or '알 수 없음'})")
        final_url = str(resp.url)
        _is_public_url(final_url)  # 리다이렉트 끝도 검사한다
        raw = resp.content[:_PAGE_MAX]

        charset = resp.charset_encoding  # Content-Type 헤더의 charset (없으면 None)
        first = render_page(final_url, raw, asset_base=asset_base, secret=app_settings.jwt_secret, declared_charset=charset)
        css = await _fetch_css_bundle(first.stylesheets) if first.stylesheets else {}
        result = render_page(
            final_url, raw, asset_base=asset_base, secret=app_settings.jwt_secret,
            inline_css=css, declared_charset=charset,
        )
        cached = {
            "url": final_url,
            "title": result.title or final_url,
            "html": result.html,
            "text": result.text,
            "stylesheets": len(css),
            "dropped": result.dropped,
        }
        _cache_put(cache_key, cached)
    await _log(db, user, attempt_id, scenario_id, "reference_open", {"source": "web", "url": url[:300]})
    return cached


_ASSET_CACHE: dict[str, tuple[float, bytes, str]] = {}
_ASSET_CACHE_MAX = 200


@router.get("/reference/web/asset")
async def web_asset(u: str, exp: str, sig: str):
    """서명된 자산 프록시 — 이미지·CSS·폰트만. 쿠키가 아니라 서명으로 인증한다.

    샌드박스 iframe 은 출처가 불투명해 쿠키가 실리지 않을 수 있다. 렌더 단계에서
    서버가 서명해 둔 URL 만 통과시키므로, 임의 주소를 이 프록시로 끌어올 수 없다.
    """
    from ..web_render import rewrite_css, verify_asset

    target = verify_asset(u, exp, sig, app_settings.jwt_secret)
    if not target:
        raise HTTPException(403, "서명이 맞지 않거나 만료되었습니다")
    _is_public_url(target)

    hit = _ASSET_CACHE.get(target)
    if hit and time.time() - hit[0] < _CACHE_TTL_S:
        body, ctype = hit[1], hit[2]
    else:
        try:
            async with httpx.AsyncClient(timeout=20, follow_redirects=True, max_redirects=5) as client:
                resp = await client.get(target, headers={"User-Agent": _BROWSER_UA, "Referer": target})
        except httpx.HTTPError:
            raise HTTPException(502, "자산을 받지 못했습니다")
        if resp.status_code >= 400:
            raise HTTPException(resp.status_code if resp.status_code in (403, 404) else 502, "자산을 받지 못했습니다")
        ctype = (resp.headers.get("content-type") or "").split(";")[0].strip().lower()
        if not any(ctype.startswith(t) for t in _ASSET_TYPES):
            raise HTTPException(415, "허용되지 않는 자산 형식입니다")
        body = resp.content[:_ASSET_MAX]
        if ctype == "text/css":
            # CSS 안의 url() 도 프록시를 지나야 한다 — asset_base 는 이 요청의 경로에서 복원
            base = urllib.parse.urlsplit(target)
            body = rewrite_css(body.decode("utf-8", errors="replace"), target, _asset_base_hint(), app_settings.jwt_secret).encode()
        if len(_ASSET_CACHE) >= _ASSET_CACHE_MAX:
            _ASSET_CACHE.pop(next(iter(_ASSET_CACHE)), None)
        _ASSET_CACHE[target] = (time.time(), body, ctype)

    return Response(
        content=body,
        media_type=ctype or "application/octet-stream",
        headers={
            "Cache-Control": "private, max-age=3600",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "sandbox",
            # 샌드박스 iframe 은 출처가 'null' 이다. 이미지는 괜찮지만 **폰트는 CORS 요청**이라
            # 이 헤더가 없으면 막힌다. 서명된 URL 로만 열리는 공개 자산이므로 * 가 안전하다.
            "Access-Control-Allow-Origin": "*",
        },
    )


_LAST_ASSET_BASE: str | None = None


def _asset_base_hint() -> str:
    # CSS 안 url() 재작성용 — 마지막 렌더가 쓴 asset_base 를 재사용한다 (단일 배포 전제)
    return _LAST_ASSET_BASE or "/reference/web/asset"

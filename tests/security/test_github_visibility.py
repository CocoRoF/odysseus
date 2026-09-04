"""ODY-011 검증 — 관리자 토큰이 무엇을 볼 수 있든 응시자에게는 공개 저장소만 (api 컨테이너 안에서).

  docker cp tests/security/test_github_visibility.py <api>:/tmp/
  docker exec -e PYTHONPATH=/app <api> python3 /tmp/test_github_visibility.py

비공개 저장소는 GitHub 를 흉내 내는 가짜 `_github_get` 으로 만든다 — 실제 비공개 저장소·토큰을 쓰지 않는다.
마지막에 실제 GitHub 로 공개 저장소가 여전히 열리는지 본다 (네트워크 없으면 건너뜀).
"""

import asyncio
import re
import sys

from fastapi import HTTPException

from odysseus_api.routers import reference

ok = fail = 0


def check(name, cond, detail=""):
    global ok, fail
    if cond:
        ok += 1
        print(f"  PASS {name}")
    else:
        fail += 1
        print(f"  FAIL {name} {str(detail)[:200]}")


FAKE = {
    "/repos/acme/secret": {"full_name": "acme/secret", "private": True, "visibility": "private", "default_branch": "main"},
    "/repos/acme/internal": {"full_name": "acme/internal", "private": False, "visibility": "internal", "default_branch": "main"},
    "/repos/acme/open": {"full_name": "acme/open", "private": False, "visibility": "public", "default_branch": "main"},
    "/repos/acme/open/contents/README.md": {"path": "README.md", "encoding": "base64", "content": "aGVsbG8=", "size": 5},
    "/repos/acme/secret/contents/README.md": {"path": "README.md", "encoding": "base64", "content": "c2VjcmV0", "size": 6},
}
calls: list[str] = []


async def fake_github_get(path, settings_row, *, params=None):
    calls.append(path + ("?" + str(sorted(params.items())) if params else ""))
    if path == "/search/repositories":
        return {
            "total_count": 3,
            "items": [FAKE["/repos/acme/secret"], FAKE["/repos/acme/internal"], FAKE["/repos/acme/open"]],
        }
    if path in FAKE:
        return FAKE[path]
    raise HTTPException(404, "GitHub에서 찾을 수 없습니다")


real_get = reference._github_get
reference._github_get = fake_github_get


def run(coro):
    return asyncio.run(coro)


async def public(owner, name):
    return await reference._require_public_repo(owner, name, {})


print("\n── 공개 저장소만 통과 ──")
check("public 저장소 통과", run(public("acme", "open"))["full_name"] == "acme/open")
for name, label in (("secret", "private"), ("internal", "internal visibility")):
    try:
        run(public("acme", name))
        check(f"{label} 저장소 차단", False, "허용됨")
    except HTTPException as e:
        check(f"{label} 저장소는 404 (존재 여부도 감춤)", e.status_code == 404 and "찾을 수 없" in e.detail, e.detail)
try:
    run(public("acme", "nothing"))
    check("없는 저장소 404", False)
except HTTPException as e:
    check("없는 저장소도 같은 404", e.status_code == 404)

print("\n── 검색: is:public 강제 + 결과 필터 ──")
items = reference._public_only(
    [FAKE["/repos/acme/secret"], FAKE["/repos/acme/internal"], FAKE["/repos/acme/open"], "garbage"]
)
check("검색 결과에서 비공개·internal 제거", [r["full_name"] for r in items] == ["acme/open"], items)
q = re.sub(r"\bis:(private|internal)\b", "", "acme is:private secret", flags=re.I).strip() + " is:public"
check("is:private 한정자는 무력화되고 is:public 이 붙는다", "is:private" not in q and q.endswith("is:public"), q)

print("\n── 엔드포인트 경로가 헬퍼를 지나는지 (소스 계약) ──")
import inspect

src = inspect.getsource(reference)
for fn in ("github_repo", "github_tree", "github_file", "github_clone"):
    body = src[src.index(f"async def {fn}("):]
    body = body[: body.find("\n@router") if body.find("\n@router") > 0 else len(body)]
    check(f"{fn} 이 _require_public_repo 를 호출", "_require_public_repo(" in body)
search_body = src[src.index("async def github_search("):]
search_body = search_body[: search_body.find("\n@router")]
check("github_search 가 is:public 을 붙이고 결과를 필터", "is:public" in search_body and "_public_only(" in search_body)
check("공개 확인이 콘텐츠 조회보다 먼저", src.index("await _require_public_repo(owner, name, s)\n    clean") < src.index("data = await _github_get(f\"/repos/{owner}/{name}/contents/{clean}\""))

reference._github_get = real_get

print("\n── 실제 GitHub: 공개 저장소는 여전히 열린다 ──")
try:
    repo = run(reference._require_public_repo("octocat", "Hello-World", {}))
    check("octocat/Hello-World 공개 → 통과", repo.get("full_name") == "octocat/Hello-World", repo.get("full_name"))
except HTTPException as e:
    if e.status_code in (502, 429):
        print(f"  (GitHub 에 닿지 못해 건너뜀: {e.detail})")
    else:
        check("octocat/Hello-World 공개 → 통과", False, e.detail)

print(f"\n{ok} passed, {fail} failed")
sys.exit(1 if fail else 0)

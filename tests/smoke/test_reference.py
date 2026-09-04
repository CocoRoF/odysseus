"""참고 자료 표면 E2E — GitHub / 인터넷 / clone (api 컨테이너 안에서 실행).

실제 github.com 과 검색 엔진에 나간다. 네트워크가 막힌 환경에서는 해당 항목이
실패하므로, 계약(권한·경계·기록)과 외부 연동을 나눠 표시한다.

  docker cp tests/smoke/test_reference.py odysseus-api-1:/tmp/
  docker exec -e PYTHONPATH=/app odysseus-api-1 python3 /tmp/test_reference.py
"""

import json
import sys
import urllib.error
import urllib.parse
import urllib.request
from http.cookiejar import CookieJar

API = "http://127.0.0.1:8000"
ok = fail = 0


def check(name, cond, detail=""):
    global ok, fail
    if cond:
        ok += 1
        print(f"  PASS {name}")
    else:
        fail += 1
        print(f"  FAIL {name} {detail}")


def session():
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(CookieJar()))


def call(op, method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        f"{API}{path}", data=data, method=method, headers={"Content-Type": "application/json"}
    )
    try:
        with op.open(req, timeout=120) as resp:
            raw = resp.read()
            return resp.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, raw.decode(errors="replace")


def q(**kw):
    return "?" + urllib.parse.urlencode(kw)


admin = session()
call(admin, "POST", "/auth/login", {"email": "admin@odysseus.dev", "password": "admin1234"})

# 이전 응시 정리 후 새 응시 생성
_, attempts = call(admin, "GET", "/review/attempts")
for a in attempts or []:
    call(admin, "DELETE", f"/attempts/{a['id']}")
_, assessments = call(admin, "GET", "/assessments")
_, attempt = call(admin, "POST", f"/assessments/{assessments[0]['id']}/attempts")
attempt_id = attempt["id"]
scenario_id = attempt["scenarios"][0]["scenario_id"]
base = f"/attempts/{attempt_id}/scenarios/{scenario_id}"

print("\n── 설정 계약 ──")
st, cfg = call(admin, "GET", "/reference/config")
check("config 조회", st == 200 and "github_enabled" in cfg, str(cfg)[:120])
check("기본값은 GitHub·웹 모두 켜짐", cfg["github_enabled"] and cfg["web_enabled"])

st, admin_cfg = call(admin, "GET", "/admin/settings/reference")
check("관리자 설정 조회", st == 200 and "has_github_token" in admin_cfg, str(admin_cfg)[:120])
check("토큰은 값이 아니라 힌트만 돌려준다", "github_token" not in admin_cfg)

# 비밀값은 None 으로 보내면 유지되어야 한다 (화면이 되돌려 주지 않으므로)
st, saved = call(
    admin, "PUT", "/admin/settings/reference",
    {"github_enabled": True, "web_enabled": True, "search_provider": "duckduckgo"},
)
check("설정 저장", st == 200, str(saved)[:120])

print("\n── 인증 경계 ──")
anon = session()
st, _ = call(anon, "GET", "/reference/github/search" + q(q="vllm"))
check("비로그인 GitHub 검색 차단", st in (401, 403), f"status={st}")
st, _ = call(anon, "GET", "/reference/web/search" + q(q="test"))
check("비로그인 웹 검색 차단", st in (401, 403), f"status={st}")
st, _ = call(anon, "GET", "/admin/settings/reference")
check("비로그인 관리자 설정 차단", st in (401, 403), f"status={st}")

cand = session()
call(cand, "POST", "/auth/login", {"email": "candidate@odysseus.dev", "password": "cand1234"})
st, _ = call(cand, "GET", "/admin/settings/reference")
check("응시자는 관리자 설정 불가", st == 403, f"status={st}")
st, _ = call(cand, "GET", "/reference/config")
check("응시자도 config 는 조회 가능", st == 200, f"status={st}")

print("\n── 입력 검증 ──")
st, _ = call(admin, "GET", "/reference/github/repo" + q(owner="../etc", name="passwd"))
check("경로 탈출 owner 거부", st == 400, f"status={st}")
st, _ = call(admin, "GET", "/reference/github/file" + q(owner="a b", name="c", path="x"))
check("허용되지 않는 문자 거부", st == 400, f"status={st}")
st, _ = call(admin, "GET", "/reference/web/page" + q(url="file:///etc/passwd"))
check("file:// 스킴 거부", st == 400, f"status={st}")
st, _ = call(admin, "GET", "/reference/web/page" + q(url="http://127.0.0.1:8000/health"))
check("루프백 주소 거부 (SSRF)", st == 403, f"status={st}")
st, _ = call(admin, "GET", "/reference/web/page" + q(url="http://10.0.0.1/"))
check("사설 대역 거부 (SSRF)", st == 403, f"status={st}")

print("\n── 비활성화 시 차단 ──")
call(admin, "PUT", "/admin/settings/reference",
     {"github_enabled": False, "web_enabled": False, "search_provider": "duckduckgo"})
st, _ = call(admin, "GET", "/reference/github/search" + q(q="vllm"))
check("GitHub 끄면 검색 403", st == 403, f"status={st}")
st, _ = call(admin, "GET", "/reference/web/search" + q(q="vllm"))
check("웹 끄면 검색 403", st == 403, f"status={st}")
st, _ = call(admin, "POST", f"{base}/github/clone" + q(owner="octocat", name="Hello-World"))
check("GitHub 끄면 clone 403", st == 403, f"status={st}")
_, cfg = call(admin, "GET", "/reference/config")
check("config 가 꺼짐을 반영", not cfg["github_enabled"] and not cfg["web_enabled"])
call(admin, "PUT", "/admin/settings/reference",
     {"github_enabled": True, "web_enabled": True, "search_provider": "duckduckgo"})

print("\n── 외부 연동 (실제 github.com / 검색) ──")
st, res = call(admin, "GET", "/reference/github/search" + q(q="vllm inference", attempt_id=attempt_id, scenario_id=scenario_id))
check("GitHub 검색", st == 200 and len(res.get("items", [])) > 0, str(res)[:120])
if st == 200 and res["items"]:
    item = res["items"][0]
    check("검색 결과 스키마", all(k in item for k in ("full_name", "owner", "name", "stars", "default_branch")))

st, rv = call(admin, "GET", "/reference/github/repo" + q(owner="vllm-project", name="vllm"))
check("저장소 조회 + README", st == 200 and rv["readme"] and rv["repo"]["full_name"] == "vllm-project/vllm", str(rv)[:120])

st, tr = call(admin, "GET", "/reference/github/tree" + q(owner="vllm-project", name="vllm"))
check("트리 조회", st == 200 and len(tr["entries"]) > 5, str(tr)[:120])
check("디렉터리가 파일보다 먼저", st == 200 and tr["entries"][0]["type"] == "dir")

st, f = call(admin, "GET", "/reference/github/file" + q(owner="vllm-project", name="vllm", path="README.md"))
check("파일 조회", st == 200 and len(f["content"]) > 100, str(f)[:120])

# 이름이 바뀐 저장소 — API 리다이렉트를 따라가야 아카이브 주소가 맞는다
st, rn = call(admin, "GET", "/reference/github/repo" + q(owner="tiangolo", name="fastapi"))
check("이름 바뀐 저장소는 정식 이름으로 해석", st == 200 and rn["repo"]["full_name"] == "fastapi/fastapi", str(rn)[:120])

st, ws = call(admin, "GET", "/reference/web/search" + q(q="vllm tensor parallel", attempt_id=attempt_id))
check("웹 검색", st == 200 and len(ws.get("results", [])) > 0, str(ws)[:160])
if st == 200 and ws["results"]:
    r0 = ws["results"][0]
    check("결과가 리다이렉터가 아닌 실제 주소", "duckduckgo.com/l/" not in r0["url"], r0["url"][:80])
    st, pg = call(admin, "GET", "/reference/web/page" + q(url=r0["url"], attempt_id=attempt_id))
    check("페이지 읽기", st == 200 and len(pg.get("text", "")) > 200, str(pg)[:120])
    check("스크립트가 제거된 텍스트", st == 200 and "<script" not in pg.get("text", ""))

print("\n── clone → 워크스페이스 ──")
st, cl = call(admin, "POST", f"{base}/github/clone" + q(owner="octocat", name="Hello-World"))
check("작은 저장소 clone", st == 200 and cl["files"] >= 1 and not cl["truncated"], str(cl)[:160])
check("잘리지 않았으면 limit 은 빈 값", st == 200 and cl["limit"] == "", str(cl)[:120])

_, files = call(admin, "GET", f"{base}/files")
paths = [f["path"] for f in (files["files"] if isinstance(files, dict) else files)]
check("clone 파일이 github/<repo>/ 아래에 존재", any(p.startswith("github/Hello-World/") for p in paths), str(paths[:6]))
st, again = call(admin, "POST", f"{base}/github/clone" + q(owner="octocat", name="Hello-World"))
check("같은 곳에 다시 clone 하면 git 처럼 거부(409)", st == 409 and "already exists" in str(again), f"status={st} {str(again)[:80]}")

st, big = call(admin, "POST", f"{base}/github/clone" + q(owner="vllm-project", name="vllm", dest="ref/vllm"))
check("큰 저장소는 상한에서 잘린다", st == 200 and big["truncated"] and big["limit"] == "repo", str(big)[:160])
check("바이너리는 제외된다", st == 200 and big["files"] <= 300, str(big)[:120])

st, dup = call(admin, "POST", f"{base}/github/clone" + q(owner="tiangolo", name="fastapi", dest="ref/fastapi"))
check("워크스페이스가 차면 그 사실을 구분해 알린다",
      st == 200 and dup["limit"] == "workspace", str(dup)[:160])

st, bad = call(admin, "POST", f"{base}/github/clone" + q(owner="octocat", name="Hello-World", ref="no-such-branch"))
check("없는 브랜치는 502 로 실패", st == 502, f"status={st}")

print("\n── 기록 (평가 자료) ──")
_, events = call(admin, "GET", f"/review/attempts/{attempt_id}/events")
types = [e["type"] for e in (events or [])]
check("검색이 이벤트로 남는다", "reference_search" in types, str(sorted(set(types)))[:200])
check("열람이 이벤트로 남는다", "reference_open" in types)
check("clone 이 이벤트로 남는다", "github_clone" in types)
clone_ev = next((e for e in events if e["type"] == "github_clone"), None)
check("clone 이벤트에 저장소·경로가 있다",
      bool(clone_ev) and "repo" in clone_ev["payload"] and "dest" in clone_ev["payload"],
      str(clone_ev)[:160] if clone_ev else "")

print(f"\n{ok} passed, {fail} failed")
sys.exit(1 if fail else 0)

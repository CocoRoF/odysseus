"""ODY-018 검증 — 참고자료 조회는 응시 문맥 없이는 안 되고, 시작·실패까지 기록되는지 (개발 스택, 호스트).

  API_URL=http://127.0.0.1:8100 python3 tests/security/test_reference_audit.py
GitHub·example.com 에 실제로 나간다 (네트워크 없으면 해당 항목이 실패한다).
"""

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from http.cookiejar import CookieJar

API = os.environ.get("API_URL", "http://127.0.0.1:8100")
ok = fail = 0


def check(name, cond, detail=""):
    global ok, fail
    if cond:
        ok += 1
        print(f"  PASS {name}")
    else:
        fail += 1
        print(f"  FAIL {name} {str(detail)[:240]}")


def session(email, password):
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(CookieJar()))
    st, _ = call(op, "POST", "/auth/login", {"email": email, "password": password})
    assert st == 200, f"login {email} {st}"
    return op


def call(op, method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f"{API}{path}", data=data, method=method, headers={"Content-Type": "application/json"})
    try:
        with op.open(req, timeout=120) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, raw.decode(errors="replace")


admin = session("admin@odysseus.dev", "admin1234")
_, attempts = call(admin, "GET", "/review/attempts")
for a in attempts or []:
    call(admin, "DELETE", f"/attempts/{a['id']}")
cand = session("candidate@odysseus.dev", "cand1234")
_, mine = call(cand, "GET", "/my/assignments")
target = mine[0]["assessment_id"]
_, at = call(cand, "POST", f"/assessments/{target}/attempts")
aid = at["id"]
sid = at["scenarios"][0]["scenario_id"]
_, scenarios = call(admin, "GET", "/scenarios")
outside = next((s["id"] for s in scenarios if s["id"] not in {x["scenario_id"] for x in at["scenarios"]}), None)
ctx = f"&attempt_id={aid}&scenario_id={sid}"


def events(types=None):
    _, evs = call(admin, "GET", f"/review/attempts/{aid}/events")
    return [e for e in (evs or []) if not types or e["type"] in types]


print("\n── 응시자: 문맥 없으면 403, 잘못된 문맥도 거부 ──")
for label, path in [
    ("GitHub 검색", "/reference/github/search?q=octocat"),
    ("GitHub 저장소", "/reference/github/repo?owner=octocat&name=Hello-World"),
    ("GitHub 트리", "/reference/github/tree?owner=octocat&name=Hello-World"),
    ("GitHub 파일", "/reference/github/file?owner=octocat&name=Hello-World&path=README"),
    ("웹 검색", "/reference/web/search?q=python"),
    ("웹 페이지", "/reference/web/page?url=https://example.com/"),
    ("렌더", "/reference/web/render?url=https://example.com/&asset_base=http://localhost:3100/api/reference/web/asset"),
]:
    st, body = call(cand, "GET", path)
    check(f"{label}: 문맥 없음 → 403", st == 403, (st, str(body)[:80]))
st, body = call(cand, "GET", f"/reference/github/repo?owner=octocat&name=Hello-World&attempt_id={aid}&scenario_id={outside}")
check("시험 밖 시나리오 문맥 → 404/403", st in (403, 404), (st, str(body)[:80]))
_, at2 = call(admin, "POST", f"/assessments/{target}/attempts")  # 관리자 자신의 응시
st, body = call(cand, "GET", f"/reference/github/repo?owner=octocat&name=Hello-World&attempt_id={at2['id']}&scenario_id={sid}")
check("남의 응시 문맥 → 403", st == 403, (st, str(body)[:80]))
check("거부된 요청은 이벤트를 남기지 않는다 (응시에 붙일 문맥이 없으므로)", not events({"reference_request", "reference_open"}), events({"reference_request"}))

print("\n── 올바른 문맥: 시작·완료가 기록된다 ──")
st, body = call(cand, "GET", f"/reference/github/repo?owner=octocat&name=Hello-World{ctx}")
check("저장소 조회 200", st == 200, (st, str(body)[:80]))
req = events({"reference_request"})
opn = events({"reference_open"})
check("reference_request(시작) 기록", any(e["payload"].get("repo") == "octocat/Hello-World" for e in req), req[-1:])
check("reference_open(완료) 기록, source=server", any(e["payload"].get("repo") == "octocat/Hello-World" and e.get("source") == "server" for e in opn), opn[-1:])
st, body = call(cand, "GET", f"/reference/github/tree?owner=octocat&name=Hello-World{ctx}")
check("트리 조회 200", st == 200, st)
check("트리 조회도 기록", any("tree" in e["payload"] for e in events({"reference_open"})), events({"reference_open"})[-1:])
st, body = call(cand, "GET", f"/reference/github/file?owner=octocat&name=Hello-World&path=README{ctx}")
check("파일 조회 200", st == 200, st)
check("파일 조회도 기록", any(e["payload"].get("file") == "README" for e in events({"reference_open"})), events({"reference_open"})[-1:])
st, body = call(cand, "GET", f"/reference/github/search?q=octocat+hello{ctx}")
check("검색 기록에 결과 수", st == 200 and any("results" in e["payload"] for e in events({"reference_search"})), events({"reference_search"})[-1:])

print("\n── 실패도 기록된다 ──")
n_fail = len(events({"reference_failed"}))
st, body = call(cand, "GET", f"/reference/web/page?url=https://nonexistent-host-odysseus-test.invalid/{ctx}")
check("없는 호스트 → 오류 응답", st in (400, 502), (st, str(body)[:80]))
failed = events({"reference_failed"})
check("reference_failed 이벤트 (status·error)", len(failed) == n_fail + 1 and "error" in failed[-1]["payload"], failed[-1:])
st, body = call(cand, "GET", f"/reference/github/repo?owner=octocat&name=no-such-repo-odysseus-xyz{ctx}")
check("없는 저장소 404", st == 404, st)
check("404 도 reference_failed 로 남는다", any(e["payload"].get("repo") == "octocat/no-such-repo-odysseus-xyz" and e["payload"].get("status") == 404 for e in events({"reference_failed"})), events({"reference_failed"})[-1:])

print("\n── 스태프 미리보기: 문맥 없이 조회 가능, 응시에는 붙지 않음 ──")
st, body = call(admin, "GET", "/reference/github/repo?owner=octocat&name=Hello-World")
check("관리자는 문맥 없이 200", st == 200, st)

print("\n── 제출 뒤에는 응시 문맥이 더 이상 유효하지 않다 ──")
call(cand, "POST", f"/attempts/{aid}/finish")
st, body = call(cand, "GET", f"/reference/github/repo?owner=octocat&name=Hello-World{ctx}")
check("종료된 응시 문맥 → 400", st == 400, (st, str(body)[:80]))

for a in (aid, at2["id"]):
    call(admin, "DELETE", f"/attempts/{a}")
print(f"\n{ok} passed, {fail} failed")
sys.exit(1 if fail else 0)

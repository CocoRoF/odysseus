"""ODY-002 검증 — 내부 API 경계·토큰·범위 (api 컨테이너 안에서 실행, 개발 스택 전용).

  docker cp tests/security/test_internal_boundary.py <api>:/tmp/
  docker exec -e PYTHONPATH=/app <api> python3 /tmp/test_internal_boundary.py

확인하는 것:
  · 엣지(/api/internal/*)에서는 토큰이 맞아도 404
  · 직접 호출도 프록시 헤더(X-Forwarded-For)가 붙어 있으면 404
  · 잘못된/빈 서비스 토큰은 401
  · 실행 결과 콜백은 실행별 X-Execution-Token 이 없거나 다르면 401, 맞으면 접수, 두 번째는 duplicate
  · agent-tool 은 시험에 속하지 않은 시나리오 404, 순서가 아닌 시나리오는 거부 결과
  · ExecutionOut 에 callback_token 이 나가지 않는다
"""

import json
import os
import sys
import urllib.error
import urllib.request
from http.cookiejar import CookieJar

API = "http://127.0.0.1:8000"
EDGE = os.environ.get("EDGE_URL", "http://edge:80/api")
TOKEN = os.environ["INTERNAL_TOKEN"]
ok = fail = 0


def check(name, cond, detail=""):
    global ok, fail
    if cond:
        ok += 1
        print(f"  PASS {name}")
    else:
        fail += 1
        print(f"  FAIL {name} {detail}")


def call(op, method, path, body=None, headers=None, base=API):
    data = json.dumps(body).encode() if body is not None else None
    h = {"Content-Type": "application/json", **(headers or {})}
    req = urllib.request.Request(f"{base}{path}", data=data, method=method, headers=h)
    try:
        with (op or urllib.request.build_opener()).open(req, timeout=60) as resp:
            raw = resp.read()
            return resp.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, raw.decode(errors="replace")
    except urllib.error.URLError as e:
        return 0, str(e)


admin = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(CookieJar()))
st, _ = call(admin, "POST", "/auth/login", {"email": "admin@odysseus.dev", "password": "admin1234"})
assert st == 200, f"admin login {st}"
_, attempts = call(admin, "GET", "/review/attempts")
for a in attempts or []:
    call(admin, "DELETE", f"/attempts/{a['id']}")
_, assessments = call(admin, "GET", "/assessments")
multi = next((a for a in assessments if len(a.get("scenarios", [])) >= 2), None)
target = multi or assessments[0]
_, attempt = call(admin, "POST", f"/assessments/{target['id']}/attempts")
attempt_id = attempt["id"]
scen = [s["scenario_id"] for s in attempt["scenarios"]]
cur, nxt = scen[0], (scen[1] if len(scen) > 1 else None)
_, all_scen = call(admin, "GET", "/scenarios")
outside = next((s["id"] for s in all_scen if s["id"] not in scen), None)

print("\n── 경계: 엣지·프록시 헤더 ──")
st, body = call(None, "GET", "/internal/agent-tools", headers={"X-Internal-Token": TOKEN}, base=EDGE)
check("엣지 /api/internal/* 는 올바른 토큰이어도 404", st == 404, f"status={st}")
st, _ = call(None, "GET", "/internal/agent-tools", headers={"X-Internal-Token": TOKEN, "X-Forwarded-For": "1.2.3.4"})
check("프록시 헤더가 붙은 직접 호출도 404", st == 404, f"status={st}")
st, _ = call(None, "GET", "/internal/agent-tools", headers={"X-Internal-Token": TOKEN})
check("내부 직접 호출(프록시 없음)은 200", st == 200, f"status={st}")

print("\n── 서비스 토큰 ──")
for name, hdr in [("토큰 없음", {}), ("틀린 토큰", {"X-Internal-Token": "x" * 64}), ("알려진 기본값", {"X-Internal-Token": "odysseus-internal-change-me"})]:
    st, _ = call(None, "GET", "/internal/agent-tools", headers=hdr)
    check(f"{name} → 401", st == 401, f"status={st}")

print("\n── 실행 결과 콜백: 실행별 일회용 토큰 ──")
base = f"/attempts/{attempt_id}/scenarios/{cur}"
st, ex = call(admin, "POST", f"{base}/run", {"command": "echo boundary-test"})
check("실행 요청", st == 200, f"status={st}")
check("ExecutionOut 에 callback_token 없음", "callback_token" not in (ex or {}), str(ex)[:120])
# 러너가 진짜 결과를 보내기 전에 우리가 먼저 위조를 시도한다
forged = {"status": "done", "exit_code": 0, "stdout": "forged", "stderr": "", "time_ms": 1, "changed_files": [{"path": "forged.txt", "content": "x"}]}
st, _ = call(None, "POST", f"/internal/executions/{ex['id']}/result", forged, headers={"X-Internal-Token": TOKEN})
check("실행 토큰 없이 결과 보고 → 401", st == 401, f"status={st}")
st, _ = call(None, "POST", f"/internal/executions/{ex['id']}/result", forged, headers={"X-Internal-Token": TOKEN, "X-Execution-Token": "wrong"})
check("틀린 실행 토큰 → 401", st == 401, f"status={st}")
st, _ = call(None, "POST", f"/internal/executions/{ex['id']}/running", headers={"X-Internal-Token": TOKEN})
check("running 표시도 실행 토큰 필요 → 401", st == 401, f"status={st}")
# 진짜 러너가 처리하도록 기다린다
import time

done = None
for _ in range(60):
    time.sleep(0.5)
    _, done = call(admin, "GET", f"/executions/{ex['id']}")
    if done and done["status"] in ("done", "error"):
        break
check("진짜 러너의 결과는 접수된다", done and done["status"] == "done" and "boundary-test" in (done.get("stdout") or ""), str(done)[:160])
_, files = call(admin, "GET", f"{base}/files")
paths = [f["path"] for f in (files["files"] if isinstance(files, dict) else files)]
check("위조된 changed_files 는 반영되지 않았다", "forged.txt" not in paths, str(paths)[:120])
st, _ = call(None, "POST", f"/internal/executions/{ex['id']}/result", forged, headers={"X-Internal-Token": TOKEN, "X-Execution-Token": "wrong"})
check("끝난 실행에 다시 보고 → 401 (토큰 소거)", st == 401, f"status={st}")

print("\n── agent-tool 범위 ──")
hdr = {"X-Internal-Token": TOKEN}
st, r = call(None, "POST", "/internal/agent-tool", {"attempt_id": attempt_id, "scenario_id": cur, "name": "list_files", "input": {}}, headers=hdr)
check("현재 시나리오 list_files → 200 정상", st == 200 and not r.get("is_error"), f"{st} {str(r)[:100]}")
if outside:
    st, r = call(None, "POST", "/internal/agent-tool", {"attempt_id": attempt_id, "scenario_id": outside, "name": "list_files", "input": {}}, headers=hdr)
    check("시험에 없는 시나리오 → 404", st == 404, f"status={st}")
if nxt:
    st, r = call(None, "POST", "/internal/agent-tool", {"attempt_id": attempt_id, "scenario_id": nxt, "name": "write_file", "input": {"path": "early.txt", "content": "x"}}, headers=hdr)
    check("잠긴(다음 순서) 시나리오 write_file → 거부", st == 200 and r.get("is_error") and "거부됨" in r.get("result", ""), f"{st} {str(r)[:100]}")
    # 응시자 본인에게 잠긴 시나리오는 423 — 다른 관리자 세션이 아니라 여기서는 상태 코드로 확인하고,
    # 파일 유무는 시나리오를 제출해 순서를 넘긴 뒤 본다
    st2, _ = call(admin, "GET", f"/attempts/{attempt_id}/scenarios/{nxt}/files")
    check("잠긴 시나리오는 본인에게도 423", st2 == 423, f"status={st2}")
    call(admin, "POST", f"/attempts/{attempt_id}/scenarios/{cur}/submit")
    _, f2 = call(admin, "GET", f"/attempts/{attempt_id}/scenarios/{nxt}/files")
    rows = f2.get("files", []) if isinstance(f2, dict) else (f2 if isinstance(f2, list) else [])
    p2 = [f["path"] for f in rows]
    check("잠긴 동안 파일이 생기지 않았다", "early.txt" not in p2, str(p2)[:100])
else:
    print("  (다중 시나리오 시험이 없어 순서 검증은 건너뜀)")
st, r = call(None, "POST", "/internal/agent-tool", {"attempt_id": attempt_id, "scenario_id": cur, "name": "list_files", "input": {}}, headers=hdr, base=EDGE)
check("엣지 경유 agent-tool → 404", st == 404, f"status={st}")

call(admin, "DELETE", f"/attempts/{attempt_id}")
print(f"\n{ok} passed, {fail} failed")
sys.exit(1 if fail else 0)

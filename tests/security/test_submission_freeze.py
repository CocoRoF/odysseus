"""ODY-007 검증 — 마감·제출 뒤에는 아무것도 바뀌지 않는지 (api 컨테이너 안에서 실행, 개발 스택).

  docker cp tests/security/test_submission_freeze.py <api>:/tmp/
  docker exec -e PYTHONPATH=/app <api> python3 /tmp/test_submission_freeze.py

DB 는 컨테이너의 DATABASE_URL 로 직접 만진다 (마감 시각 조작, 트리거 확인).
"""

import asyncio
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from http.cookiejar import CookieJar

import asyncpg

API = "http://127.0.0.1:8000"
DSN = os.environ["DATABASE_URL"].replace("postgresql+asyncpg://", "postgresql://")
ok = fail = 0


def check(name, cond, detail=""):
    global ok, fail
    if cond:
        ok += 1
        print(f"  PASS {name}")
    else:
        fail += 1
        print(f"  FAIL {name} {str(detail)[:240]}")


def sql(query, *args):
    async def go():
        conn = await asyncpg.connect(DSN)
        try:
            return await conn.fetch(query, *args)
        finally:
            await conn.close()

    return asyncio.run(go())


op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(CookieJar()))


def call(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f"{API}{path}", data=data, method=method, headers={"Content-Type": "application/json"})
    try:
        with op.open(req, timeout=90) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, raw.decode(errors="replace")


st, _ = call("POST", "/auth/login", {"email": "admin@odysseus.dev", "password": "admin1234"})
assert st == 200
_, attempts = call("GET", "/review/attempts")
for a in attempts or []:
    call("DELETE", f"/attempts/{a['id']}")
_, assessments = call("GET", "/assessments")
single = next((a for a in assessments if len(a.get("scenarios", [])) == 1), assessments[0])


def new_attempt():
    _, at = call("POST", f"/assessments/{single['id']}/attempts")
    return at["id"], at["scenarios"][0]["scenario_id"]


def wait_exec(ex_id, timeout=60):
    for _ in range(timeout * 2):
        time.sleep(0.5)
        _, d = call("GET", f"/executions/{ex_id}")
        if d["status"] in ("done", "error"):
            return d
    return d


def files(aid, sid):
    st, f = call("GET", f"/attempts/{aid}/scenarios/{sid}/files")
    if st != 200:
        return None
    rows = f["files"] if isinstance(f, dict) else f
    return {r["path"] for r in rows}


print("\n── 제출 직전 시작한 늦은 실행은 제출 뒤 파일을 바꾸지 못한다 ──")
aid, sid = new_attempt()
base = f"/attempts/{aid}/scenarios/{sid}"
st, ex = call("POST", f"{base}/run", {"command": "sleep 6; printf 'changed after submit\\n' > late.txt; echo late-done"})
check("늦은 실행 요청", st == 200)
time.sleep(1)
st, at = call("POST", f"/attempts/{aid}/finish")
check("제출", st == 200 and at["status"] == "submitted", at)
d = wait_exec(ex["id"], 30)
check("남아 있던 실행은 취소/오류로 닫힌다", d["status"] == "error", d)
time.sleep(8)  # 러너가 늦게 결과를 보내더라도
fs = files(aid, sid)
check("late.txt 가 워크스페이스에 없다", fs is not None and "late.txt" not in fs, fs)
_, evs = call("GET", f"/review/attempts/{aid}/events")
sub = next((e for e in evs if e["type"] == "attempt_submitted"), None)
check("제출 이벤트에 스냅샷 요약·취소 수", sub and "snapshot" in sub["payload"] and sub["payload"].get("cancelled_executions", 0) >= 1, str(sub)[:200])
row = sql("select snapshot from attempts where id = $1", __import__("uuid").UUID(aid))
snap = json.loads(row[0]["snapshot"]) if row and row[0]["snapshot"] else None
check("응시에 시나리오별 스냅샷(해시·파일 수)이 저장됨", snap and sid in snap and "digest" in snap[sid], str(snap)[:160])

print("\n── 제출 뒤 모든 변경 API 거부 ──")
st, _ = call("PUT", f"{base}/files/content", {"path": "after.txt", "content": "x"})
check("파일 저장 400", st == 400, st)
st, _ = call("POST", f"{base}/run", {"command": "echo hi"})
check("실행 400", st == 400, st)
st, _ = call("POST", f"{base}/messenger/anyone", {"content": "hi"})
check("메신저 400/404", st in (400, 404), st)
st, r = call("POST", f"{base}/github/clone?owner=octocat&name=Hello-World")
check("clone 400", st == 400, st)
fs2 = files(aid, sid)
check("파일 목록은 그대로", fs2 == fs, fs2)

print("\n── DB 트리거: 제출된 응시의 워크스페이스는 직접 UPDATE 도 막힌다 ──")
try:
    sql("update workspace_files set content = 'tampered' where attempt_id = $1", __import__("uuid").UUID(aid))
    check("직접 UPDATE 거부", False, "허용됨")
except Exception as e:  # noqa: BLE001
    check("직접 UPDATE 거부", "frozen" in str(e), str(e)[:120])
try:
    sql("insert into workspace_files (id, attempt_id, scenario_id, path, content, updated_at) values (gen_random_uuid(), $1, $2, 'x.txt', 'x', now())", __import__("uuid").UUID(aid), __import__("uuid").UUID(sid))
    check("직접 INSERT 거부", False, "허용됨")
except Exception as e:  # noqa: BLE001
    check("직접 INSERT 거부", "frozen" in str(e), str(e)[:120])
try:
    sql("delete from workspace_files where attempt_id = $1", __import__("uuid").UUID(aid))
    check("직접 DELETE 거부", False, "허용됨")
except Exception as e:  # noqa: BLE001
    check("직접 DELETE 거부", "frozen" in str(e), str(e)[:120])
st, _ = call("DELETE", f"/attempts/{aid}")
check("응시 삭제(CASCADE)는 여전히 가능", st == 200, st)

print("\n── 마감: 유예 없이 즉시 변경 거부, 이벤트 플러시만 45초 ──")
aid, sid = new_attempt()
base = f"/attempts/{aid}/scenarios/{sid}"
st, _ = call("PUT", f"{base}/files/content", {"path": "before.txt", "content": "ok"})
check("마감 전 저장", st == 200, st)
sql("update attempts set deadline_at = now() - interval '2 seconds' where id = $1", __import__("uuid").UUID(aid))
st, _ = call("PUT", f"{base}/files/content", {"path": "after_deadline.txt", "content": "x"})
check("마감 2초 뒤 저장 → 400 (이전엔 45초 유예)", st == 400, st)
_, at = call("GET", f"/attempts/{aid}")
check("응시는 expired", at["status"] == "expired", at["status"])
st, r = call("POST", f"/attempts/{aid}/events", {"events": [{"type": "exam_leave", "scenario_id": sid, "payload": {}}]})
check("마감 직후 행동 이벤트 플러시는 받아 준다", st == 200 and r.get("recorded") == 1, r)
sql("update attempts set submitted_at = now() - interval '2 minutes', deadline_at = now() - interval '2 minutes' where id = $1", __import__("uuid").UUID(aid))
st, r = call("POST", f"/attempts/{aid}/events", {"events": [{"type": "exam_leave", "scenario_id": sid, "payload": {}}]})
check("유예(45초)가 지나면 이벤트도 받지 않는다", st == 200 and r.get("recorded") == 0, r)
fs = files(aid, sid)
check("마감 뒤 파일이 생기지 않았다", fs is not None and "after_deadline.txt" not in fs and "before.txt" in fs, fs)
call("DELETE", f"/attempts/{aid}")

print("\n── 정상 흐름 회귀 ──")
aid, sid = new_attempt()
base = f"/attempts/{aid}/scenarios/{sid}"
st, ex = call("POST", f"{base}/run", {"command": "echo normal > n.txt; echo ok"})
d = wait_exec(ex["id"])
check("진행 중 실행·파일 반영 정상", d["status"] == "done" and "n.txt" in (files(aid, sid) or set()), d)
st, at = call("POST", f"{base}/complete")
if len(at.get("scenarios", [])) > 1:
    check("문제 제출로 다음 순서(다중 시나리오)", st == 200 and at["status"] == "in_progress" and at.get("current_ordinal") == 1, str(at)[:120])
    st, at = call("POST", f"/attempts/{aid}/finish")
check("종료 → submitted + 스냅샷", st == 200 and at["status"] == "submitted", str(at)[:120])
call("DELETE", f"/attempts/{aid}")

print(f"\n{ok} passed, {fail} failed")
sys.exit(1 if fail else 0)

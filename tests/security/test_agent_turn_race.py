"""ODY-019 검증 — 동시 에이전트 요청이 턴 한도를 넘지 못하는지 (개발 스택 + 모의 LLM, 호스트에서 실행).

  python3 tests/smoke/mock_llm.py &
  API_URL=http://127.0.0.1:8100 python3 tests/security/test_agent_turn_race.py "http://<gateway>:18011/v1"
"""

import json
import os
import sys
import threading
import time
import urllib.error
import urllib.request
from http.cookiejar import CookieJar

API = os.environ.get("API_URL", "http://127.0.0.1:8100")
MOCK_BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:18011/v1"
MAX_TURNS = 3
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


def call(op, method, path, body=None, raw_ok=False):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f"{API}{path}", data=data, method=method, headers={"Content-Type": "application/json"})
    try:
        with op.open(req, timeout=180) as r:
            raw = r.read()
            if raw_ok:
                return r.status, raw.decode(errors="replace")
            return r.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, raw.decode(errors="replace")


admin = session("admin@odysseus.dev", "admin1234")
_, provs = call(admin, "GET", "/admin/settings/ai/providers")
for p in provs or []:
    call(admin, "DELETE", f"/admin/settings/ai/providers/{p['id']}")
st, prov = call(admin, "POST", "/admin/settings/ai/providers", {"name": "모의 LLM", "provider": "custom", "base_url": MOCK_BASE, "model": "mock-model"})
assert st == 200, prov
_, attempts = call(admin, "GET", "/review/attempts")
for a in attempts or []:
    call(admin, "DELETE", f"/attempts/{a['id']}")
_, scenarios = call(admin, "GET", "/scenarios")
sc = next((s for s in scenarios if "매출" in s["title"]), scenarios[0])
st, assess = call(admin, "POST", "/assessments", {
    "title": "턴 한도 경쟁 테스트", "description": "", "duration_min": 30, "agent_max_turns": MAX_TURNS,
    "scenarios": [{"scenario_id": sc["id"], "points": 100}], "assignee_ids": [],
})
assert st == 200, assess
_, at = call(admin, "POST", f"/assessments/{assess['id']}/attempts")
aid, sid = at["id"], at["scenarios"][0]["scenario_id"]
base = f"/attempts/{aid}/scenarios/{sid}"


def user_turns():
    _, msgs = call(admin, "GET", f"{base}/agent/messages")
    return len([m for m in (msgs or []) if m.get("role") == "user"])


print(f"\n── 한도 {MAX_TURNS} 인데 10개를 동시에 ──")
results = []
lock = threading.Lock()


def send(i):
    st, body = call(admin, "POST", f"{base}/agent/messages", {"content": f"동시 요청 {i}"}, raw_ok=True)
    with lock:
        results.append(st)


threads = [threading.Thread(target=send, args=(i,)) for i in range(10)]
for t in threads:
    t.start()
for t in threads:
    t.join()
time.sleep(1)
print("   응답 코드:", sorted(results))
check("성공(200)은 한도 이하", results.count(200) <= MAX_TURNS, results)
check("나머지는 409(동시 진행) 또는 429(한도)", all(c in (200, 409, 429) for c in results), results)
check(f"저장된 사용자 턴 ≤ {MAX_TURNS}", user_turns() <= MAX_TURNS, user_turns())

print("\n── 순차로 남은 턴을 채운 뒤에는 429 ──")
deadline = time.time() + 90
while user_turns() < MAX_TURNS and time.time() < deadline:
    st, body = call(admin, "POST", f"{base}/agent/messages", {"content": "채우기"}, raw_ok=True)
    if st == 200:
        time.sleep(0.3)
        continue
    if st in (409, 429) and "한도" not in str(body):
        time.sleep(2)  # 동시성 잠금·속도 제한(ODY-010/019) — 잠시 뒤 다시
        continue
    break
check(f"정확히 {MAX_TURNS} 턴 사용", user_turns() == MAX_TURNS, user_turns())
time.sleep(6)  # 속도 제한 버킷이 채워질 시간
st, body = call(admin, "POST", f"{base}/agent/messages", {"content": "하나 더"}, raw_ok=True)
check("한도 뒤 요청은 429 (한도)", st == 429 and "한도" in str(body), (st, str(body)[:80]))
check("한도 뒤에도 사용자 턴은 늘지 않음", user_turns() == MAX_TURNS, user_turns())
_, usage = call(admin, "GET", f"/attempts/{aid}/agent/usage")
check("usage 가 일치", usage and usage.get("used") == MAX_TURNS and usage.get("remaining") == 0, usage)

print("\n── 턴 이벤트에 순번 ──")
_, evs = call(admin, "GET", f"/review/attempts/{aid}/events")
turns = sorted(e["payload"].get("turn", 0) for e in (evs or []) if e["type"] == "agent_turn")
check("agent_turn 이벤트 순번 1..N 이 겹치지 않음", turns == list(range(1, len(turns) + 1)), turns)

call(admin, "DELETE", f"/attempts/{aid}")
call(admin, "DELETE", f"/assessments/{assess['id']}")
for p in (call(admin, "GET", "/admin/settings/ai/providers")[1] or []):
    call(admin, "DELETE", f"/admin/settings/ai/providers/{p['id']}")
print(f"\n{ok} passed, {fail} failed")
sys.exit(1 if fail else 0)

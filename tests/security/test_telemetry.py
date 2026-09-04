"""ODY-017 검증 — 브라우저 보고 이벤트는 신뢰 불가 신호로만 저장되는지 (개발 스택, 호스트에서 실행).

  API_URL=http://127.0.0.1:8100 python3 tests/security/test_telemetry.py
"""

import json
import os
import sys
import time
import urllib.error
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
_, assessments = call(admin, "GET", "/assessments")
_, scenarios = call(admin, "GET", "/scenarios")
_, at = call(admin, "POST", f"/assessments/{assessments[0]['id']}/attempts")
aid = at["id"]
sid = at["scenarios"][0]["scenario_id"]
in_assessment = {s["scenario_id"] for s in at["scenarios"]}
outside = next((s["id"] for s in scenarios if s["id"] not in in_assessment), None)


def events():
    _, evs = call(admin, "GET", f"/review/attempts/{aid}/events")
    return evs or []


def post(evs):
    return call(admin, "POST", f"/attempts/{aid}/events", {"events": evs})


print("\n── 출처 표시 ──")
st, r = post([{"type": "tab_hidden", "scenario_id": sid, "payload": {"seq": 1, "client_id": "c1"}}])
check("클라이언트 이벤트 기록", st == 200 and r.get("recorded") == 1, r)
ev = [e for e in events() if e["type"] == "tab_hidden"]
check("source=client_untrusted", ev and ev[-1].get("source") == "client_untrusted", ev[-1:] )
st, ex = call(admin, "POST", f"/attempts/{aid}/scenarios/{sid}/run", {"command": "echo hi"})
time.sleep(1)
srv = [e for e in events() if e["type"] == "run_request"]
check("서버 관측 이벤트는 source=server", srv and srv[-1].get("source") == "server", srv[-1:])
started = [e for e in events() if e["type"] == "attempt_started"]
check("응시 시작 이벤트도 server", started and started[0].get("source") == "server", started[:1])

print("\n── 위조 차단 ──")
st, r = post([{"type": "reference_open", "scenario_id": sid, "payload": {"seq": 2, "url": "http://x"}}])
check("참고자료 열람은 클라이언트가 보고할 수 없다 (서버가 기록)", st == 200 and r.get("recorded") == 0 and r.get("dropped") == 1, r)
if outside:
    st, r = post([{"type": "tab_hidden", "scenario_id": outside, "payload": {"seq": 2}}])
    check("시험에 없는 시나리오 id 는 버린다", st == 200 and r.get("recorded") == 0, r)
st, r = post([{"type": "run_done", "scenario_id": sid, "payload": {"seq": 2, "exit_code": 0}}])
check("서버 전용 종류(run_done)는 화이트리스트 밖 → 버림", r.get("recorded") == 0, r)
st, r = post([{"type": "paste", "scenario_id": sid, "payload": {"seq": 2, "text": "x" * 5000, "chars": 5000, "evil": {"nested": True}, "__proto__": 1}}])
check("payload 는 허용 키만·길이 제한", st == 200 and r.get("recorded") == 1, r)
p = [e for e in events() if e["type"] == "paste"][-1]["payload"]
check("허용되지 않은 키 제거", "evil" not in p and "__proto__" not in p, p.keys())
check("text 는 500자로 잘림", len(p.get("text", "")) == 500, len(p.get("text", "")))

print("\n── 순서 번호: 중복·재생은 버리고 빈틈은 서버가 기록 ──")
st, r = post([{"type": "tab_visible", "scenario_id": sid, "payload": {"seq": 2}}])
check("같은 seq 재전송은 버린다", r.get("recorded") == 0 and r.get("dropped") == 1, r)
st, r = post([{"type": "tab_visible", "scenario_id": sid, "payload": {"seq": 1}}])
check("과거 seq(재생)도 버린다", r.get("recorded") == 0, r)
st, r = post([{"type": "window_blur", "scenario_id": sid, "payload": {"seq": 6}}])
check("건너뛴 seq 는 받되", r.get("recorded") == 1, r)
gaps = [e for e in events() if e["type"] == "telemetry_gap"]
check("telemetry_gap 서버 이벤트가 남는다 (expected 3, got 6)", gaps and gaps[-1]["payload"].get("expected") == 3 and gaps[-1]["payload"].get("got") == 6 and gaps[-1].get("source") == "server", gaps[-1:])
st, r = post([{"type": "window_focus", "scenario_id": sid, "payload": {}}])
check("seq 없는(구버전) 이벤트는 그냥 받는다", r.get("recorded") == 1, r)

print("\n── 리뷰 API 가 출처를 내보낸다 ──")
evs = events()
check("모든 이벤트에 source 필드", all("source" in e for e in evs) and {e["source"] for e in evs} >= {"server", "client_untrusted"}, {e.get("source") for e in evs})

call(admin, "DELETE", f"/attempts/{aid}")
print(f"\n{ok} passed, {fail} failed")
sys.exit(1 if fail else 0)

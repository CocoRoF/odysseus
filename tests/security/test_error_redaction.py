"""ODY-022 검증 — AI 오류가 응시자에게 내부 상세 없이 코드·상관 ID 로만 보이는지 (개발 스택, 호스트).

  API_URL=http://127.0.0.1:8100 python3 tests/security/test_error_redaction.py
닿을 수 없는 base_url 을 가진 공급자를 등록해 실제 SDK 예외를 일으킨다.
"""

import json
import os
import sys
import urllib.error
import urllib.request
from http.cookiejar import CookieJar

API = os.environ.get("API_URL", "http://127.0.0.1:8100")
SECRET_HOST = "internal-llm-gateway.corp.invalid"
SECRET_KEY = "sk-SECRETKEY1234567890abcdef"
ok = fail = 0


def check(name, cond, detail=""):
    global ok, fail
    if cond:
        ok += 1
        print(f"  PASS {name}")
    else:
        fail += 1
        print(f"  FAIL {name} {str(detail)[:240]}")


op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(CookieJar()))


def call(method, path, body=None, raw=False):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f"{API}{path}", data=data, method=method, headers={"Content-Type": "application/json"})
    try:
        with op.open(req, timeout=180) as r:
            b = r.read()
            return r.status, (b.decode(errors="replace") if raw else (json.loads(b) if b else None))
    except urllib.error.HTTPError as e:
        b = e.read()
        try:
            return e.code, (b.decode(errors="replace") if raw else json.loads(b))
        except Exception:
            return e.code, b.decode(errors="replace")


st, _ = call("POST", "/auth/login", {"email": "admin@odysseus.dev", "password": "admin1234"})
assert st == 200
_, provs = call("GET", "/admin/settings/ai/providers")
for p in provs or []:
    call("DELETE", f"/admin/settings/ai/providers/{p['id']}")
st, prov = call("POST", "/admin/settings/ai/providers", {
    "name": "닿지 않는 공급자", "provider": "custom", "base_url": f"http://{SECRET_HOST}:9/v1", "model": "m", "api_key": SECRET_KEY,
})
assert st == 200, prov
_, attempts = call("GET", "/review/attempts")
for a in attempts or []:
    call("DELETE", f"/attempts/{a['id']}")
_, assessments = call("GET", "/assessments")
demo = next((a for a in assessments if "매출" in a["title"]), assessments[0])
_, at = call("POST", f"/assessments/{demo['id']}/attempts")
aid, sid = at["id"], at["scenarios"][0]["scenario_id"]
base = f"/attempts/{aid}/scenarios/{sid}"
_, detail = call("GET", f"/attempts/{aid}")
ckey = (detail["scenarios"][0].get("characters") or [{}])[0].get("key", "pm")


def leaks(text: str) -> list[str]:
    return [m for m in (SECRET_HOST, SECRET_KEY, "sk-SECRET", ":9/v1", "Traceback", "/app/odysseus_api") if m in text]


print("\n── 에이전트 SSE ──")
st, body = call("POST", f"{base}/agent/messages", {"content": "안녕"}, raw=True)
check("스트림 응답", st == 200, (st, body[:120]))
errs = [json.loads(l[6:]) for l in body.splitlines() if l.startswith("data: ") and '"error"' in l]
check("error 이벤트에 code·correlation_id", errs and errs[-1].get("code", "").startswith("AI_") and errs[-1].get("correlation_id"), errs[-1:])
check("error 이벤트에 내부 호스트·키·경로 없음", not leaks(body), leaks(body))
_, msgs = call("GET", f"{base}/agent/messages")
last = [m for m in (msgs or []) if m.get("role") == "assistant"]
check("저장된 meta.error 는 코드", last and str(last[-1]["meta"].get("error", "")).startswith("AI_"), last[-1]["meta"] if last else last)
check("메시지 목록 meta 에 내부 상세 없음", not leaks(json.dumps(msgs, ensure_ascii=False)), leaks(json.dumps(msgs, ensure_ascii=False)))
check("meta 는 허용 키만", last and set(last[-1]["meta"].keys()) <= {"steps", "error", "error_message", "correlation_id"}, last[-1]["meta"].keys() if last else None)

print("\n── 메신저 ──")
st, msgs = call("POST", f"{base}/messenger/{ckey}", {"content": "안녕하세요"})
check("메신저 200 (자리 비움 안내)", st == 200, (st, str(msgs)[:120]))
npc = [m for m in (msgs or []) if m.get("sender") == "npc"]
check("NPC 응답 meta 에 내부 상세 없음", not leaks(json.dumps(msgs, ensure_ascii=False)), leaks(json.dumps(msgs, ensure_ascii=False)))
if npc and isinstance(npc[-1].get("meta"), dict) and npc[-1]["meta"].get("error"):
    check("NPC meta.error 는 코드", str(npc[-1]["meta"]["error"]).startswith("AI_"), npc[-1]["meta"])

print("\n── 스튜디오(관리자)·연결 테스트 ──")
st, body = call("POST", "/scenarios/author", {"brief": "테스트"}, raw=True)
check("author 502 에 참조 ID 만", st == 502 and "참조:" in body and not leaks(body), (st, body[:160]))
st, body = call("POST", "/admin/settings/ai/test", {"provider_id": prov["id"]}, raw=True)
check("관리자 연결 테스트 오류에 키 없음 (호스트는 관리자에게 허용)", st == 200 and SECRET_KEY not in body and "sk-SECRET" not in body, body[:200])

call("DELETE", f"/attempts/{aid}")
for p in (call("GET", "/admin/settings/ai/providers")[1] or []):
    call("DELETE", f"/admin/settings/ai/providers/{p['id']}")
print(f"\n{ok} passed, {fail} failed")
sys.exit(1 if fail else 0)

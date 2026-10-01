"""시나리오별 NPC 기본 규칙 덮어쓰기 — 저장·조회·기본값·프롬프트 조립 (api 컨테이너 안에서 실행).

  docker cp tests/smoke/test_scenario_npc_rules.py <api>:/tmp/
  docker exec -e PYTHONPATH=/app <api> python3 /tmp/test_scenario_npc_rules.py
"""

import json
import sys
import urllib.error
import urllib.request
from http.cookiejar import CookieJar

from odysseus_api.ai import npc, npc_prompt

API = "http://127.0.0.1:8000"
ok = fail = 0


def check(name, cond, detail=""):
    global ok, fail
    if cond:
        ok += 1
        print(f"  PASS {name}")
    else:
        fail += 1
        print(f"  FAIL {name} {str(detail)[:200]}")


op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(CookieJar()))


def call(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f"{API}{path}", data=data, method=method, headers={"Content-Type": "application/json"})
    try:
        with op.open(req, timeout=60) as r:
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

print("\n── 전역 기본값 엔드포인트 ──")
st, d = call("GET", "/scenarios/npc-default-prompt")
check("기본값 조회 200", st == 200 and d.get("prompt") == npc_prompt.BASE_RULES, (st, str(d)[:80]))

print("\n── 시나리오에 저장·조회 ──")
CUSTOM = "## House rules for this scenario\n\n1. Answer only the latest message.\n2. Never mention the deadline unless asked.\nMARKER-NPC-RULES-9f2"
body = {
    "title": "NPC 규칙 테스트", "summary": "", "difficulty": "easy", "briefing_md": "x",
    "characters": [{"key": "pm", "name": "테스트PM", "role": "PM", "color": "#888", "persona": "차분", "knowledge": "마감은 내일"}],
    "opening_messages": [{"character_key": "pm", "content": "안녕하세요"}],
    "initial_files": [], "objectives_md": "정답", "checks": [], "rubric": {}, "agent_enabled": True,
    "npc_base_prompt": CUSTOM,
}
st, sc = call("POST", "/scenarios", body)
check("생성 200 + 필드 반환", st == 200 and sc.get("npc_base_prompt") == CUSTOM, (st, str(sc)[:120]))
sid = sc["id"]
st, got = call("GET", f"/scenarios/{sid}")
check("조회에 그대로", got.get("npc_base_prompt") == CUSTOM)
body["npc_base_prompt"] = "   "
st, upd = call("PUT", f"/scenarios/{sid}", body)
check("공백만 저장하면 빈 값(전역 기본 사용)", st == 200 and upd.get("npc_base_prompt") == "", str(upd)[:80])
body["npc_base_prompt"] = CUSTOM
call("PUT", f"/scenarios/{sid}", body)
st, r = call("PUT", f"/scenarios/{sid}", {**body, "npc_base_prompt": "x" * 20001})
check("길이 상한(20000) 초과는 422", st == 422, st)

print("\n── 프롬프트 조립 ──")


class Fake:
    characters = body["characters"]
    npc_base_prompt = CUSTOM


class FakeEmpty:
    characters = body["characters"]
    npc_base_prompt = ""


p1 = npc.npc_system_prompt(Fake(), body["characters"][0])
p2 = npc.npc_system_prompt(FakeEmpty(), body["characters"][0])
check("덮어쓰기가 있으면 그것이 규칙 자리에", "MARKER-NPC-RULES-9f2" in p1 and "Rules that override" not in p1)
check("카드는 그대로 앞에", p1.index("차분") < p1.index("MARKER-NPC-RULES-9f2") and "마감은 내일" in p1)
check("비어 있으면 전역 기본", "Rules that override your character card" in p2 and "MARKER" not in p2)
check("전역 기본이 마지막 말", p2.rstrip().endswith("delete it."))

call("DELETE", f"/scenarios/{sid}")
print(f"\n{ok} passed, {fail} failed")
sys.exit(1 if fail else 0)

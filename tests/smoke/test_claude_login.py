"""claude_login 매니저 E2E — 가짜 setup-token 바이너리로 전체 경로 검증.

api 컨테이너 안에서 실행:
  docker cp tests/smoke/fake_claude_cli.py odysseus-api-1:/tmp/fake/claude
  docker exec odysseus-api-1 chmod +x /tmp/fake/claude
  docker cp tests/smoke/test_claude_login.py odysseus-api-1:/tmp/fake/
  docker exec -e PYTHONPATH=/app odysseus-api-1 python3 /tmp/fake/test_claude_login.py
"""
import time
from odysseus_api.ai.claude_login import manager, ClaudeLoginError

ok = fail = 0
def check(name, cond, detail=""):
    global ok, fail
    if cond: ok += 1; print("  PASS", name)
    else: fail += 1; print("  FAIL", name, detail)

# 1) 성공 경로
st = manager.start(binary_override="/tmp/fake/claude", wait_s=10)
check("url extracted from OSC8", st["state"] == "awaiting_code" and st["url"] and st["url"].startswith("https://claude.com/cai/oauth"), str(st))
st2 = manager.submit_code(st["session_id"], "goodcode", wait_s=15)
check("token captured", st2["state"] == "success" and (st2["token"] or "").startswith("sk-ant-oat01-"), str(st2))

# 2) 실패 경로 (잘못된 코드)
st = manager.start(binary_override="/tmp/fake/claude", wait_s=10)
st2 = manager.submit_code(st["session_id"], "badcode", wait_s=15)
check("bad code -> error state", st2["state"] == "error" and "Invalid authorization code" in (st2["error"] or ""), str(st2))

# 3) 중복 코드 제출 거부
st = manager.start(binary_override="/tmp/fake/claude", wait_s=10)
manager.get(st["session_id"]).submit_code("goodcode")
try:
    manager.get(st["session_id"]).submit_code("again")
    check("duplicate code rejected", False)
except ClaudeLoginError as e:
    check("duplicate code rejected", e.code == 409, str(e.code))
time.sleep(1)
manager.cancel(st["session_id"])

# 4) 없는 세션
try:
    manager.status("nope")
    check("missing session 404", False)
except ClaudeLoginError as e:
    check("missing session 404", e.code == 404, str(e.code))

print(f"\n=== {ok} passed, {fail} failed ===")
exit(1 if fail else 0)

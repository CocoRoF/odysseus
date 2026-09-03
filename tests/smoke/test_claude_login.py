"""claude_login 매니저 E2E — 가짜 setup-token 바이너리로 전체 경로 검증.

가짜 CLI 는 실제 CLI 처럼 **커서 이동으로 화면을 그린다**. ANSI 를 걷어내면
단어 사이 공백이 사라지므로, 공백을 낀 문구로 성공을 판정하면 영영 매치되지
않는다 — 실제로 그 버그로 로그인이 '확인 중'에서 멈췄었다.

api 컨테이너 안에서 실행:
  docker cp tests/smoke/fake_claude_cli.py odysseus-api-1:/tmp/fake/claude
  docker exec odysseus-api-1 chmod +x /tmp/fake/claude
  docker cp tests/smoke/test_claude_login.py odysseus-api-1:/tmp/fake/
  docker exec -e PYTHONPATH=/app odysseus-api-1 python3 /tmp/fake/test_claude_login.py
"""
import os

from odysseus_api.ai.claude_login import ClaudeLoginError, manager

BIN = "/tmp/fake/claude"
ok = fail = 0


def check(name, cond, detail=""):
    global ok, fail
    if cond:
        ok += 1
        print("  PASS", name)
    else:
        fail += 1
        print("  FAIL", name, detail)


# 1) 성공 경로
st = manager.start(binary_override=BIN, wait_s=10)
check(
    "url extracted from OSC8",
    st["state"] == "awaiting_code"
    and st["url"]
    and st["url"].startswith("https://claude.com/cai/oauth"),
    str(st),
)
st2 = manager.submit_code(st["session_id"], "goodcode", wait_s=15)
check("token captured", st2["state"] == "success" and (st2["token"] or "").startswith("sk-ant-oat01-"), str(st2))
check("공백 없는 출력에서도 성공 판정", st2["state"] == "success", str(st2))
# 회귀: 코드와 Enter 를 한 번에 쓰면 ink 가 paste 로 보고 Enter 를 놓쳐 제출 자체가
# 안 된다. 가짜 CLI 도 그렇게 동작하므로, 이 검사가 통과한다는 것은 Enter 를 분리해
# 보냈다는 뜻이다 (xgen-workflow 가 실측으로 잡아 둔 함정).
check("긴 코드도 제출된다 (Enter 분리 전송)", st2["token"] is not None, str(st2)[:120])

# 2) 실패 경로 (잘못된 코드로 프로세스가 끝나는 경우)
st = manager.start(binary_override=BIN, wait_s=10)
st2 = manager.submit_code(st["session_id"], "badcode", wait_s=20)
check("bad code -> error state", st2["state"] == "error", str(st2))

# 3) 중복 제출 거부
st = manager.start(binary_override=BIN, wait_s=10)
manager.submit_code(st["session_id"], "goodcode", wait_s=15)
try:
    manager.submit_code(st["session_id"], "goodcode", wait_s=5)
    check("duplicate code rejected", False)
except ClaudeLoginError as e:
    check("duplicate code rejected", e.code == 409, str(e.code))

# 4) 없는 세션
try:
    manager.status("nope")
    check("missing session 404", False)
except ClaudeLoginError as e:
    check("missing session 404", e.code == 404, str(e.code))

# 5) OAuth 오류 → 안내 후 재시도 (회귀: 예전엔 상태가 awaiting_code 로 굳어
#    화면이 '확인 중'에서 멈췄고, 재제출도 409 로 막혔다)
os.environ["FAKE_CLAUDE_MODE"] = "retry"
try:
    st = manager.start(binary_override=BIN, wait_s=10)
    sid = st["session_id"]
    bad = manager.submit_code(sid, "wrong-code", wait_s=20)
    check("틀린 코드는 매달리지 않고 사유를 알려 준다",
          bad["state"] == "error" and bool(bad.get("error")), str(bad))
    check("사유가 '코드가 올바르지 않다' 로 특정된다", "코드" in (bad.get("error") or ""), str(bad.get("error")))
finally:
    os.environ.pop("FAKE_CLAUDE_MODE", None)

# 6) 실제 인증 코드 길이(100자+)에서도 제출이 성립하는가 — 짧은 코드는 우연히 됐다
st = manager.start(binary_override=BIN, wait_s=10)
long_bad = "X" * 120
st2 = manager.submit_code(st["session_id"], long_bad, wait_s=20)
check("100자 넘는 코드도 CLI 에 닿는다", st2["state"] == "error", str(st2)[:140])

print(f"\n=== {ok} passed, {fail} failed ===")
exit(1 if fail else 0)

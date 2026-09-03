#!/usr/bin/env python3
"""setup-token 흐름을 흉내내는 가짜 claude — 로그인 매니저 단위 E2E용.

실제 CLI 의 두 가지 성질을 흉내낸다. 둘 다 예전 구현이 걸려 넘어진 자리다:

  1. **커서 이동으로 화면을 그린다** → ANSI 제거 후 단어 사이 공백이 사라진다.
     ("Welcome to Claude Code" → "WelcometoClaudeCode")
  2. **코드와 Enter 가 한 번에 오면 paste 로 보고 Enter 를 무시한다** (ink 입력).
     코드를 전량 쓴 뒤 잠깐 있다가 Enter 를 따로 보내야 제출이 성립한다.

  FAKE_CLAUDE_MODE=retry  잘못된 코드 → OAuth 오류 후 재시도 프롬프트
"""
import os
import sys
import termios
import time
import tty

# 토큰 검증 호출(`claude --print --output-format json ping`) — 매니저가 캡처한
# 토큰이 실제로 인증되는지 확인할 때 부른다. 온전한 토큰만 통과시킨다.
if "--print" in sys.argv:
    import json as _json

    tok = os.environ.get("CLAUDE_CODE_OAUTH_TOKEN", "")
    good = tok.startswith("sk-ant-oat01-") and len(tok) == len("sk-ant-oat01-") + 60
    print(_json.dumps({"is_error": not good, "result": "pong" if good else "authentication_error"}))
    sys.exit(0 if good else 1)

if len(sys.argv) < 2 or sys.argv[1] != "setup-token":
    print("unexpected args", sys.argv)
    sys.exit(2)

MODE = os.environ.get("FAKE_CLAUDE_MODE", "")
URL = "https://claude.com/cai/oauth/authorize?code=true&client_id=test&state=fake"

try:  # 청크 경계를 보려면 raw 모드여야 한다 (canonical 은 줄 단위로 뭉친다)
    tty.setraw(sys.stdin.fileno())
except (termios.error, OSError):
    pass


def draw(text: str) -> None:
    """실제 CLI 처럼 커서 이동을 섞어 출력 — ANSI 제거 후 공백이 사라진다."""
    for word in text.split(" "):
        sys.stdout.write(word + "\x1b[1C")
    sys.stdout.write("\n")
    sys.stdout.flush()


def read_code() -> str:
    """코드를 읽는다. Enter 가 코드와 **같은 청크**로 오면 paste 로 보고 버린다."""
    buf = ""
    while True:
        try:
            chunk = os.read(sys.stdin.fileno(), 4096).decode(errors="replace")
        except OSError:
            sys.exit(1)
        if not chunk:
            sys.exit(1)
        if chunk in ("\r", "\n", "\r\n"):
            if buf:
                return buf  # 코드 뒤에 따로 온 Enter — 제출 성립
            continue
        if chunk.endswith("\r") or chunk.endswith("\n"):
            # 코드와 Enter 가 한 덩어리 = paste. 실제 ink 처럼 제출로 치지 않는다.
            buf += chunk.rstrip("\r\n")
            continue
        buf += chunk


draw("Welcome to Fake Claude Code v2.1.258")
sys.stdout.write(f"\x1b]8;id=x;{URL}\x1b\\link text\x1b]8;;\x1b\\\n")
draw("Paste code here if prompted >")

attempts = 0
while True:
    code = read_code().strip()
    attempts += 1
    time.sleep(0.3)

    if code == "goodcode":
        draw("Long-lived authentication token created successfully!")
        draw("Your OAuth token (valid for 1 year): sk-ant-oat01-" + "F" * 60)
        sys.exit(0)

    if MODE == "retry" and attempts == 1:
        draw("OAuth error: Invalid code. Please make sure the full code was copied")
        draw("Press Enter to retry.")
        draw("Paste code here if prompted >")
        continue

    draw("Invalid authorization code. Please try again.")
    sys.exit(1)

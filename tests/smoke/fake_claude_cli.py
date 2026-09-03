#!/usr/bin/env python3
"""setup-token 흐름을 흉내내는 가짜 claude — 로그인 매니저 단위 E2E용.

실제 CLI(2.1.x)는 커서 이동으로 화면을 그려서, ANSI 를 걷어내면 **단어 사이
공백이 사라진다**. 예전 가짜는 얌전히 공백을 찍는 바람에, 공백을 낀 문구로
성공을 판정하던 버그를 통과시켰다. 그래서 기본 모드는 실제와 같이 커서 이동을
섞어 출력한다.

  FAKE_CLAUDE_MODE=retry  잘못된 코드 → OAuth 오류 후 재시도 프롬프트
"""
import os
import sys
import time

if len(sys.argv) < 2 or sys.argv[1] != "setup-token":
    print("unexpected args", sys.argv)
    sys.exit(2)

MODE = os.environ.get("FAKE_CLAUDE_MODE", "")
url = "https://claude.com/cai/oauth/authorize?code=true&client_id=test&state=fake"


def draw(text: str) -> None:
    """실제 CLI 처럼 커서 이동을 섞어 출력 — ANSI 제거 후 공백이 사라진다."""
    for word in text.split(" "):
        sys.stdout.write(word + "\x1b[1C")  # 한 칸 오른쪽으로 (공백 대신 커서 이동)
    sys.stdout.write("\n")


draw("Welcome to Fake Claude Code v2.1.258")
sys.stdout.write(f"\x1b]8;id=x;{url}\x1b\\link text\x1b]8;;\x1b\\\n")
draw("Paste code here if prompted >")
sys.stdout.flush()

attempts = 0
while True:
    code = sys.stdin.readline()
    if not code:
        sys.exit(1)
    code = code.strip()
    attempts += 1
    time.sleep(0.3)

    if code == "goodcode":
        draw("Long-lived authentication token created successfully!")
        draw("Your OAuth token (valid for 1 year): sk-ant-oat01-" + "F" * 60)
        sys.stdout.flush()
        sys.exit(0)

    if MODE == "retry" and attempts == 1:
        # 실제 CLI 의 오류 경로 — 사용자는 다시 붙여넣을 수 있다
        draw("OAuth error: Invalid code. Please make sure the full code was copied")
        draw("Press Enter to retry.")
        sys.stdout.flush()
        sys.stdin.readline()  # 매니저가 프롬프트를 되살리려 보내는 Enter
        draw("Paste code here if prompted >")
        sys.stdout.flush()
        continue

    draw("Invalid authorization code. Please try again.")
    sys.stdout.flush()
    sys.exit(1)

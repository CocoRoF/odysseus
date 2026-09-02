#!/usr/bin/env python3
"""setup-token 흐름을 흉내내는 가짜 claude — 로그인 매니저 단위 E2E용."""
import sys, time

if len(sys.argv) < 2 or sys.argv[1] != "setup-token":
    print("unexpected args", sys.argv); sys.exit(2)

url = "https://claude.com/cai/oauth/authorize?code=true&client_id=test&state=fake"
# OSC-8 하이퍼링크 형태로 URL 출력 (실제 CLI와 동일)
sys.stdout.write("Welcome to Fake Claude\n")
sys.stdout.write(f"\x1b]8;id=x;{url}\x1b\\link text\x1b]8;;\x1b\\\n")
sys.stdout.write("Paste code here if prompted > ")
sys.stdout.flush()

code = sys.stdin.readline().strip()
time.sleep(0.3)
if code == "goodcode":
    print("\n✓ Long-lived authentication token created successfully! "
          "Your OAuth token (valid for 1 year): sk-ant-oat01-" + "F" * 60 + " Store this token securely.")
    sys.exit(0)
print("\nInvalid authorization code. Please try again.")
sys.exit(1)

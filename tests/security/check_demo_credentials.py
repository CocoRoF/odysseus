"""알려진 데모 비밀번호가 허용된 곳(개발 시드·스모크 테스트) 밖에 있으면 실패한다.

  python3 tests/security/check_demo_credentials.py

ODY-001 재발 방지 — 로그인 화면, README, 배포 스크립트 등에 고정 자격증명이 다시 들어가는 것을 막는다.
"""
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
FORBIDDEN = re.compile(r"admin1234|eval1234|cand1234")
# 허용: 개발 전용 시드(정의 위치), 스모크 테스트(개발 스택에서만 돈다), 보안 문서(재현 설명), 이 검사 자체
ALLOWED_PREFIXES = ("apps/api/odysseus_api/seed.py", "tests/", "docs/security/")

files = subprocess.run(["git", "ls-files"], cwd=ROOT, capture_output=True, text=True, check=True).stdout.split()
bad = []
for rel in files:
    if rel.startswith(ALLOWED_PREFIXES):
        continue
    p = ROOT / rel
    try:
        text = p.read_text(encoding="utf-8")
    except (UnicodeDecodeError, OSError):
        continue
    for i, line in enumerate(text.splitlines(), 1):
        if FORBIDDEN.search(line):
            bad.append(f"{rel}:{i}: {line.strip()[:100]}")

if bad:
    print("고정 데모 비밀번호가 허용되지 않은 곳에 있습니다:")
    print("\n".join("  " + b for b in bad))
    sys.exit(1)
print(f"OK — {len(files)}개 파일 검사, 고정 데모 비밀번호 없음")

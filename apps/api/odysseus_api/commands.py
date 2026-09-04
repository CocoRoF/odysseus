"""응시자 명령 문자열의 입력 규칙 (ODY-021).

명령은 러너의 bash 로 그대로 간다. 개행·탭은 heredoc 과 여러 줄 스크립트에 필요하므로 허용하지만,
로그·화면을 교란하는 제어문자(ESC 등 C0/C1, 줄바꿈이 아닌 캐리지리턴)와 텍스트 방향을 뒤집는
bidi 제어문자는 입력 단계에서 거부한다. 로그에 찍을 때는 어떤 문자든 이스케이프한다.
"""

import re

from fastapi import HTTPException

# C0(탭·개행 제외), DEL, C1, 그리고 bidi 제어(U+202A~E, U+2066~9)·줄 구분자(U+2028/9)
_FORBIDDEN = re.compile(r"[\x00-\x08\x0b-\x1f\x7f\x80-\x9f‪-‮⁦-⁩  ]")


def validate_command(command: str, max_len: int) -> str:
    cmd = (command or "").strip()
    if not cmd:
        raise HTTPException(400, "명령이 비어 있습니다")
    if len(cmd) > max_len:
        raise HTTPException(400, "명령이 너무 깁니다")
    m = _FORBIDDEN.search(cmd)
    if m:
        raise HTTPException(400, f"명령에 허용되지 않는 제어문자가 있습니다 (U+{ord(m.group(0)):04X})")
    return cmd


def log_safe(text: str, limit: int = 60) -> str:
    """로그 한 줄용 — 개행·제어문자·ANSI 를 이스케이프해 한 줄로 만든다."""
    out = repr(text[:limit])[1:-1]  # \n, \x1b 등으로 이스케이프
    return out + ("…" if len(text) > limit else "")

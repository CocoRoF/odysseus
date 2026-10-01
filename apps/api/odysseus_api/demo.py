"""관리자 둘러보기 계정 — 관리 화면을 **읽기만** 하는 손님.

이 서비스는 데모로도 쓰인다. 계정 없이 들어온 사람에게 관리 화면이 무엇을 담고 있는지
보여 주고 싶지만, 그러자고 진짜 관리자 계정을 내줄 수는 없다. 그래서 역할을 하나 둔다:
조회는 관리자와 똑같이 하고, **바꾸는 요청은 서버가 거절한다.**

막는 일은 전부 서버에서 한다. 버튼을 숨기는 것은 막은 것이 아니다.

- **바꾸기**: GET·HEAD·OPTIONS 가 아닌 요청은 모두 거절한다. 로그아웃만 예외다 —
  나가는 길까지 막으면 세션이 만료될 때까지 갇힌다.
- **응시자 화면**: 둘러보기 계정은 시험을 보지 않는다. 배정 목록과 사무실 입장을 거절한다.
  관리자 계정의 [응시자 화면] 처럼 넘어갈 수 있으면, 데모를 보러 온 사람이 실제 응시 자원
  (모델 호출·러너)을 쓰게 된다.
- **남의 개인정보**: 관리 화면의 계정 목록과 응시 기록에는 실제 이메일이 나온다. 데모에서
  보여 줄 것이 아니므로 가린다(:func:`mask_email`).

역할을 새로 두지 않고 관리자 계정에 읽기 전용 플래그를 다는 방법도 있었다. 그러면 "관리자
인가" 를 묻는 기존 검사들이 전부 통과해 버려, 빠뜨린 곳이 곧 구멍이 된다. 역할이 다르면
기본이 거절이고, 열어 준 곳만 열린다.
"""

from __future__ import annotations

DEMO_ADMIN_ROLE = "demo_admin"

#: 둘러보기 계정 이메일의 도메인. 실제 주소가 아니라 표식이며, users.email 의 UNIQUE 를
#: 만족시키는 자리이기도 하다 (게스트의 guest.local 과 같은 쓰임).
DEMO_EMAIL_DOMAIN = "demo.local"

#: 둘러보기 계정을 놀려 둘 수 있는 시간. 이만큼 아무 요청이 없으면 세션을 끊고 계정을 지운다
#: (:mod:`odysseus_api.demo_sweep`). 비밀번호 경로가 닫혀 있어 어차피 다시 들어올 수 없는 계정이므로,
#: 남겨 두면 사용자 목록만 덮는다.
DEMO_IDLE_MINUTES = 10

READONLY_MESSAGE = "둘러보기 계정은 보기만 할 수 있습니다. 바꾸려면 관리자로 로그인하세요"
DEMO_EXPIRED_MESSAGE = "둘러보기 세션이 끝났습니다. 로그인 화면에서 다시 들어오세요"
NO_EXAM_MESSAGE = "둘러보기 계정은 응시할 수 없습니다. 관리 화면만 볼 수 있습니다"

SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})
#: 바꾸는 요청이지만 허용하는 것 — 나가는 길.
ALLOWED_WRITE_PATHS = frozenset({"/auth/logout"})


def is_demo_admin(user) -> bool:
    return getattr(user, "role", "") == DEMO_ADMIN_ROLE


def readonly_violation(role: str, method: str, path: str) -> bool:
    """이 요청을 거절해야 하는가. 둘러보기 계정의 바꾸는 요청이면 True."""
    if role != DEMO_ADMIN_ROLE:
        return False
    if (method or "").upper() in SAFE_METHODS:
        return False
    return (path or "").rstrip("/") not in ALLOWED_WRITE_PATHS


def mask_email(email: str) -> str:
    """이메일의 계정 부분을 가린다 — 도메인은 남긴다(계정 종류를 읽는 단서라서).

    길이도 숨긴다: 별의 개수를 원래 길이에 맞추면 짧은 주소가 그대로 드러난다.
    """
    text = str(email or "").strip()
    if "@" not in text:
        return "***" if text else ""
    local, _, domain = text.partition("@")
    head = local[:2] if len(local) > 2 else local[:1]
    return f"{head}***@{domain}"


def mask_ip(value: str) -> str:
    """접속 주소의 마지막 마디를 가린다. 어느 대역인지는 남아 운영 이야기를 할 수 있고,
    개인을 가리키는 마지막 자리는 사라진다. 대역(CIDR) 표기는 그대로 둔다."""
    text = str(value or "").strip()
    if not text:
        return ""
    if "/" in text:  # 운영자가 적어 둔 차단 대역 — 이미 개인 하나를 가리키지 않는다
        head, _, bits = text.partition("/")
        return f"{mask_ip(head)}/{bits}"
    if ":" in text:  # IPv6
        parts = text.split(":")
        return ":".join(parts[:3] + ["*"]) if len(parts) > 3 else "*"
    parts = text.split(".")
    return ".".join(parts[:3] + ["*"]) if len(parts) == 4 else "*"


def mask_ip_for(viewer, value: str) -> str:
    return mask_ip(value) if is_demo_admin(viewer) else (value or "")


def mask_email_for(viewer, email: str) -> str:
    """둘러보기 계정이 보는 자리에서만 가린다. 관리자·평가자에게는 그대로 보인다."""
    return mask_email(email) if is_demo_admin(viewer) else (email or "")

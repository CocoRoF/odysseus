"""게스트 접속 — 정책, 주소 차단, 사용량 한도.

게스트는 이메일도 초대도 없이 들어온다. 그래서 남용을 다루는 단위가
달라진다:

* **정지의 단위가 계정이 아니다.** 정지시킨 게스트가 1초 뒤 새 계정으로
  돌아오면 정지는 아무것도 막지 못한다. 그래서 주소 차단이 함께 있어야
  게스트 정지가 실제 조치가 된다.
* **비용의 단위가 대화다.** 게스트 하나가 시험 안에서 NPC/에이전트와
  무한히 대화하면 그대로 요금이 된다. 분당 속도만으로는 총량이 묶이지
  않으므로 응시당 총 건수도 함께 막는다.

세 가지 모두 관리자가 끄고 켜고 조절할 수 있어야 한다 — 코드에 박힌
한도는 운영 중에 바꿀 수 없고, 바꿀 수 없는 한도는 결국 꺼진다.
"""

from __future__ import annotations

import ipaddress
import time
import uuid
from dataclasses import dataclass
from typing import Any

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from .models import AgentMessage, AppSetting, BlockedIp, MessengerMessage, User
from .ratelimit import check, too_many

#: AppSetting 키 — 값은 아래 :class:`GuestPolicy` 의 필드와 1:1
SETTING_KEY = "guest_access"

GUEST_ROLE = "guest"
#: 게스트 이메일의 도메인. 실제 주소가 아니라 '이 계정은 게스트'라는 표식이며,
#: users.email 의 UNIQUE 제약을 만족시키기 위한 자리이기도 하다.
GUEST_EMAIL_DOMAIN = "guest.local"


@dataclass(frozen=True)
class GuestPolicy:
    """게스트에게 무엇을 허용할지. 기본값은 '꺼짐'."""

    #: 게스트 로그인 자체를 허용할지 ([설정] → 게스트 접속). 꺼지면 버튼이 사라지고,
    #: 엔드포인트도 403 을 낸다 (버튼을 숨기는 것만으로는 막은 게 아니다).
    enabled: bool = False
    #: 한 주소에서 시간당 만들 수 있는 게스트 계정 수. 이게 없으면 계정
    #: 생성이 곧 무한 자원이 된다. 0 이면 새 게스트를 받지 않는다.
    max_new_per_hour_per_ip: int = 5
    #: 게스트의 분당 대화 건수. 메신저와 에이전트가 버킷 하나를 같이 쓴다 —
    #: 따로 세면 두 창을 번갈아 열어 두 배로 보낼 수 있다.
    chat_per_min: int = 6
    #: 게스트 한 응시에서 보낼 수 있는 대화 총 건수. 0 이면 총량 제한 없음.
    #: 분당 속도만으로는 하루 종일 보내는 것을 막지 못한다.
    chat_total_per_attempt: int = 60

    @classmethod
    def from_value(cls, value: Any) -> GuestPolicy:
        """저장된 JSON → 정책. 모르는 키는 무시하고, 잘못된 값은 기본값으로.

        설정 한 줄이 깨졌다고 게스트 경로 전체가 500 을 내면, 고치러 들어갈
        관리 화면조차 못 여는 수가 있다.
        """
        raw = value if isinstance(value, dict) else {}

        def _int(key: str, default: int, lo: int, hi: int) -> int:
            try:
                return max(lo, min(hi, int(raw.get(key, default))))
            except (TypeError, ValueError):
                return default

        return cls(
            enabled=bool(raw.get("enabled", False)),
            max_new_per_hour_per_ip=_int("max_new_per_hour_per_ip", 5, 0, 1000),
            chat_per_min=_int("chat_per_min", 6, 1, 120),
            chat_total_per_attempt=_int("chat_total_per_attempt", 60, 0, 100000),
        )

    def to_value(self) -> dict:
        return {
            "enabled": self.enabled,
            "max_new_per_hour_per_ip": self.max_new_per_hour_per_ip,
            "chat_per_min": self.chat_per_min,
            "chat_total_per_attempt": self.chat_total_per_attempt,
        }


async def load_policy(db: AsyncSession) -> GuestPolicy:
    row = await db.get(AppSetting, SETTING_KEY)
    return GuestPolicy.from_value(row.value if row else None)


async def save_policy(db: AsyncSession, policy: GuestPolicy) -> GuestPolicy:
    row = await db.get(AppSetting, SETTING_KEY)
    if row is None:
        row = AppSetting(key=SETTING_KEY, value=policy.to_value())
        db.add(row)
    else:
        row.value = policy.to_value()
    await db.commit()
    return policy


# ── 주소 차단 ─────────────────────────────────────────────────────────


def _parse(entry: str) -> ipaddress._BaseNetwork | None:
    """저장된 문자열 → 네트워크. 단일 IP 는 /32(/128) 로 읽는다."""
    text = (entry or "").strip()
    if not text:
        return None
    try:
        return ipaddress.ip_network(text, strict=False)
    except ValueError:
        return None


def normalize_cidr(entry: str) -> str:
    """관리자가 입력한 값을 저장 형태로. 잘못된 값은 거절한다.

    입력을 그대로 담아두면 "203.0.113.7" 과 "203.0.113.7/32" 가 서로 다른
    행이 되어, 하나만 지우고 차단이 풀린 줄 아는 일이 생긴다.
    """
    net = _parse(entry)
    if net is None:
        raise HTTPException(400, "IP 또는 CIDR 형식이 아닙니다")
    if net.num_addresses == 1:
        return str(net.network_address)
    return str(net)


def is_blocked(ip: str, entries: list[str]) -> bool:
    """*ip* 가 차단 목록에 걸리는지. 판정 불가한 값은 막지 않는다.

    프록시 뒤에서 주소를 못 읽는 경우가 있고, 그때 '모르니까 차단'은
    전체 서비스를 잠그는 쪽으로 실패한다.
    """
    try:
        addr = ipaddress.ip_address((ip or "").strip())
    except ValueError:
        return False
    for entry in entries:
        net = _parse(entry)
        if net is not None and addr.version == net.version and addr in net:
            return True
    return False


#: 차단 목록 캐시. 이 목록은 모든 요청에서 읽히지만 거의 바뀌지 않는다 —
#: 요청마다 SELECT 를 도는 대신 짧게 캐시한다. TTL 이 있으므로 워커가 여러
#: 개여도 몇 초 안에 서로 수렴하고, 같은 워커 안의 변경은 즉시 반영된다.
_CACHE_TTL_S = 10.0
_cache: tuple[float, list[str]] | None = None


def invalidate_cache() -> None:
    """차단 목록을 바꾼 직후 호출 — 방금 한 조치가 곧바로 들어야 한다."""
    global _cache
    _cache = None


async def blocked_entries(db: AsyncSession) -> list[str]:
    global _cache
    now = time.monotonic()
    if _cache is not None and now - _cache[0] < _CACHE_TTL_S:
        return _cache[1]
    rows = [r for r in (await db.execute(select(BlockedIp.cidr))).scalars()]
    _cache = (now, rows)
    return rows


async def assert_ip_allowed(db: AsyncSession, ip: str, *, role: str | None = None) -> None:
    """*ip* 가 차단 목록에 있으면 403. 관리자는 예외.

    관리자를 면제하는 이유는 편의가 아니라 복구 가능성이다. 자기 대역을 실수로
    넣으면 차단을 푸는 화면 자체에 못 들어가고, 그때 남는 수단은 DB 직접 수정뿐이다.
    되돌릴 수 없는 조치는 결국 아무도 쓰지 않게 된다.
    """
    if role == "admin":
        return
    if is_blocked(ip, await blocked_entries(db)):
        raise HTTPException(403, "차단된 주소입니다")


# ── 대화 총량 ─────────────────────────────────────────────────────────


async def assert_chat_quota(
    db: AsyncSession, *, attempt_id: uuid.UUID, policy: GuestPolicy
) -> None:
    """게스트의 응시당 대화 총량. 0 이면 제한 없음.

    메신저(NPC)와 에이전트를 합쳐서 센다 — 둘 다 모델 호출이고, 한쪽만
    막으면 다른 쪽으로 흘러갈 뿐이다.
    """
    cap = policy.chat_total_per_attempt
    if cap <= 0:
        return
    # 두 테이블이 '보낸 쪽'을 서로 다른 컬럼 이름으로 적는다 (sender / role).
    used = 0
    for model, column, mine in (
        (MessengerMessage, MessengerMessage.sender, "candidate"),
        (AgentMessage, AgentMessage.role, "user"),
    ):
        used += int(
            (
                await db.execute(
                    select(func.count())
                    .select_from(model)
                    .where(model.attempt_id == attempt_id, column == mine)
                )
            ).scalar_one()
            or 0
        )
    if used >= cap:
        raise HTTPException(
            429, f"게스트 대화 한도({cap}건)를 모두 사용했습니다. 계정으로 로그인하면 계속할 수 있어요."
        )


async def guest_chat_gate(
    db: AsyncSession, user: User, attempt_id: uuid.UUID, *, what: str
) -> None:
    """게스트의 대화에만 추가로 걸리는 상한. 일반 응시자에게는 아무 일도 없다.

    두 겹인 이유가 있다. 분당 속도는 순간적인 폭주를, 응시당 총량은 하루 종일
    천천히 보내는 쪽을 막는다 — 한쪽만으로는 다른 쪽이 그대로 열린다.

    호출부(메신저·에이전트)는 이미 응시별 상한을 각자 걸고 있고, 이 함수는
    그 위에 얹힌다. 게스트 상한이 더 느슨하게 설정돼 있어도 기존 상한이
    풀리지는 않는다.
    """
    if user.role != GUEST_ROLE:
        return
    policy = await load_policy(db)
    # 계정 단위가 아니라 응시 단위로 센다: 게스트는 계정을 새로 만들기 쉽지만
    # 계정을 새로 만들어도 진행 중이던 응시는 따라오지 않는다.
    wait = check(f"guest:chat:{user.id}", per_min=policy.chat_per_min, burst=max(2, policy.chat_per_min // 2))
    if wait:
        raise too_many(wait, what)
    await assert_chat_quota(db, attempt_id=attempt_id, policy=policy)

"""접속 관리 — 게스트 정책과 주소 차단 (관리자 전용).

화면은 [설정] 페이지의 '게스트 접속' 카드 하나다. 경로를 /admin/settings 아래로
옮기지 않은 것은 이 라우터가 도메인(접속 통제)으로 묶여 있기 때문이며, 설정
페이지가 어떤 API 를 부르는지는 화면 구성의 문제다.

계정 정지만으로는 게스트를 막을 수 없다: 정지당한 사람이 새 게스트 계정을
만들어 1초 뒤 돌아온다. 그래서 '누구'(계정 정지, /admin/users)와
'어디서'(주소 차단, 여기)가 함께 있어야 조치가 성립한다.
"""

import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_db
from ..deps import require_admin
from ..guests import (
    GUEST_ROLE,
    GuestPolicy,
    blocked_entries,
    invalidate_cache,
    is_blocked,
    load_policy,
    normalize_cidr,
    save_policy,
)
from ..models import BlockedIp, Session, User, utcnow
from ..schemas import BlockedIpIn, BlockedIpOut, GuestPolicyIn, GuestPolicyOut

router = APIRouter(prefix="/admin/access", tags=["access"], dependencies=[Depends(require_admin)])


# ── 게스트 정책 ───────────────────────────────────────────────


@router.get("/guest", response_model=GuestPolicyOut)
async def get_guest_policy(db: AsyncSession = Depends(get_db)):
    return GuestPolicyOut(**(await load_policy(db)).to_value())


@router.put("/guest", response_model=GuestPolicyOut)
async def put_guest_policy(body: GuestPolicyIn, db: AsyncSession = Depends(get_db)):
    policy = await save_policy(db, GuestPolicy(**body.model_dump()))
    return GuestPolicyOut(**policy.to_value())


@router.get("/guest/stats")
async def guest_stats(db: AsyncSession = Depends(get_db)):
    """게스트 계정 현황 — 정책 화면에서 한도가 실제로 어떻게 쓰이는지 보이게."""

    async def count(*where) -> int:
        return int(
            (await db.execute(select(func.count()).select_from(User).where(*where))).scalar_one() or 0
        )

    from datetime import timedelta

    day_ago = utcnow() - timedelta(days=1)
    return {
        "total": await count(User.role == GUEST_ROLE),
        "active": await count(User.role == GUEST_ROLE, User.is_active.is_(True)),
        "last_24h": await count(User.role == GUEST_ROLE, User.created_at > day_ago),
        "blocked_entries": len(await blocked_entries(db)),
    }


# ── 주소 차단 ─────────────────────────────────────────────────


@router.get("/ip-blocks", response_model=list[BlockedIpOut])
async def list_ip_blocks(db: AsyncSession = Depends(get_db)):
    return (
        (await db.execute(select(BlockedIp).order_by(BlockedIp.created_at.desc()))).scalars().all()
    )


@router.post("/ip-blocks", response_model=BlockedIpOut)
async def add_ip_block(
    body: BlockedIpIn, db: AsyncSession = Depends(get_db), admin: User = Depends(require_admin)
):
    cidr = normalize_cidr(body.cidr)
    exists = (
        await db.execute(select(BlockedIp).where(BlockedIp.cidr == cidr))
    ).scalar_one_or_none()
    if exists:
        raise HTTPException(409, "이미 차단된 주소입니다")
    row = BlockedIp(cidr=cidr, reason=body.reason.strip(), created_by=admin.id)
    db.add(row)
    # 차단은 다음 로그인이 아니라 지금 걸려야 한다 — 이 주소에서 열려 있는
    # 세션을 그 자리에서 끊는다. 관리자 세션은 남긴다(자물쇠를 안에서 잠그지 않기).
    live = (
        (
            await db.execute(
                select(Session, User)
                .join(User, User.id == Session.user_id)
                .where(Session.revoked_at.is_(None), User.role != "admin")
            )
        )
        .all()
    )
    now = utcnow()
    revoked = 0
    for session, _ in live:
        if session.ip and is_blocked(session.ip, [cidr]):
            session.revoked_at = now
            session.revoked_reason = "ip_blocked"
            revoked += 1
    await db.commit()
    await db.refresh(row)
    invalidate_cache()
    return row


@router.delete("/ip-blocks/{block_id}")
async def remove_ip_block(block_id: uuid.UUID, db: AsyncSession = Depends(get_db)):
    row = await db.get(BlockedIp, block_id)
    if not row:
        raise HTTPException(404, "차단 항목을 찾을 수 없습니다")
    await db.delete(row)
    await db.commit()
    invalidate_cache()
    return {"ok": True}


@router.get("/ip-blocks/check")
async def check_ip(ip: str, db: AsyncSession = Depends(get_db)):
    """주소 하나가 지금 차단에 걸리는지 — 대역을 넣고 나서 확인용."""
    return {"ip": ip, "blocked": is_blocked(ip, await blocked_entries(db))}

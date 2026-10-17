"""접속 관리: 주소 차단 (관리자 전용).

차단은 '어디서'를 막는다. '누구'는 계정 정지(/admin/users)가 막는다. 판정은 :mod:`odysseus_api.ip_blocks`.
"""

import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_db
from ..deps import require_admin
from ..ip_blocks import blocked_entries, invalidate_cache, is_blocked, normalize_cidr
from ..models import BlockedIp, Session, User, utcnow
from ..schemas import BlockedIpIn, BlockedIpOut

router = APIRouter(prefix="/admin/access", tags=["access"], dependencies=[Depends(require_admin)])


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

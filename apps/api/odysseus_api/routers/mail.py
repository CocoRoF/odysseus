"""메일 보내기 — 파일을 쓰는 동시에 **보냈다는 사실**을 서버가 기록한다.

예전에는 메일 앱이 그냥 파일을 저장했다. 그러면 평가자에게 남는 것은 "이 문서를 썼다" 뿐이고,
받는 사람을 빠뜨렸는지·참조를 넣었는지·언제 보냈는지는 파일 머리글을 되짚어야 알 수 있었다.
사무 과제에서 그것들은 문서의 내용이 아니라 **행위**이고, 행위는 그 자체로 평가 대상이다.

그 기록을 브라우저가 보고하게 두지 않는다. 참고자료 조회를 서버가 직접 남기는 것과 같은 이유다
(reference.py) — 브라우저가 보고한 값은 위조할 수 있고, 위조할 수 있는 값은 평가의 근거가 되지
못한다. 그래서 보내기는 서버를 지나고, 파일과 기록이 **같은 한 번의 요청**에서 함께 만들어진다.

파일 모양은 지금까지와 같다(`받는사람:`/`참조:`/`제목:` 머리글 + 본문). 자동 채점의 file_contains
같은 체크가 그대로 읽어야 하기 때문이다. `날짜:` 는 붙이지 않는다 — 받은 편지함의 날짜는 시나리오가
정한 **이야기 속 날짜**이고, 거기에 실제 시계를 섞으면 시간선이 어긋난다. "언제 보냈는가" 는 기록의
created_at 이 답한다.

모양을 정하는 곳은 이제 여기 하나다. 화면에는 저장된 내용을 그대로 돌려주어, 같은 조립을 두 언어로
두 번 쓰지 않는다.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from .. import workspace as ws
from ..db import get_db
from ..deps import get_current_user
from ..models import Event, User
from ..ratelimit import enforce
from .attempts import require_app, require_own_active, scenario_in_attempt

router = APIRouter(tags=["mail"])


class MailSendIn(BaseModel):
    #: 받는 사람 — 이름을 쉼표로 이어 적는다 (화면에서 고른 인물의 이름)
    to: str = Field(default="", max_length=400)
    cc: str = Field(default="", max_length=400)
    subject: str = Field(default="", max_length=300)
    body: str = Field(default="", max_length=200_000)
    #: 이 메일이 남을 워크스페이스 경로
    path: str = Field(min_length=1, max_length=500)
    #: 원문을 인용해 보냈는가 (회신)
    quoted: bool = False


def format_mail(to: str, cc: str, subject: str, body: str) -> str:
    """파일 모양 — 웹의 lib/mail.formatMail 과 같아야 한다. 한쪽만 고치면 채점이 어긋난다."""
    head = [f"받는사람: {to.strip()}"]
    if cc.strip():
        head.append(f"참조: {cc.strip()}")
    head.append(f"제목: {subject.strip()}")
    return "\n".join(head) + "\n\n" + body.rstrip() + "\n"


@router.post("/attempts/{attempt_id}/scenarios/{scenario_id}/mail")
async def send_mail(
    attempt_id: uuid.UUID,
    scenario_id: uuid.UUID,
    body: MailSendIn,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    attempt = await require_own_active(attempt_id, user, db)
    scenario = await scenario_in_attempt(attempt, scenario_id, db, user, mutate=True)
    require_app(scenario, "mail")
    enforce(f"mail:{attempt_id}", per_min=30, burst=10, what="메일 보내기")

    if not body.subject.strip():
        raise HTTPException(400, "제목이 비어 있습니다")

    content = format_mail(body.to, body.cc, body.subject, body.body)
    try:
        row, created = await ws.save_file(
            db, attempt_id, scenario_id, body.path, content, actor="mail"
        )
    except ws.WorkspaceError as e:
        raise HTTPException(e.code, e.message)

    # 행위를 남긴다 — 파일 내용과 달리 이것은 "보냈다" 는 사실이다.
    db.add(
        Event(
            attempt_id=attempt_id,
            scenario_id=scenario_id,
            type="mail_sent",
            # 서버가 본 사실이다 (ODY-017) — 브라우저 보고가 아니므로 부정 판단의 근거로 쓸 수 있다.
            source="server",
            payload={
                "to": body.to.strip(),
                "cc": body.cc.strip(),
                "subject": body.subject.strip(),
                "path": row.path,
                "words": len([w for w in body.body.split() if w]),
                "quoted": bool(body.quoted),
                "created": bool(created),
            },
        )
    )
    await db.commit()
    return {"path": row.path, "content": content, "sha256": ws.content_sha256(content)}

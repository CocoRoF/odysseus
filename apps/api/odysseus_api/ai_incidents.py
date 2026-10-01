"""AI 실패 턴의 단일 정의 — 횟수 환불과 평가자 고지가 같은 기준을 본다.

응시자의 질문 한 번은 **답을 받았을 때** 소모된다. 공급자가 타임아웃·한도·인증·연결로
답을 하나도 만들지 못했다면 그것은 응시자가 쓴 질문이 아니라 우리 쪽 사고이므로, 남은 횟수에서
빼지 않는다. 질문 한도는 응시 전략의 일부다 — 그래서 반대 방향도 똑같이 엄격하다.

**환불은 기록할 때 한 번 정하고 ``meta.refunded`` 로 남긴다.** 읽을 때마다 코드 목록으로 다시
판단하면, 목록을 바꾸는 순간 진행 중인 응시의 남은 횟수가 소급해서 바뀌고, 이미 저장된 "이 질문은
남은 횟수에 포함되지 않습니다" 문구와 숫자가 어긋난다. 메신저·에이전트·게스트 총량·평가자 화면은
전부 이 플래그만 센다.

실패는 **응답 행의 meta** 에만 남는다. 사용자 메시지는 호출 전에 커밋되므로,
"실패한 사용자 턴" 은 그 다음에 저장된 응답 행으로만 알 수 있다.
"""

from __future__ import annotations

import uuid
from datetime import timedelta

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from .models import AgentMessage, MessengerMessage, utcnow

#: 답을 하나도 받지 못했을 때 되돌려 주는 코드 — 공급자 귀책 (ai/errors.py 의 분류와 같은 이름).
#:
#: ``AI_BAD_RESPONSE``·``AI_BACKEND_ERROR`` 는 응시자가 보낸 내용이나 도구 실행이 원인일 수 있어 뺀다.
REFUNDABLE_CODES = frozenset({"AI_TIMEOUT", "AI_RATE_LIMIT", "AI_QUOTA", "AI_AUTH", "AI_UNAVAILABLE"})

#: 응시자 쪽에서 끝난 턴 — 장애가 아니다. 평가자에게 "AI 사고" 로 세면 응시자가 스스로 끊은
#: 대화를 장애로 읽게 되므로 사고 집계·관리 화면의 AI 오류·공급자 장애 배너 어디에서도 세지 않는다.
#:
#: - ``AI_CANCELLED``: 응시자가 [중단] 을 눌렀고, 그때까지 아무것도 나오지 않았다.
#: - ``AI_DISCONNECTED``: 새로고침·창 닫기·네트워크로 끊겼고, 그때까지 아무것도 나오지 않았다.
#: - ``AI_INTERRUPTED``: 위 둘 중 하나로 끊겼지만 답이 일부 왔거나 도구가 이미 돌기 시작했다.
CANDIDATE_ENDED_CODES = frozenset({"AI_CANCELLED", "AI_DISCONNECTED", "AI_INTERRUPTED"})

#: 응시자 쪽에서 끝났지만, 아무것도 나오지 않았을 때만 붙는 코드 — 그래서 돌려줄 수 있다.
_ENDED_BEFORE_OUTPUT = frozenset({"AI_CANCELLED", "AI_DISCONNECTED"})


def refund_decision(code: str | None, *, produced_output: bool, tools_started: bool) -> bool:
    """이 실패한 턴의 질문을 돌려줄 것인가.

    돌려주는 조건은 둘 다다: 코드가 공급자 귀책이거나 응시자가 아무것도 받기 전에 끝냈고,
    **공급자에게서 아무것도 나오지 않았다** — 글자 하나도, 시작된 도구 하나도.

    응시자가 멈추거나 새로고침한 턴도 같은 기준이다. 아무것도 나오기 전이면 그 질문은 쓰이지
    않았다. 반대로 한 글자라도 받았거나 도구가 한 번이라도 돌기 시작했으면 소모한다 — 에이전트가
    파일을 고치는 것을 보고 [중단] 을 누르는 것이 공짜 작업이 되면 질문 한도가 사라진다.
    """
    if not code or not (code in REFUNDABLE_CODES or code in _ENDED_BEFORE_OUTPUT):
        return False
    return not produced_output and not tools_started


def candidate_ended_code(*, stopped: bool, produced_output: bool, tools_started: bool) -> str:
    """응시자 쪽에서 끝난 턴의 코드 — 무엇이 나왔는가가 먼저고, 누가 끝냈는가는 그다음이다."""
    if produced_output or tools_started:
        return "AI_INTERRUPTED"
    return "AI_CANCELLED" if stopped else "AI_DISCONNECTED"


def failure_meta(
    code: str,
    correlation_id: str | None = None,
    *,
    produced_output: bool,
    tools_started: bool,
) -> dict:
    """실패한 응답 행에 남길 meta — 환불 결정까지 여기서 한 번에 정한다."""
    meta: dict = {"error": code}
    if correlation_id:
        meta["correlation_id"] = correlation_id
    if refund_decision(code, produced_output=produced_output, tools_started=tools_started):
        meta["refunded"] = True
    return meta


#: "공급자가 아프다" 고 볼 코드 — 한도·소진·인증·연결·지연. 응답 해석 실패나 응시자가 끝낸 턴은 뺀다.
PROVIDER_FAULT_CODES = REFUNDABLE_CODES

#: 이 건수를 넘으면 관리 콘솔에 배너를 세운다. 한두 건은 흔한 일시 오류이므로 알리지 않는다 —
#: 알림이 흔해지면 아무도 보지 않게 되고, 그러면 진짜 소진도 놓친다.
OUTAGE_ALERT_THRESHOLD = 3


def _npc_failures():
    """실패한 NPC 응답 행 — sender 가 npc 이고 meta.error 가 있는 것."""
    return (MessengerMessage.sender == "npc", MessengerMessage.meta["error"].astext.isnot(None))


def _agent_failures():
    """실패한 에이전트 응답 행 — role 이 assistant 이고 meta.error 가 있는 것."""
    return (AgentMessage.role == "assistant", AgentMessage.meta["error"].astext.isnot(None))


async def refunded_messenger(db: AsyncSession, attempt_id: uuid.UUID) -> int:
    """이 응시에서 돌려준 메신저 질문 수 — 기록할 때 정한 플래그만 센다."""
    return int(
        (
            await db.execute(
                select(func.count())
                .select_from(MessengerMessage)
                .where(
                    MessengerMessage.attempt_id == attempt_id,
                    *_npc_failures(),
                    MessengerMessage.meta["refunded"].astext == "true",
                )
            )
        ).scalar_one()
        or 0
    )


async def refunded_agent(db: AsyncSession, attempt_id: uuid.UUID) -> int:
    """이 응시에서 돌려준 에이전트 질문 수 — 기록할 때 정한 플래그만 센다."""
    return int(
        (
            await db.execute(
                select(func.count())
                .select_from(AgentMessage)
                .where(
                    AgentMessage.attempt_id == attempt_id,
                    *_agent_failures(),
                    AgentMessage.meta["refunded"].astext == "true",
                )
            )
        ).scalar_one()
        or 0
    )


async def recent_failures(db: AsyncSession, *, minutes: int = 15) -> dict:
    """최근 N 분의 AI 실패를 모델별·코드별로 센다 — 관리자가 장애를 **사전에** 알기 위한 것.

    별도 저장소를 두지 않는다. 실패는 이미 응답 행의 ``meta.error`` 에 모델명과 시각과 함께
    남아 있고, 그것이 평가자 화면이 보는 것과 같은 정본이다. 따로 카운터를 굴리면 기동할 때
    사라지거나 화면마다 숫자가 달라진다.

    지금까지 관리자가 공급자 소진을 아는 유일한 경로는 **응시자의 항의**였다. 항의하지 않는
    응시자는 조용히 손해를 봤다. 응시자가 멈추거나 끊은 턴(:data:`CANDIDATE_ENDED_CODES`)은
    장애가 아니므로 세지 않는다 — 세면 시험이 몰린 시간마다 거짓 경보가 선다.
    """
    since = utcnow() - timedelta(minutes=max(1, minutes))
    by_model: dict[str, dict[str, int]] = {}
    total = 0
    # 반복 변수를 model 로 두면 아래의 model.model(모델명 컬럼)과 눈으로 구분되지 않는다.
    for table, where in (
        (MessengerMessage, _npc_failures()),
        (AgentMessage, _agent_failures()),
    ):
        code_col = table.meta["error"].astext.label("code")
        rows = (
            await db.execute(
                select(code_col, table.model, func.count())
                .where(
                    table.created_at >= since,
                    *where,
                    table.meta["error"].astext.notin_(CANDIDATE_ENDED_CODES),
                )
                .group_by(code_col, table.model)
            )
        ).all()
        for code, model_name, n in rows:
            key = str(model_name or "(알 수 없음)")
            bucket = by_model.setdefault(key, {})
            bucket[str(code or "AI_BACKEND_ERROR")] = bucket.get(str(code or "AI_BACKEND_ERROR"), 0) + int(n)
            total += int(n)
    # 공급자 귀책(한도·인증·연결·지연)만 "장애" 로 센다. 응답 해석 실패는 모델이 살아 있다는 뜻이다.
    outages = sum(
        n for codes in by_model.values() for code, n in codes.items() if code in PROVIDER_FAULT_CODES
    )
    return {
        "window_minutes": minutes,
        "total": total,
        "provider_faults": outages,
        "by_model": by_model,
        "degraded": outages >= OUTAGE_ALERT_THRESHOLD,
    }


async def incident_counts(db: AsyncSession, attempt_ids: list[uuid.UUID]) -> dict[uuid.UUID, int]:
    """응시마다 AI 사고 건수 — 관리 화면이 보정할지 판단하는 근거. 평가자 집계(:func:`incidents`)와 같은 기준이다."""
    counts: dict[uuid.UUID, int] = {}
    if not attempt_ids:
        return counts
    for table, where in ((MessengerMessage, _npc_failures()), (AgentMessage, _agent_failures())):
        rows = await db.execute(
            select(table.attempt_id, func.count())
            .where(
                table.attempt_id.in_(attempt_ids),
                *where,
                table.meta["error"].astext.notin_(CANDIDATE_ENDED_CODES),
            )
            .group_by(table.attempt_id)
        )
        for aid, n in rows.all():
            counts[aid] = counts.get(aid, 0) + int(n)
    return counts


async def incidents(db: AsyncSession, attempt_id: uuid.UUID) -> dict:
    """평가자에게 보여줄 AI 사고 집계 — 대화 원문은 넣지 않는다.

    환불 대상이 아닌 오류도 함께 센다. 채점자가 "이 응시 중에 무슨 일이 있었는가" 를
    판단하는 데는 원인 구분보다 **기록이 온전한가** 가 먼저이기 때문이다. 다만 응시자 쪽에서
    끊은 턴(:data:`CANDIDATE_ENDED_CODES`)은 사고가 아니므로 세지 않는다.
    """
    by_code: dict[str, int] = {}
    messenger = agent = refunded = 0
    for model, where, bucket in (
        (MessengerMessage, _npc_failures(), "messenger"),
        (AgentMessage, _agent_failures(), "agent"),
    ):
        # JSONB 경로는 바인드 파라미터로 나가므로 SELECT 와 GROUP BY 에 같은 식을 따로 만들면
        # PostgreSQL 이 서로 다른 식으로 본다 ("must appear in the GROUP BY clause").
        # 식 하나를 레이블로 만들어 두 자리에 같은 객체를 쓴다.
        code_col = model.meta["error"].astext.label("code")
        rows = (
            await db.execute(
                select(
                    code_col,
                    func.count(),
                    func.count().filter(model.meta["refunded"].astext == "true"),
                )
                .where(
                    model.attempt_id == attempt_id,
                    *where,
                    model.meta["error"].astext.notin_(CANDIDATE_ENDED_CODES),
                )
                .group_by(code_col)
            )
        ).all()
        for code, n, back in rows:
            key = str(code or "AI_BACKEND_ERROR")
            by_code[key] = by_code.get(key, 0) + int(n)
            refunded += int(back or 0)
            if bucket == "messenger":
                messenger += int(n)
            else:
                agent += int(n)
    return {
        "total": messenger + agent,
        "messenger": messenger,
        "agent": agent,
        "by_code": by_code,
        # 응시자에게 횟수를 돌려준 건수 — 남은 질문 수가 왜 다른지 설명한다.
        "refunded": refunded,
    }

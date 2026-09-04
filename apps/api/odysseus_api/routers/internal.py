"""러너·MCP 브리지 → API 내부 콜백.

세 겹으로 지킨다 (ODY-002):

1. **경계** — 이 라우터는 엣지(nginx)의 `/api/internal/` 에서 404 로 막히고, api 컨테이너의
   호스트 포트는 127.0.0.1 에만 묶인다. 프록시를 거친 흔적(`X-Forwarded-*`)이 있는 요청은
   토큰이 맞아도 404 다 — 내부 호출자는 프록시를 지나지 않는다.
2. **토큰** — `X-Internal-Token` 을 상수 시간 비교한다. 알려진 기본값은 기동 시 거부된다
   (config.check_startup_security). 실패는 토큰 값 없이 감사 로그에 남긴다.
3. **범위** — 도구 실행은 응시가 진행 중이고, 시나리오가 그 시험에 속하며, **지금 순서**의
   시나리오일 때만 된다. 실행 결과 콜백은 실행마다 발급된 일회용 `X-Execution-Token` 이
   맞아야 하고, 끝난 실행에는 다시 쓸 수 없다.
"""

import logging
import secrets
import uuid

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import workspace as ws
from ..config import settings
from ..db import get_db
from ..models import AssessmentScenario, Attempt, Event, Execution, Scenario, utcnow
from ..schemas import InternalAgentToolIn, InternalRunResultIn

log = logging.getLogger("odysseus.internal")

router = APIRouter(prefix="/internal", tags=["internal"])

PROXY_HEADERS = ("x-forwarded-for", "x-forwarded-proto", "x-forwarded-host", "x-real-ip", "via")


def _client(request: Request) -> str:
    return request.client.host if request.client else "?"


def verify_internal(request: Request, x_internal_token: str = Header(default="")):
    """내부 토큰 검증 + 경계 검증. 실패 사유는 로그에만, 응답은 정보를 주지 않는다."""
    # 프록시를 지나온 요청은 내부 호출일 수 없다 — 토큰을 보기 전에 자른다
    if any(h in request.headers for h in PROXY_HEADERS):
        log.warning("internal: proxied request rejected path=%s from=%s", request.url.path, _client(request))
        raise HTTPException(404, "Not Found")
    expected = settings.internal_token
    if not expected or not secrets.compare_digest(x_internal_token.encode(), expected.encode()):
        log.warning(
            "internal: bad token path=%s from=%s presented=%s",
            request.url.path,
            _client(request),
            "yes" if x_internal_token else "no",
        )
        raise HTTPException(401, "invalid internal token")


def _verify_execution_token(execution: Execution, presented: str, request: Request) -> None:
    """실행별 일회용 콜백 토큰 — 큐에 실린 값을 아는 러너만 결과를 보고할 수 있다."""
    expected = execution.callback_token or ""
    if not expected or not presented or not secrets.compare_digest(presented.encode(), expected.encode()):
        log.warning(
            "internal: bad execution token execution=%s from=%s presented=%s",
            execution.id,
            _client(request),
            "yes" if presented else "no",
        )
        raise HTTPException(401, "invalid execution token")


@router.get("/agent-tools", dependencies=[Depends(verify_internal)])
async def agent_tools():
    """에이전트 도구 정의 — MCP 브리지가 그대로 노출한다 (API tools= 와 동일 목록)."""
    from ..ai.agent import AGENT_TOOLS

    return {"tools": AGENT_TOOLS}


@router.post("/agent-tool", dependencies=[Depends(verify_internal)])
async def agent_tool(body: InternalAgentToolIn, request: Request, db: AsyncSession = Depends(get_db)):
    """MCP 브리지가 호출하는 도구 실행 표면.

    다른 공급자가 ``tools=`` 로 받는 것과 **같은 구현**(execute_agent_tool)을 지나므로
    공급자에 따라 동작이 갈리지 않는다. 범위(응시/시나리오)는 브리지 기동 시 환경변수로
    고정되지만, 여기서 다시 검증한다 — 본문은 신뢰하지 않는다.
    """
    from ..ai.agent import execute_agent_tool

    attempt = await db.get(Attempt, body.attempt_id)
    if not attempt:
        raise HTTPException(404, "attempt not found")
    if attempt.status != "in_progress":
        return {"result": "이미 종료된 시험이라 워크스페이스를 변경할 수 없습니다", "is_error": True}
    if not await db.get(Scenario, body.scenario_id):
        raise HTTPException(404, "scenario not found")

    # 시나리오가 이 시험에 속하고, 지금 진행 중인 순서여야 한다 (잠긴/제출한 문제는 거부)
    link = (
        await db.execute(
            select(AssessmentScenario).where(
                AssessmentScenario.assessment_id == attempt.assessment_id,
                AssessmentScenario.scenario_id == body.scenario_id,
            )
        )
    ).scalar_one_or_none()
    if not link:
        log.warning(
            "internal: scenario not in assessment attempt=%s scenario=%s from=%s",
            attempt.id,
            body.scenario_id,
            _client(request),
        )
        raise HTTPException(404, "scenario not in this assessment")
    if link.ordinal != attempt.current_ordinal:
        log.warning(
            "internal: out-of-order scenario attempt=%s scenario=%s ordinal=%s current=%s",
            attempt.id,
            body.scenario_id,
            link.ordinal,
            attempt.current_ordinal,
        )
        return {
            "result": (
                "거부됨: 지금 진행 중인 문제가 아닙니다"
                + (" (아직 잠긴 문제)" if link.ordinal > attempt.current_ordinal else " (이미 제출한 문제)")
            ),
            "is_error": True,
        }

    result, _detail = await execute_agent_tool(
        db, attempt.id, body.scenario_id, attempt.user_id, body.name, body.input or {}
    )
    is_error = result.startswith("거부됨") or result.startswith("알 수 없는 도구")
    return {"result": result, "is_error": is_error}


@router.post("/executions/{execution_id}/running", dependencies=[Depends(verify_internal)])
async def mark_running(
    execution_id: uuid.UUID,
    request: Request,
    x_execution_token: str = Header(default=""),
    db: AsyncSession = Depends(get_db),
):
    execution = await db.get(Execution, execution_id)
    if not execution:
        raise HTTPException(404, "execution not found")
    _verify_execution_token(execution, x_execution_token, request)
    if execution.status == "queued":
        execution.status = "running"
        await db.commit()
    return {"ok": True}


def _pg_safe(text: str) -> str:
    return text.replace("\x00", "") if text else ""


@router.post("/executions/{execution_id}/result", dependencies=[Depends(verify_internal)])
async def report_result(
    execution_id: uuid.UUID,
    body: InternalRunResultIn,
    request: Request,
    x_execution_token: str = Header(default=""),
    db: AsyncSession = Depends(get_db),
):
    execution = await db.get(Execution, execution_id)
    if not execution:
        raise HTTPException(404, "execution not found")
    _verify_execution_token(execution, x_execution_token, request)
    if execution.status in ("done", "error"):
        return {"ok": True, "duplicate": True}

    execution.status = body.status
    execution.exit_code = body.exit_code
    # NUL 은 Postgres text 가 저장하지 못한다 — 여기서 걸러야 바이너리를 출력한
    # 명령 때문에 결과 보고 전체가 실패하고 실행이 영영 '실행 중'으로 남지 않는다.
    execution.stdout = _pg_safe(body.stdout)[: 4 * 1024 * 1024]
    execution.stderr = _pg_safe(body.stderr)[: 64 * 1024]
    execution.time_ms = body.time_ms
    execution.finished_at = utcnow()
    # 한 번 소비된 토큰은 지운다 — 같은 실행에 두 번째 보고는 위 duplicate 분기와 무관하게 401
    execution.callback_token = None

    # 실행이 만든 파일 변경을 워크스페이스에 반영 (체크 실행은 채점용 — 반영하지 않는다)
    applied: list[dict] = []
    if execution.source in ("ide", "agent"):
        for change in body.changed_files[:60]:
            path = str(change.get("path", ""))
            try:
                if change.get("deleted"):
                    ok = await ws.delete_file(
                        db, execution.attempt_id, execution.scenario_id, path, actor="run"
                    )
                    if ok:
                        applied.append({"path": path, "action": "deleted"})
                else:
                    content = _pg_safe(str(change.get("content", "")))
                    _row, created = await ws.save_file(
                        db,
                        execution.attempt_id,
                        execution.scenario_id,
                        path,
                        content,
                        actor="run",
                        record_event=False,
                    )
                    applied.append({"path": path, "action": "created" if created else "modified"})
            except ws.WorkspaceError:
                continue  # 한도/경로 위반 파일은 무시
    execution.changed_files = applied

    db.add(
        Event(
            attempt_id=execution.attempt_id,
            scenario_id=execution.scenario_id,
            type="run_done",
            payload={
                "command": execution.command[:200],
                "exit_code": body.exit_code,
                "status": body.status,
                "changed": [c["path"] for c in applied],
                "actor": execution.source,
            },
        )
    )
    await db.commit()
    return {"ok": True}

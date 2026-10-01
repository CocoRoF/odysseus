"""러너·MCP 브리지 → API 내부 콜백.

세 겹으로 지킨다 (ODY-002):

1. **경계** — 이 라우터는 엣지(nginx)의 `/api/internal/` 에서 404 로 막히고, api 컨테이너의
   호스트 포트는 127.0.0.1 에만 묶인다. 프록시를 거친 흔적(`X-Forwarded-*`)이 있는 요청은
   토큰이 맞아도 404 다 — 내부 호출자는 프록시를 지나지 않는다.
2. **토큰** — `X-Internal-Token` 을 상수 시간 비교한다. 알려진 기본값은 기동 시 거부된다.
3. **범위** — 도구 실행은 응시가 진행 중이고, **응시 시작 때 고정된 definition**에 시나리오가
   있으며 현재 순서일 때만 된다. 결과 콜백은 실행별 일회용 토큰이 맞아야 한다.
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
from ..definitions import definition_for_attempt, scenario_from_definition
from ..models import Attempt, Event, Execution, utcnow
from ..schemas import InternalAgentToolIn, InternalRunResultIn

log = logging.getLogger("odysseus.internal")

router = APIRouter(prefix="/internal", tags=["internal"])

PROXY_HEADERS = ("x-forwarded-for", "x-forwarded-proto", "x-forwarded-host", "x-real-ip", "via")


def _client(request: Request) -> str:
    return request.client.host if request.client else "?"


def verify_internal(request: Request, x_internal_token: str = Header(default="")):
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
    from ..ai.agent import AGENT_TOOLS

    return {"tools": AGENT_TOOLS}


@router.post("/agent-tool", dependencies=[Depends(verify_internal)])
async def agent_tool(body: InternalAgentToolIn, request: Request, db: AsyncSession = Depends(get_db)):
    """MCP bridge tool execution, scoped to the immutable attempt definition."""
    from ..ai.agent import execute_agent_tool

    attempt = await db.get(Attempt, body.attempt_id)
    if not attempt:
        raise HTTPException(404, "attempt not found")
    if attempt.status != "in_progress" or utcnow() > attempt.deadline_at:
        return {"result": "이미 종료된 시험이라 워크스페이스를 변경할 수 없습니다", "is_error": True}

    definition = await definition_for_attempt(db, attempt, persist_legacy=False)
    frozen_scenario = scenario_from_definition(definition, body.scenario_id)
    if not frozen_scenario:
        log.warning(
            "internal: scenario not in frozen attempt definition attempt=%s scenario=%s from=%s",
            attempt.id,
            body.scenario_id,
            _client(request),
        )
        raise HTTPException(404, "scenario not in this attempt")
    if frozen_scenario.ordinal != attempt.current_ordinal:
        log.warning(
            "internal: out-of-order scenario attempt=%s scenario=%s ordinal=%s current=%s",
            attempt.id,
            body.scenario_id,
            frozen_scenario.ordinal,
            attempt.current_ordinal,
        )
        return {
            "result": (
                "거부됨: 지금 진행 중인 문제가 아닙니다"
                + (" (아직 잠긴 문제)" if frozen_scenario.ordinal > attempt.current_ordinal else " (이미 제출한 문제)")
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
        db.add(
            Event(
                attempt_id=execution.attempt_id,
                scenario_id=execution.scenario_id,
                type="run_started",
                payload={"execution_id": str(execution.id), "actor": execution.source},
            )
        )
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
    # 응시 행을 잠근 채 상태를 본다 — finalize_attempt 와 직렬화되어 "제출 직후 반영" 이 끼어들 수 없다
    attempt = (
        await db.execute(select(Attempt).where(Attempt.id == execution.attempt_id).with_for_update())
    ).scalar_one_or_none()
    frozen = attempt is None or attempt.status != "in_progress" or utcnow() > attempt.deadline_at

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
    execution.input_files = None  # 재전송용 스냅샷은 더 필요 없다

    # 실행이 만든 파일 변경을 워크스페이스에 반영 (체크 실행은 채점용 — 반영하지 않는다)
    applied: list[dict] = []
    if frozen and body.changed_files:
        log.warning(
            "internal: late result after finalize — files discarded execution=%s attempt=%s changed=%d",
            execution.id,
            execution.attempt_id,
            len(body.changed_files),
        )
    if execution.source in ("ide", "agent") and not frozen:
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
                continue
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
                **({"discarded_after_finalize": len(body.changed_files)} if frozen and body.changed_files else {}),
            },
        )
    )
    await db.commit()
    return {"ok": True}

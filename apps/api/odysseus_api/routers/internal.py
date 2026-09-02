"""러너 → API 내부 콜백. X-Internal-Token으로 보호."""

import uuid

from fastapi import APIRouter, Depends, Header, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from .. import workspace as ws
from ..config import settings
from ..db import get_db
from ..models import Attempt, Event, Execution, Scenario, utcnow
from ..schemas import InternalAgentToolIn, InternalRunResultIn

router = APIRouter(prefix="/internal", tags=["internal"])


def verify_internal(x_internal_token: str = Header(default="")):
    if x_internal_token != settings.internal_token:
        raise HTTPException(401, "invalid internal token")


@router.get("/agent-tools", dependencies=[Depends(verify_internal)])
async def agent_tools():
    """에이전트 도구 정의 — MCP 브리지가 그대로 노출한다 (API tools= 와 동일 목록)."""
    from ..ai.agent import AGENT_TOOLS

    return {"tools": AGENT_TOOLS}


@router.post("/agent-tool", dependencies=[Depends(verify_internal)])
async def agent_tool(body: InternalAgentToolIn, db: AsyncSession = Depends(get_db)):
    """MCP 브리지가 호출하는 도구 실행 표면.

    다른 공급자가 ``tools=`` 로 받는 것과 **같은 구현**(execute_agent_tool)을 지나므로
    공급자에 따라 동작이 갈리지 않는다. 범위(응시/시나리오)는 호출자가 아니라
    브리지 기동 시 고정된 환경변수로 정해진다.
    """
    from ..ai.agent import execute_agent_tool

    attempt = await db.get(Attempt, body.attempt_id)
    if not attempt:
        raise HTTPException(404, "attempt not found")
    if attempt.status != "in_progress":
        return {"result": "이미 종료된 시험이라 워크스페이스를 변경할 수 없습니다", "is_error": True}
    if not await db.get(Scenario, body.scenario_id):
        raise HTTPException(404, "scenario not found")

    result, _detail = await execute_agent_tool(
        db, attempt.id, body.scenario_id, attempt.user_id, body.name, body.input or {}
    )
    is_error = result.startswith("거부됨") or result.startswith("알 수 없는 도구")
    return {"result": result, "is_error": is_error}


@router.post("/executions/{execution_id}/running", dependencies=[Depends(verify_internal)])
async def mark_running(execution_id: uuid.UUID, db: AsyncSession = Depends(get_db)):
    execution = await db.get(Execution, execution_id)
    if execution and execution.status == "queued":
        execution.status = "running"
        await db.commit()
    return {"ok": True}


@router.post("/executions/{execution_id}/result", dependencies=[Depends(verify_internal)])
async def report_result(
    execution_id: uuid.UUID, body: InternalRunResultIn, db: AsyncSession = Depends(get_db)
):
    execution = await db.get(Execution, execution_id)
    if not execution:
        raise HTTPException(404, "execution not found")
    if execution.status in ("done", "error"):
        return {"ok": True, "duplicate": True}

    execution.status = body.status
    execution.exit_code = body.exit_code
    execution.stdout = body.stdout[: 4 * 1024 * 1024]
    execution.stderr = body.stderr[: 64 * 1024]
    execution.time_ms = body.time_ms
    execution.finished_at = utcnow()

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
                    content = str(change.get("content", ""))
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

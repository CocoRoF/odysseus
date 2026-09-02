"""응시자 전용 AI 에이전트 — 워크스페이스를 직접 조작하는 도구 루프.

에이전트는 시나리오에 대한 어떤 정보도 주입받지 않는다(제로 컨텍스트).
응시자가 채팅으로 전달한 내용 + 워크스페이스 파일 + 실행 결과만 안다.
평가 관점에서 '에이전트에게 무엇을 어떻게 시켰는가'가 그대로 기록으로 남는다.
"""

import asyncio
import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from .. import workspace as ws
from ..config import settings
from ..models import Event, Execution
from ..runqueue import enqueue_run
from . import provider

SYSTEM_PROMPT = """당신은 사용자의 개발 작업을 돕는 AI 어시스턴트입니다. 도구로 워크스페이스의 파일을 직접 읽고 쓰고, 명령을 실행할 수 있습니다.

규칙:
- 당신에게는 과제나 배경에 대한 정보가 전혀 제공되지 않습니다. 사용자가 알려준 내용과 워크스페이스에서 직접 확인한 것만 근거로 삼고, 모르는 것을 아는 척 추측하지 마세요.
- 파일을 수정하기 전에 먼저 읽어 현재 상태를 확인하세요.
- 실행 결과(stdout/exit code)를 근거로 검증하고, 실패하면 원인을 확인한 뒤 고치세요.
- 하지 않은 일을 했다고 말하지 마세요. 작업을 마치면 무엇을 바꿨는지 짧게 요약하세요.
- 한국어로 답하세요."""

CHAT_ONLY_SYSTEM_PROMPT = """당신은 사용자의 개발 작업을 돕는 AI 어시스턴트입니다.

현재 연결된 모델은 도구 호출을 지원하지 않아 파일을 직접 읽거나 수정할 수 없습니다 — 했다고 말하지 마세요.
사용자가 붙여넣어 준 내용만 근거로 조언하고, 코드는 사용자가 복사해 쓸 수 있는 완성된 형태로 제시하세요. 한국어로 답하세요."""

AGENT_TOOLS: list[dict] = [
    {
        "name": "list_files",
        "description": "워크스페이스의 전체 파일 목록(경로·크기)을 반환합니다.",
        "input_schema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "read_file",
        "description": "파일 하나의 내용을 읽습니다.",
        "input_schema": {
            "type": "object",
            "properties": {"path": {"type": "string", "description": "파일 경로 (예: src/main.py)"}},
            "required": ["path"],
            "additionalProperties": False,
        },
    },
    {
        "name": "write_file",
        "description": "파일을 생성하거나 내용 전체를 교체합니다.",
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "content": {"type": "string", "description": "파일 전체 내용"},
            },
            "required": ["path", "content"],
            "additionalProperties": False,
        },
    },
    {
        "name": "delete_file",
        "description": "파일을 삭제합니다.",
        "input_schema": {
            "type": "object",
            "properties": {"path": {"type": "string"}},
            "required": ["path"],
            "additionalProperties": False,
        },
    },
    {
        "name": "run_command",
        "description": "워크스페이스 루트에서 셸 명령을 실행하고 stdout/stderr/exit code를 반환합니다. 실행으로 생긴 파일 변경은 워크스페이스에 반영됩니다. (python3 사용 가능, 네트워크 없음)",
        "input_schema": {
            "type": "object",
            "properties": {"command": {"type": "string", "description": "예: python3 main.py"}},
            "required": ["command"],
            "additionalProperties": False,
        },
    },
]

TOOL_RESULT_CAP = 24_000
RUN_WAIT_S = 60.0


async def _wait_execution(db: AsyncSession, execution_id: uuid.UUID) -> Execution | None:
    """러너 완료 대기 — 콜백은 다른 세션에서 커밋되므로 populate_existing으로 재조회."""
    deadline = asyncio.get_event_loop().time() + RUN_WAIT_S
    while asyncio.get_event_loop().time() < deadline:
        row = await db.get(Execution, execution_id, populate_existing=True)
        if row and row.status in ("done", "error"):
            return row
        await asyncio.sleep(0.6)
    return await db.get(Execution, execution_id, populate_existing=True)


async def execute_agent_tool(
    db: AsyncSession,
    attempt_id: uuid.UUID,
    scenario_id: uuid.UUID,
    user_id: uuid.UUID,
    name: str,
    tool_input: dict,
) -> tuple[str, str]:
    """도구 실행 → (결과 문자열, 사용자에게 보여줄 상세 라벨)."""
    try:
        if name == "list_files":
            rows = await ws.list_files(db, attempt_id, scenario_id)
            if not rows:
                return "(워크스페이스가 비어 있습니다)", "목록"
            lines = [f"{r.path} ({len(r.content.encode('utf-8', errors='ignore'))} bytes)" for r in rows]
            return "\n".join(lines), "목록"

        if name == "read_file":
            path = ws.normalize_path(str(tool_input.get("path", "")))
            row = await ws.get_file(db, attempt_id, scenario_id, path)
            if not row:
                return f"파일이 없습니다: {path}", path
            content = row.content
            if len(content) > TOOL_RESULT_CAP:
                content = content[:TOOL_RESULT_CAP] + "\n…(이하 생략)"
            return content, path

        if name == "write_file":
            path = str(tool_input.get("path", ""))
            content = str(tool_input.get("content", ""))
            row, created = await ws.save_file(
                db, attempt_id, scenario_id, path, content, actor="agent"
            )
            await db.commit()
            return f"저장됨: {row.path} ({len(content)}자)", row.path

        if name == "delete_file":
            path = str(tool_input.get("path", ""))
            ok = await ws.delete_file(db, attempt_id, scenario_id, path, actor="agent")
            await db.commit()
            return ("삭제됨: " if ok else "파일이 없습니다: ") + path, path

        if name == "run_command":
            command = str(tool_input.get("command", "")).strip()
            if not command or len(command) > settings.run_command_max_len:
                return "명령이 비어 있거나 너무 깁니다", command[:60]
            execution = Execution(
                attempt_id=attempt_id,
                scenario_id=scenario_id,
                user_id=user_id,
                source="agent",
                command=command,
            )
            db.add(execution)
            db.add(
                Event(
                    attempt_id=attempt_id,
                    scenario_id=scenario_id,
                    type="run_request",
                    payload={"command": command[:200], "actor": "agent"},
                )
            )
            await db.commit()
            rows = await ws.list_files(db, attempt_id, scenario_id)
            await enqueue_run(str(execution.id), command, ws.files_payload(rows), settings.run_timeout_s)
            done = await _wait_execution(db, execution.id)
            if not done or done.status not in ("done", "error"):
                return "실행이 제한 시간 안에 끝나지 않았습니다", command[:60]
            # 콜백 세션의 파일 변경은 워크스페이스 조회의 populate_existing이 흡수한다
            parts = [f"exit code: {done.exit_code}"]
            if done.stdout:
                parts.append(f"stdout:\n{done.stdout[:8000]}")
            if done.stderr:
                parts.append(f"stderr:\n{done.stderr[:4000]}")
            if done.changed_files:
                parts.append("변경된 파일: " + ", ".join(str(c.get("path")) for c in done.changed_files))
            return "\n".join(parts), command[:60]

        return f"알 수 없는 도구: {name}", name
    except ws.WorkspaceError as e:
        return f"거부됨 — {e.message}", str(tool_input.get("path", ""))[:60]


async def run_agent_turn(
    db: AsyncSession,
    res: provider.ResolvedAi,
    attempt_id: uuid.UUID,
    scenario_id: uuid.UUID,
    user_id: uuid.UUID,
    messages: list[dict],
):
    """에이전트 1턴 — 이벤트 dict를 순서대로 yield.

    이벤트: {"delta": str} | {"tool": {"name", "detail"}} | {"steps": [...] } (마지막, 내부용)
    """
    steps: list[dict] = []

    if not provider.supports_host_tools(res):
        reply = await provider.complete_text(res, messages, system=CHAT_ONLY_SYSTEM_PROMPT)
        yield {"delta": reply}
        yield {"steps": steps}
        return

    client = provider.build_client(res)
    for _ in range(settings.agent_max_tool_iterations):
        response = await client.create_message(
            model_config=provider._model_config(res),
            messages=messages,
            system=SYSTEM_PROMPT,
            tools=AGENT_TOOLS,
            purpose="odysseus.agent",
        )
        text = (response.text or "").strip()
        tool_calls = response.tool_calls

        if text:
            yield {"delta": text}

        if not tool_calls:
            messages.append({"role": "assistant", "content": text or "(응답 없음)"})
            yield {"steps": steps}
            return

        assistant_content: list[dict] = []
        if text:
            assistant_content.append({"type": "text", "text": text})
        for b in tool_calls:
            assistant_content.append(
                {"type": "tool_use", "id": b.tool_use_id, "name": b.tool_name, "input": b.tool_input or {}}
            )
        messages.append({"role": "assistant", "content": assistant_content})

        results = []
        for b in tool_calls:
            result, detail = await execute_agent_tool(
                db, attempt_id, scenario_id, user_id, b.tool_name, b.tool_input or {}
            )
            steps.append({"tool": b.tool_name, "detail": detail})
            yield {"tool": {"name": b.tool_name, "detail": detail}}
            results.append(
                {"type": "tool_result", "tool_use_id": b.tool_use_id, "content": str(result)[:TOOL_RESULT_CAP]}
            )
        messages.append({"role": "user", "content": results})

    yield {"delta": "\n\n(도구 호출 한도에 도달해 이번 턴을 마칩니다.)"}
    messages.append({"role": "assistant", "content": "(도구 호출 한도 도달)"})
    yield {"steps": steps}

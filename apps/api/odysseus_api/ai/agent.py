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

SYSTEM_PROMPT = """당신은 사용자의 개발 작업을 돕는 AI 어시스턴트입니다. 당신은 사용자와 **같은 워크스페이스 파일 시스템에 연결되어 있습니다** — 도구로 파일을 찾고, 읽고, 만들고, 옮기고, 삭제하고, 명령을 실행할 수 있습니다.

규칙:
- 당신에게는 과제나 배경에 대한 정보가 전혀 제공되지 않습니다. 사용자가 알려준 내용과 워크스페이스에서 직접 확인한 것만 근거로 삼고, 모르는 것을 아는 척 추측하지 마세요.
- 파일에 대해 묻거나 "찾아봐/확인해봐"라고 하면 **추측하지 말고 반드시 도구로 확인**하세요: 전체 구조는 list_files, 이름·내용 검색은 search_files, 내용 확인은 read_file.
- 파일을 수정하기 전에 먼저 읽어 현재 상태를 확인하세요. 새 파일은 write_file로 만들며, 경로에 폴더를 포함하면 폴더도 함께 생깁니다(예: src/utils/parse.py).
- 실행 결과(stdout/exit code)를 근거로 검증하고, 실패하면 원인을 확인한 뒤 고치세요.
- 하지 않은 일을 했다고 말하지 마세요. 작업을 마치면 무엇을 바꿨는지(경로 포함) 짧게 요약하세요.
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
        "description": "파일 또는 폴더를 삭제합니다. 폴더를 지정하면 하위 전체가 삭제됩니다.",
        "input_schema": {
            "type": "object",
            "properties": {"path": {"type": "string"}},
            "required": ["path"],
            "additionalProperties": False,
        },
    },
    {
        "name": "search_files",
        "description": "워크스페이스에서 파일을 찾습니다. query가 경로/파일명에 포함된 파일을 찾고, in_content=true면 파일 내용까지 검색해 일치한 줄(줄 번호 포함)을 함께 돌려줍니다. 파일 위치나 특정 코드·문자열이 어디 있는지 확인할 때 사용하세요.",
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "찾을 문자열 (파일명 일부 또는 내용)"},
                "in_content": {"type": "boolean", "description": "파일 내용까지 검색할지 (기본 false)"},
            },
            "required": ["query"],
            "additionalProperties": False,
        },
    },
    {
        "name": "copy_file",
        "description": "파일이나 폴더를 복사합니다. 폴더를 지정하면 하위 전체가 복사됩니다.",
        "input_schema": {
            "type": "object",
            "properties": {
                "from_path": {"type": "string"},
                "to_path": {"type": "string"},
            },
            "required": ["from_path", "to_path"],
            "additionalProperties": False,
        },
    },
    {
        "name": "move_file",
        "description": "파일이나 폴더의 이름을 바꾸거나 다른 경로로 옮깁니다. 폴더를 지정하면 하위 전체가 함께 이동합니다.",
        "input_schema": {
            "type": "object",
            "properties": {
                "from_path": {"type": "string"},
                "to_path": {"type": "string"},
            },
            "required": ["from_path", "to_path"],
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

#: 빈 폴더 유지용 플레이스홀더 — 에이전트 목록/검색에서는 감춘다 (UI와 동일)
KEEP_NAME = ".keep"


def _is_keep(path: str) -> bool:
    return path.rsplit("/", 1)[-1] == KEEP_NAME
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
            rows = [r for r in await ws.list_files(db, attempt_id, scenario_id) if not _is_keep(r.path)]
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

        if name == "search_files":
            query = str(tool_input.get("query", "")).strip()
            if not query:
                return "검색어가 비어 있습니다", "검색"
            in_content = bool(tool_input.get("in_content"))
            rows = [r for r in await ws.list_files(db, attempt_id, scenario_id) if not _is_keep(r.path)]
            lowered = query.lower()
            name_hits = [r.path for r in rows if lowered in r.path.lower()]
            out: list[str] = []
            if name_hits:
                out.append("[경로 일치]")
                out.extend(name_hits[:60])
            if in_content:
                content_hits: list[str] = []
                for r in rows:
                    for i, line in enumerate(r.content.split("\n"), start=1):
                        if lowered in line.lower():
                            content_hits.append(f"{r.path}:{i}: {line.strip()[:200]}")
                            if len(content_hits) >= 80:
                                break
                    if len(content_hits) >= 80:
                        break
                if content_hits:
                    out.append("")
                    out.append("[내용 일치]")
                    out.extend(content_hits)
            if not out:
                return f"'{query}'와 일치하는 파일이 없습니다 (검색 대상 {len(rows)}개)", query[:40]
            return "\n".join(out)[:TOOL_RESULT_CAP], query[:40]

        if name in ("copy_file", "move_file"):
            from_path = str(tool_input.get("from_path", ""))
            to_path = str(tool_input.get("to_path", ""))
            if name == "copy_file":
                n = await ws.copy_path(db, attempt_id, scenario_id, from_path, to_path, actor="agent")
                verb = "복사"
            else:
                n = await ws.move_path(db, attempt_id, scenario_id, from_path, to_path, actor="agent")
                verb = "이동"
            await db.commit()
            return f"{verb}됨: {from_path} → {to_path} (파일 {n}개)", f"{from_path} → {to_path}"[:60]

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
            removed = await ws.delete_path(db, attempt_id, scenario_id, path, actor="agent")
            await db.commit()
            return (f"삭제됨: {path} (파일 {removed}개)" if removed else f"경로가 없습니다: {path}"), path

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


def _tool_detail(name: str, tool_input: dict) -> str:
    """UI/기록용 짧은 라벨."""
    for key in ("path", "from_path", "query", "command"):
        if tool_input.get(key):
            return str(tool_input[key])[:60]
    return ""


async def _run_cli_agent_turn(
    res: provider.ResolvedAi,
    attempt_id: uuid.UUID,
    scenario_id: uuid.UUID,
    messages: list[dict],
    steps: list[dict],
):
    """Claude Code CLI 경로 — 도구는 MCP 브리지로 CLI 안에서 실행된다.

    CLI는 API 스타일 tools= 를 받지 못하므로 호스트 도구 루프를 돌리지 않는다.
    대신 우리 워크스페이스 도구만 MCP로 노출하고(내장 도구는 전부 차단 유지),
    CLI가 스스로 도구를 호출하며 낸 토큰/도구 이벤트를 그대로 중계한다.
    """
    client = provider.build_agent_client(
        res,
        attempt_id=str(attempt_id),
        scenario_id=str(scenario_id),
        tool_names=[t["name"] for t in AGENT_TOOLS],
    )
    got_text = False
    # CLI 스트림은 같은 도구를 블록 시작(인자 비어 있음)과 완료(인자 채워짐) 두 번 알린다.
    # 마지막 상태만 한 번 내보내기 위해 지연 방출한다.
    pending: list[dict] = []

    def _flush() -> list[dict]:
        if not pending:
            return []
        item = pending.pop()
        steps.append({"tool": item["name"], "detail": item["detail"]})
        return [{"tool": {"name": item["name"], "detail": item["detail"]}}]

    async for ev in client.create_message_stream(
        model_config=provider._model_config(res),
        messages=messages,
        system=SYSTEM_PROMPT,
        tools=None,
        purpose="odysseus.agent.cli",
    ):
        etype = ev.get("type")
        if etype == "text_delta" and ev.get("text"):
            for out in _flush():
                yield out
            got_text = True
            yield {"delta": ev["text"]}
        elif etype == "tool_use":
            raw = str(ev.get("name") or "")
            name = raw.split("__")[-1] if raw.startswith("mcp__") else raw
            detail = _tool_detail(name, ev.get("input") or {})
            key = str(ev.get("id") or name)
            if pending and pending[-1]["key"] == key:
                # 같은 도구의 갱신 — 더 구체적인 detail로 덮어쓴다
                if detail:
                    pending[-1]["detail"] = detail
            else:
                for out in _flush():
                    yield out
                pending.append({"key": key, "name": name, "detail": detail})
        elif etype == "message_complete":
            for out in _flush():
                yield out
            response = ev.get("response")
            text = (getattr(response, "text", "") or "") if response else ""
            if text and not got_text:
                yield {"delta": text}
    for out in _flush():
        yield out


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
    delta는 **그대로 이어붙이면 되는 텍스트**다 (문단 구분은 서버가 넣는다).
    """
    steps: list[dict] = []

    # Claude Code CLI — MCP 브리지로 같은 도구 집합을 사용
    if res.provider == provider.CLAUDE_CODE_PROVIDER:
        async for ev in _run_cli_agent_turn(res, attempt_id, scenario_id, messages, steps):
            yield ev
        yield {"steps": steps}
        return

    if not provider.supports_host_tools(res):
        reply = await provider.complete_text(res, messages, system=CHAT_ONLY_SYSTEM_PROMPT)
        yield {"delta": reply}
        yield {"steps": steps}
        return

    client = provider.build_client(res)
    emitted_text = False
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
            yield {"delta": (f"\n\n{text}" if emitted_text else text)}
            emitted_text = True

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
            detail = detail or _tool_detail(b.tool_name, b.tool_input or {})
            steps.append({"tool": b.tool_name, "detail": detail})
            yield {"tool": {"name": b.tool_name, "detail": detail}}
            results.append(
                {"type": "tool_result", "tool_use_id": b.tool_use_id, "content": str(result)[:TOOL_RESULT_CAP]}
            )
        messages.append({"role": "user", "content": results})

    yield {"delta": "\n\n(도구 호출 한도에 도달해 이번 턴을 마칩니다.)"}
    messages.append({"role": "assistant", "content": "(도구 호출 한도 도달)"})
    yield {"steps": steps}

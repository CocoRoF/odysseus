#!/usr/bin/env python3
"""Odysseus 워크스페이스 MCP 서버 (stdio) — Claude Code CLI 전용 도구 브리지.

Claude Code CLI는 API 스타일 ``tools=`` 를 받지 못한다. 그래서 CLI **내장** 도구
(Bash/Read/Write/WebSearch/스킬…)는 전부 차단한 채, 우리가 만든 워크스페이스
도구만 이 MCP 서버로 노출한다 — 다른 공급자가 ``tools=`` 로 받는 것과 **완전히
동일한 도구 집합**이며, 실행도 결국 같은 서버 구현(execute_agent_tool)을 지난다.

동작:
  · CLI가 이 스크립트를 stdio MCP 서버로 spawn (JSON-RPC, 줄 단위 JSON)
  · 도구 목록/실행은 API 내부 엔드포인트로 프록시 (X-Internal-Token)
  · 응시/시나리오 범위는 환경변수로 고정 — 프롬프트로 바꿀 수 없다

이 파일은 무거운 앱 모듈을 import 하지 않는다 (표준 라이브러리만) — CLI가
띄우는 짧은 수명의 프록시이므로 기동이 가벼워야 하고, 도구 정의는 서버가
단일 소스로 들고 있어야 하기 때문이다.
"""

import json
import os
import sys
import urllib.error
import urllib.request

API_BASE = os.environ.get("ODYSSEUS_API_BASE", "http://127.0.0.1:8000").rstrip("/")
INTERNAL_TOKEN = os.environ.get("ODYSSEUS_INTERNAL_TOKEN", "")
ATTEMPT_ID = os.environ.get("ODYSSEUS_ATTEMPT_ID", "")
SCENARIO_ID = os.environ.get("ODYSSEUS_SCENARIO_ID", "")

SERVER_NAME = "odysseus"
DEFAULT_PROTOCOL = "2024-11-05"
HTTP_TIMEOUT_S = 180


def _post(path: str, payload: dict) -> dict:
    req = urllib.request.Request(
        f"{API_BASE}{path}",
        data=json.dumps(payload).encode("utf-8"),
        method="POST",
        headers={"Content-Type": "application/json", "X-Internal-Token": INTERNAL_TOKEN},
    )
    with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_S) as resp:
        return json.loads(resp.read().decode("utf-8") or "{}")


def _get(path: str) -> dict:
    req = urllib.request.Request(
        f"{API_BASE}{path}",
        method="GET",
        headers={"X-Internal-Token": INTERNAL_TOKEN},
    )
    with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_S) as resp:
        return json.loads(resp.read().decode("utf-8") or "{}")


def list_tools() -> list:
    """도구 정의는 API가 단일 소스로 제공한다 (다른 공급자와 동일한 목록)."""
    try:
        data = _get("/internal/agent-tools")
        return [
            {
                "name": t["name"],
                "description": t.get("description", ""),
                "inputSchema": t.get("input_schema") or {"type": "object", "properties": {}},
            }
            for t in data.get("tools", [])
        ]
    except Exception as exc:  # noqa: BLE001 — 목록 실패는 빈 목록으로 (CLI가 죽지 않게)
        print(f"[mcp_workspace] tools/list failed: {exc}", file=sys.stderr, flush=True)
        return []


def call_tool(name: str, arguments: dict) -> tuple[str, bool]:
    """도구 실행 → (텍스트 결과, is_error)."""
    try:
        data = _post(
            "/internal/agent-tool",
            {
                "attempt_id": ATTEMPT_ID,
                "scenario_id": SCENARIO_ID,
                "name": name,
                "input": arguments or {},
            },
        )
        return str(data.get("result", "")), bool(data.get("is_error"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")[:400]
        return f"도구 실행 실패 (HTTP {exc.code}): {body}", True
    except Exception as exc:  # noqa: BLE001
        return f"도구 실행 실패: {exc}", True


def respond(msg_id, result=None, error=None) -> None:
    payload = {"jsonrpc": "2.0", "id": msg_id}
    if error is not None:
        payload["error"] = error
    else:
        payload["result"] = result
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main() -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue

        method = msg.get("method")
        msg_id = msg.get("id")

        # 알림(notification)은 응답하지 않는다
        if msg_id is None:
            continue

        if method == "initialize":
            requested = (msg.get("params") or {}).get("protocolVersion") or DEFAULT_PROTOCOL
            respond(
                msg_id,
                {
                    "protocolVersion": requested,
                    "capabilities": {"tools": {"listChanged": False}},
                    "serverInfo": {"name": SERVER_NAME, "version": "1.0.0"},
                },
            )
        elif method == "tools/list":
            respond(msg_id, {"tools": list_tools()})
        elif method == "tools/call":
            params = msg.get("params") or {}
            text, is_error = call_tool(str(params.get("name", "")), params.get("arguments") or {})
            respond(msg_id, {"content": [{"type": "text", "text": text}], "isError": is_error})
        elif method == "ping":
            respond(msg_id, {})
        elif method in ("resources/list", "prompts/list"):
            respond(msg_id, {"resources": [], "prompts": []})
        else:
            respond(msg_id, error={"code": -32601, "message": f"method not found: {method}"})


if __name__ == "__main__":
    main()

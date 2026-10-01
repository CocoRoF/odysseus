"""Claude Code CLI 잠금 + MCP 브리지 argv 검증 (api 컨테이너에서 실행).

정책: CLI **내장** 도구/스킬/세션은 항상 전부 차단하고, 우리 워크스페이스 도구만
MCP 서버 하나로 노출한다. 이 파일은 그 정책이 실제 argv/설정에 반영되는지 본다.

  docker cp tests/smoke/test_cli_lockdown.py odysseus-api-1:/tmp/
  docker exec -e PYTHONPATH=/app odysseus-api-1 python3 /tmp/test_cli_lockdown.py
"""

import json
import sys

from geny_executor.core.config import ModelConfig

from odysseus_api.ai import provider
from odysseus_api.ai.agent import AGENT_TOOLS

ok = fail = 0


def check(name, cond, detail=""):
    global ok, fail
    if cond:
        ok += 1
        print(f"  PASS {name}")
    else:
        fail += 1
        print(f"  FAIL {name} {detail}")


def argv_of(client, *, stream=True):
    req = client._build_request(
        model_config=ModelConfig(model="sonnet", max_tokens=2048, temperature=0.2),
        messages=[{"role": "user", "content": "hi"}],
        system="SYS",
        tools=None,
        tool_choice=None,
        stream=stream,
    )
    return client._build_argv(req)


res = provider.ResolvedAi(
    provider="claude_code_cli", model="sonnet", api_key="sk-ant-oat01-" + "x" * 60, name="t"
)

# ── 1. 순수 채팅 경로 (NPC/자동평가) — MCP 서버 0개 ──────────────
chat_argv = argv_of(provider.build_client(res))
ti = chat_argv.index("--tools")
check("chat: --tools '' (내장 도구 0개)", chat_argv[ti + 1] == "", str(chat_argv[ti : ti + 2]))
check("chat: --disable-slash-commands", "--disable-slash-commands" in chat_argv, "")
check("chat: --strict-mcp-config", chat_argv.count("--strict-mcp-config") == 1, str(chat_argv.count("--strict-mcp-config")))
check("chat: MCP 설정 없음", "--mcp-config" not in chat_argv, "")
check("chat: 도구 허용 목록 없음", "--allowedTools" not in chat_argv, "")

# ── 2. 에이전트 경로 — 내장은 그대로 차단, MCP 로만 도구 제공 ────
tool_names = [t["name"] for t in AGENT_TOOLS]
agent_client = provider.build_agent_client(
    res, attempt_id="11111111-1111-1111-1111-111111111111",
    scenario_id="22222222-2222-2222-2222-222222222222", tool_names=tool_names,
)
argv = argv_of(agent_client)

ti = argv.index("--tools")
check("agent: --tools '' (내장 도구 여전히 0개)", argv[ti + 1] == "", str(argv[ti : ti + 2]))
check("agent: --disable-slash-commands (스킬 차단 유지)", "--disable-slash-commands" in argv, "")
check("agent: --no-session-persistence", "--no-session-persistence" in argv, "")

blocked = argv[argv.index("--disallowedTools") + 1]
must_block = ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebSearch", "WebFetch", "Task", "Agent", "TodoWrite"]
check("agent: 내장 도구 disallow 목록", all(b in blocked for b in must_block), blocked[:120])

check("agent: --strict-mcp-config 정확히 1회", argv.count("--strict-mcp-config") == 1, str(argv.count("--strict-mcp-config")))

mcp_raw = argv[argv.index("--mcp-config") + 1]
mcp = json.loads(mcp_raw)
servers = mcp.get("mcpServers", {})
check("agent: MCP 서버는 우리 것 하나뿐", list(servers) == ["odysseus"], str(list(servers)))
srv = servers.get("odysseus", {})
check("agent: MCP 서버가 브리지 스크립트를 실행", srv.get("args", [""])[0].endswith("mcp_workspace.py"), str(srv.get("args")))
env = srv.get("env", {})
check(
    "agent: 응시/시나리오 범위가 환경변수로 고정",
    env.get("ODYSSEUS_ATTEMPT_ID") == "11111111-1111-1111-1111-111111111111"
    and env.get("ODYSSEUS_SCENARIO_ID") == "22222222-2222-2222-2222-222222222222"
    and bool(env.get("ODYSSEUS_INTERNAL_TOKEN")),
    str({k: v for k, v in env.items() if k != "ODYSSEUS_INTERNAL_TOKEN"}),
)

allowed = argv[argv.index("--allowedTools") + 1]
check(
    "agent: 허용 목록은 MCP 도구 전부",
    all(f"mcp__odysseus__{n}" in allowed for n in tool_names),
    allowed[:160],
)
check(
    "agent: 허용 목록에 CLI 내장 도구 없음",
    not any(f" {b}" in f" {allowed}" for b in must_block),
    allowed[:160],
)

# ── 3. 구독 토큰 채널 — --bare 금지 (OAuth 자격증명을 읽어야 함) ──
check("subscription: --bare 미사용", "--bare" not in argv, "")
api_key_res = provider.ResolvedAi(provider="claude_code_cli", model="sonnet", api_key="sk-ant-api03-xxx", name="t")
check("api key: --bare 사용", "--bare" in argv_of(provider.build_client(api_key_res)), "")

# ── 4. 도구 가용성 플래그 ────────────────────────────────────────
check("agent_tools_available(CLI) == True", provider.agent_tools_available(res), "")
check("supports_host_tools(CLI) == False (API tools= 는 여전히 불가)", not provider.supports_host_tools(res), "")

print(f"\n=== {ok} passed, {fail} failed ===")
sys.exit(1 if fail else 0)

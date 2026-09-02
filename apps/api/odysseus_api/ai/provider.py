"""LLM 공급자 계층 — geny-executor의 통합 llm_client 위에 구축.

지원 백엔드: openai / anthropic / google / vllm / ollama / lmstudio / custom
/ claude_code_cli(순수 LLM 잠금 모드).

geny-executor의 llm_client 서브패키지만 사용한다 — 에이전트 파이프라인과
내장 툴은 로드하지 않으며, 모든 호출은 tools=None(순수 채팅) 또는
odysseus 자체 호스트 도구(에이전트 워크스페이스 조작·NPC)뿐이다.

claude_code_cli는 서버에 설치된 ``claude`` CLI를 서브프로세스로 구동하되,
다른 공급자와 완벽히 동일한 "단순 LLM"이 되도록 CLI의 에이전트 표면을
전부 잠근다 — 내장 도구(--tools "" + --disallowedTools 전체 카탈로그),
스킬(--disable-slash-commands), MCP(--strict-mcp-config, 설정 없음),
세션 영속(--no-session-persistence)까지. 검증: --tools "" 상태에서 입력
프롬프트에 도구 스키마가 전혀 주입되지 않음을 실측(2.1.236) 확인.
단, CLI는 API 스타일 함수 도구(tools=)를 받을 수 없으므로 odysseus
호스트 도구가 필요한 경로는 supports_host_tools()로 갈라 폴백한다.

해석 우선순위:
  채팅: 시험별 지정 공급자 → 기본 채팅 공급자 → 활성 공급자 중 첫 번째 → env 폴백
  평가: 기본 평가 공급자 → 채팅 해석 결과
"""

import os
import tempfile
import uuid
from dataclasses import dataclass, field
from typing import Any, AsyncIterator

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from geny_executor.core.config import ModelConfig
from geny_executor.llm_client import ClientRegistry, discover_models

from ..config import settings
from ..models import AiProvider

# ── 공급자 카탈로그 (설정 패널 메타) ─────────────────────────────
#
# supports_host_tools: odysseus가 API 스타일 함수 도구(참고 자료 열람,
# 문제 작성 도구)를 붙일 수 있는 공급자인지. False면 해당 경로는 폴백
# (자료 인라인 주입 / 대화 전용 작성 도우미)으로 동작한다.

CLAUDE_CODE_PROVIDER = "claude_code_cli"

PROVIDER_CATALOG: list[dict] = [
    {
        "provider": "openai",
        "label": "OpenAI",
        "kind": "cloud",
        "needs_key": True,
        "needs_base_url": False,
        "default_base_url": None,
        "placeholder_model": "gpt-4o-mini",
        "description": "OpenAI API (gpt-4o, o3 등). base URL을 바꾸면 Azure/프록시도 사용 가능.",
    },
    {
        "provider": "anthropic",
        "label": "Anthropic Claude",
        "kind": "cloud",
        "needs_key": True,
        "needs_base_url": False,
        "default_base_url": None,
        "placeholder_model": "claude-sonnet-4-6",
        "description": "Anthropic Messages API (Claude 계열).",
    },
    {
        "provider": "google",
        "label": "Google Gemini",
        "kind": "cloud",
        "needs_key": True,
        "needs_base_url": False,
        "default_base_url": None,
        "placeholder_model": "gemini-2.0-flash",
        "description": "Google Gemini API.",
    },
    {
        "provider": "vllm",
        "label": "vLLM",
        "kind": "local",
        "needs_key": False,
        "needs_base_url": True,
        "default_base_url": "http://localhost:8000/v1",
        "placeholder_model": "(서빙 중인 모델 ID)",
        "description": "vLLM OpenAI 호환 서버. base URL 필수.",
    },
    {
        "provider": "ollama",
        "label": "Ollama",
        "kind": "local",
        "needs_key": False,
        "needs_base_url": False,
        "default_base_url": "http://localhost:11434/v1",
        "placeholder_model": "qwen2.5-coder:14b",
        "description": "Ollama 로컬 서버 (/v1 OpenAI 호환 엔드포인트).",
    },
    {
        "provider": "lmstudio",
        "label": "LM Studio",
        "kind": "local",
        "needs_key": False,
        "needs_base_url": False,
        "default_base_url": "http://127.0.0.1:1234/v1",
        "placeholder_model": "(로드된 모델 ID)",
        "description": "LM Studio 로컬 서버.",
    },
    {
        "provider": "custom",
        "label": "OpenAI 호환 (커스텀)",
        "kind": "local",
        "needs_key": False,
        "needs_base_url": True,
        "default_base_url": None,
        "placeholder_model": "(엔드포인트의 모델 ID)",
        "description": "llama.cpp server, LiteLLM, 사내 게이트웨이 등 모든 OpenAI 호환 엔드포인트.",
    },
    {
        "provider": CLAUDE_CODE_PROVIDER,
        "label": "Claude Code (CLI)",
        "kind": "cli",
        "needs_key": True,
        "needs_base_url": False,
        "default_base_url": None,
        "placeholder_model": "sonnet",
        "description": (
            "서버에 설치된 claude CLI를 순수 LLM으로 구동합니다. 내장 도구·스킬·MCP가 "
            "전부 차단되어 다른 공급자와 동일하게 채팅만 수행합니다. 키는 Anthropic API 키"
            "(sk-ant-…) 또는 `claude setup-token` 토큰(sk-ant-oat…)을 지원합니다. "
            "temperature·최대 토큰 설정은 CLI가 지원하지 않아 무시됩니다."
        ),
    },
]

# claude_code_cli만 False — CLI는 API 스타일 tools= 파라미터를 받을 수 없다.
for _c in PROVIDER_CATALOG:
    _c.setdefault("supports_host_tools", _c["provider"] != CLAUDE_CODE_PROVIDER)

VALID_PROVIDERS = {c["provider"] for c in PROVIDER_CATALOG}


def catalog_entry(provider: str) -> dict | None:
    return next((c for c in PROVIDER_CATALOG if c["provider"] == provider), None)


def provider_supports_host_tools(provider: str) -> bool:
    """이 공급자에 odysseus 호스트 도구(tools=)를 붙일 수 있는가."""
    entry = catalog_entry(provider)
    return bool(entry.get("supports_host_tools", True)) if entry else True


def supports_host_tools(res: "ResolvedAi") -> bool:
    return provider_supports_host_tools(res.provider)


# ── 해석된 실행 설정 ─────────────────────────────────────────────


@dataclass
class ResolvedAi:
    provider: str
    model: str
    api_key: str = ""
    base_url: str | None = None
    temperature: float = 0.2
    max_tokens: int = 4096
    default_headers: dict = field(default_factory=dict)
    name: str = ""  # 공급자 표시 이름
    source: str = "db"  # db | env
    provider_row_id: str | None = None

    @property
    def configured(self) -> bool:
        entry = catalog_entry(self.provider)
        if entry and entry["needs_key"] and not self.api_key:
            return False
        if entry and entry["needs_base_url"] and not self.base_url:
            return False
        return bool(self.model)


def resolved_from_row(row: AiProvider) -> ResolvedAi:
    return ResolvedAi(
        provider=row.provider,
        model=row.model,
        api_key=row.api_key or "",
        base_url=row.base_url or None,
        temperature=row.temperature,
        max_tokens=row.max_tokens,
        default_headers=dict(row.default_headers or {}),
        name=row.name,
        source="db",
        provider_row_id=str(row.id),
    )


def _env_fallback() -> ResolvedAi | None:
    """DB에 공급자가 없을 때 .env(AI_*)로 동작하는 폴백."""
    if not settings.ai_api_key:
        return None
    base = (settings.ai_base_url or "").rstrip("/")
    provider = "openai" if "api.openai.com" in base else "custom"
    return ResolvedAi(
        provider=provider,
        model=settings.ai_chat_model,
        api_key=settings.ai_api_key,
        base_url=base or None,
        name="환경변수(.env)",
        source="env",
    )


async def resolve_ai(
    db: AsyncSession,
    purpose: str = "chat",
    override_provider_id: uuid.UUID | None = None,
) -> ResolvedAi | None:
    """실행할 공급자를 해석. 없으면 None (=미설정)."""
    if override_provider_id:
        row = await db.get(AiProvider, override_provider_id)
        if row and row.enabled:
            return resolved_from_row(row)

    rows = (
        await db.execute(
            select(AiProvider).where(AiProvider.enabled.is_(True)).order_by(AiProvider.created_at)
        )
    ).scalars().all()
    if rows:
        if purpose == "eval":
            for r in rows:
                if r.is_eval_default:
                    return resolved_from_row(r)
        for r in rows:
            if r.is_chat_default:
                return resolved_from_row(r)
        return resolved_from_row(rows[0])
    return _env_fallback()


# ── geny-executor 클라이언트 구성/호출 ───────────────────────────

# Claude Code CLI 순수 LLM 잠금 (xgen-agent-runtime의 네이티브 전면차단 규약 이식).
#
# --tools "" 가 내장 도구를 전부 비활성화하는 1차 차단이고,
# --disallowedTools 전체 카탈로그는 CLI 버전 차이에 대비한 2차 방어선이다
# (xgeny 프로드에서 검증된 이름 집합 + 서브에이전트/세션 스케줄 도구).
_CLI_NATIVE_TOOL_BLOCKLIST = (
    "Bash",
    "Read",
    "Write",
    "Edit",
    "MultiEdit",
    "NotebookEdit",
    "Glob",
    "Grep",
    "LS",
    "WebSearch",
    "WebFetch",
    "TodoWrite",
    "Task",
    "Agent",
    "CronCreate",
    "CronDelete",
    "CronList",
    "ScheduleWakeup",
)

_CLI_LOCKDOWN_ARGS = (
    "--tools", "",              # 내장 도구 전체 비활성 (순수 LLM)
    "--disable-slash-commands",  # 스킬/커맨드 전부 차단
    "--strict-mcp-config",       # --mcp-config 미지정 → MCP 서버 0개
    "--no-session-persistence",  # 서버에 세션 파일을 남기지 않는다
)

#: CLI는 모델 목록 명령이 없다 — 버전에 안전한 별칭을 정적 카탈로그로 제공.
CLAUDE_CODE_STATIC_MODELS = [
    {"id": "sonnet", "display_name": "Claude Sonnet (최신 별칭, 권장)"},
    {"id": "opus", "display_name": "Claude Opus (최신 별칭)"},
    {"id": "haiku", "display_name": "Claude Haiku (최신 별칭)"},
]

# 설정 키(자격증명·base_url) → 클라이언트 인스턴스 캐시.
# CLI 클라이언트는 인스턴스마다 `claude --version` 핸드셰이크(Node 부팅 1회)를
# 수행하므로, 매 턴 새로 만들면 그 비용을 매번 다시 낸다. 키가 바뀌면 새
# 인스턴스가 만들어지고 옛것은 밀려난다(프로세스 상주 없음 — prewarm 꺼짐).
_cli_client_cache: dict[tuple, Any] = {}
_CLI_CACHE_MAX = 8


def _build_claude_code_client(res: ResolvedAi):
    cache_key = (res.api_key, res.base_url or "")
    cached = _cli_client_cache.get(cache_key)
    if cached is not None:
        return cached

    from geny_executor.llm_client.claude_code import ClaudeCodeCLIClient

    # 빈 전용 작업 디렉터리 — CLI가 API 프로세스의 cwd(코드 트리)를 보지 않게 한다.
    workspace = os.path.join(tempfile.gettempdir(), "odysseus-ai-cli")
    os.makedirs(workspace, exist_ok=True)

    env_extras: dict[str, str] = {
        "DISABLE_AUTOUPDATER": "1",
        "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
    }
    if res.base_url:
        # 다른 공급자의 base_url과 동일한 의미 — 게이트웨이/프록시 경유.
        env_extras["ANTHROPIC_BASE_URL"] = res.base_url

    kwargs: dict[str, Any] = {
        "workspace_dir": workspace,
        "default_permission_mode": "default",
        "disallow_tools": _CLI_NATIVE_TOOL_BLOCKLIST,
        "extra_args": _CLI_LOCKDOWN_ARGS,
        "env_extras": env_extras,
        "timeout_s": 300.0,
        # odysseus는 클라이언트를 세션 단위로 소유하지 않으므로(호출 단위 사용,
        # aclose 미호출) hot-spare 프리웜을 끈다 — 켜면 고아 프로세스가 남는다.
        "prewarm_spawn": False,
    }
    if res.api_key.startswith("sk-ant-oat"):
        # `claude setup-token` 장수 토큰 — 구독(OAuth) 채널. --bare 금지.
        env_extras["CLAUDE_CODE_OAUTH_TOKEN"] = res.api_key
        kwargs.update(api_key="", auth_mode="setup_token", bare_mode=False)
    else:
        # API 키 채널 — --bare로 keychain/OAuth/CLAUDE.md 자동 탐색까지 차단.
        kwargs.update(api_key=res.api_key, auth_mode="api_key", bare_mode=True)

    client = ClaudeCodeCLIClient(**kwargs)
    if len(_cli_client_cache) >= _CLI_CACHE_MAX:
        _cli_client_cache.pop(next(iter(_cli_client_cache)))
    _cli_client_cache[cache_key] = client
    return client


def build_client(res: ResolvedAi):
    """ResolvedAi → geny-executor BaseClient. 툴/에이전트 기능은 사용하지 않는다."""
    if res.provider == CLAUDE_CODE_PROVIDER:
        return _build_claude_code_client(res)
    cls = ClientRegistry.get(res.provider)
    kwargs: dict[str, Any] = {"api_key": res.api_key or "EMPTY"}
    if res.base_url:
        kwargs["base_url"] = res.base_url
    if res.default_headers:
        kwargs["default_headers"] = res.default_headers
    return cls(**kwargs)


def _model_config(res: ResolvedAi, max_tokens: int | None = None) -> ModelConfig:
    return ModelConfig(
        model=res.model,
        max_tokens=max_tokens or res.max_tokens,
        temperature=res.temperature,
    )


def _clean_messages(messages: list[dict]) -> list[dict]:
    """빈 내용 메시지 제거(일부 벤더는 빈 content를 거부) + 역할 정규화."""
    out = []
    for m in messages:
        content = str(m.get("content", "") or "").strip()
        role = m.get("role", "user")
        if not content or role not in ("user", "assistant"):
            continue
        out.append({"role": role, "content": content})
    # 대화는 user로 시작해야 하는 벤더(anthropic) 대응
    while out and out[0]["role"] != "user":
        out.pop(0)
    return out


async def stream_text(
    res: ResolvedAi, messages: list[dict], system: str = ""
) -> AsyncIterator[str]:
    """텍스트 델타 스트림. 스트리밍 미지원 백엔드는 완성문을 한 번에 낸다."""
    client = build_client(res)
    got_delta = False
    async for event in client.create_message_stream(
        model_config=_model_config(res),
        messages=_clean_messages(messages),
        system=system,
        tools=None,
        purpose="odysseus.chat",
    ):
        etype = event.get("type")
        if etype == "text_delta" and event.get("text"):
            got_delta = True
            yield event["text"]
        elif etype == "message_complete" and not got_delta:
            response = event.get("response")
            text = getattr(response, "text", "") if response else ""
            if text:
                yield text


async def complete_text(
    res: ResolvedAi, messages: list[dict], system: str = "", max_tokens: int | None = None
) -> str:
    """비스트리밍 완성 (자동평가/연결 테스트용)."""
    if res.provider == CLAUDE_CODE_PROVIDER:
        # CLI 비스트리밍은 프롬프트를 argv 위치 인자로 넘겨 커널의 단일 인자
        # 한계(~128KB)에 걸릴 수 있다 — 자동평가처럼 긴 프롬프트도 안전하도록
        # stdin(stream-json) 경로인 스트리밍으로 우회해 완성문을 모아 반환한다.
        parts = [d async for d in stream_text(res, messages, system=system)]
        return "".join(parts)
    client = build_client(res)
    response = await client.create_message(
        model_config=_model_config(res, max_tokens=max_tokens),
        messages=_clean_messages(messages),
        system=system,
        tools=None,
        purpose="odysseus.complete",
    )
    return response.text


async def list_models(res: ResolvedAi) -> dict:
    """라이브 모델 디스커버리 (설정 패널의 모델 선택기)."""
    if res.provider == CLAUDE_CODE_PROVIDER:
        # CLI에는 모델 목록 명령이 없다 — 버전 안전 별칭의 정적 카탈로그를 준다.
        return {"source": "static", "error": None, "models": list(CLAUDE_CODE_STATIC_MODELS)}
    result = await discover_models(res.provider, api_key=res.api_key or None, base_url=res.base_url)
    return {
        "source": result.source,
        "error": result.error,
        "models": [
            {"id": m.id, "display_name": m.display_name}
            for m in result.models
        ],
    }

"""OpenAI 호환으로 직접 띄운 서버(vLLM·Ollama·LM Studio·사용자 지정)에 system 을 system 역할로 보낸다.

geny-executor 의 OpenAI 번역기는 system 을 `developer` 역할 메시지로 만든다. OpenAI 본가는 받지만 DashScope 호환
엔드포인트·예전 vLLM 은 그 역할을 모른다("developer is not one of ['system', 'assistant', 'user', ...]").

system 을 첫 user 메시지에 접어 넣으면 이 오류는 사라지지만, 출제자·채점 지시와 응시자가 쓴 글이 한 메시지로 합쳐져
역할 경계가 무너진다(NPC-SYSTEM-DESIGN §8.1, security/09). 그래서 역할 이름만 바꾼다 — 내용과 순서는 그대로다.
"""
from __future__ import annotations

from functools import cache

#: 이 공급자들은 `developer` 대신 `system` 역할을 받는다. openai 본가는 번역기 그대로 둔다.
SYSTEM_ROLE_PROVIDERS = frozenset({"vllm", "ollama", "lmstudio", "custom"})


def system_role_messages(messages: list[dict]) -> list[dict]:
    return [{**m, "role": "system"} if m.get("role") == "developer" else m for m in messages]


@cache
def with_system_role(cls: type) -> type:
    """geny 클라이언트 클래스를 받아, 요청을 만든 뒤 developer → system 으로 바꾸는 하위 클래스를 돌려준다.
    스트리밍·비스트리밍 모두 `_build_kwargs` 를 지나므로 한 곳이면 된다."""

    class SystemRoleClient(cls):
        def _build_kwargs(self, request):
            kwargs = super()._build_kwargs(request)
            kwargs["messages"] = system_role_messages(kwargs.get("messages") or [])
            return kwargs

    SystemRoleClient.__name__ = f"SystemRole{cls.__name__}"
    return SystemRoleClient

"""Bridge geny-executor's sampling defaults to the Anthropic Messages contract."""

from geny_executor.llm_client.anthropic import AnthropicClient


class OdysseusAnthropicClient(AnthropicClient):
    def _build_kwargs(self, request):
        kwargs = super()._build_kwargs(request)
        # The locked Anthropic SDK (1.4) removed these keyword arguments from
        # both messages.create and messages.stream. Fix the common boundary so
        # completions, streaming and tool calls all use the same valid payload.
        for key in ("temperature", "top_p", "top_k"):
            kwargs.pop(key, None)
        # ModelConfig defaults to thinking_enabled=False. New models enable
        # adaptive thinking when omitted; honor our config explicitly so short
        # replies do not spend their entire output budget on hidden reasoning.
        # Preserve any thinking configuration explicitly requested by a caller.
        kwargs.setdefault("thinking", {"type": "disabled"})
        return kwargs

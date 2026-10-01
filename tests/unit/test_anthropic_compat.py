"""The actual locked SDK must accept every Anthropic request path; no API calls."""
import inspect
import unittest
from unittest.mock import AsyncMock, patch

from anthropic.resources.messages import AsyncMessages
from geny_executor.core.config import ModelConfig

from odysseus_api.ai import provider
from odysseus_api.routers.settings import AiTestIn, test_provider


class AnthropicCompatibilityTests(unittest.TestCase):
    def test_completion_stream_and_tools_bind_to_installed_sdk(self):
        res = provider.ResolvedAi(provider="anthropic", model="claude-sonnet-5", api_key="fixture")
        client = provider.build_client(res)
        tools = [{"name": "lookup", "description": "Look up a document",
                  "input_schema": {"type": "object", "properties": {}}}]
        for stream, method in ((False, AsyncMessages.create), (True, AsyncMessages.stream)):
            with self.subTest(stream=stream):
                request = client._build_request(
                    model_config=ModelConfig(model=res.model, temperature=0.2, top_p=0.9, top_k=10, max_tokens=512),
                    messages=[{"role": "user", "content": "안녕하세요"}],
                    system="Reply briefly.", tools=tools, tool_choice={"type": "auto"}, stream=stream,
                )
                kwargs = client._build_kwargs(request)
                inspect.signature(method).bind(None, **kwargs)
                self.assertTrue({"temperature", "top_p", "top_k"}.isdisjoint(kwargs))
                self.assertEqual(kwargs["thinking"], {"type": "disabled"})
                self.assertEqual(kwargs["tools"], tools)
                self.assertEqual(kwargs["model"], res.model)
                self.assertEqual(kwargs["max_tokens"], 512)

    def test_explicit_thinking_is_preserved_and_other_providers_keep_temperature(self):
        res = provider.ResolvedAi(provider="anthropic", model="claude-sonnet-5", api_key="fixture")
        client = provider.build_client(res)
        request = client._build_request(
            model_config=ModelConfig(model=res.model, thinking_enabled=True, thinking_type="adaptive"),
            messages=[{"role": "user", "content": "hello"}], system="", tools=None, tool_choice=None, stream=False,
        )
        self.assertEqual(client._build_kwargs(request)["thinking"], {"type": "adaptive"})
        other = provider.ResolvedAi(provider="openai", model="fixture", temperature=0.7)
        self.assertEqual(provider._model_config(other).temperature, 0.7)
        self.assertNotIsInstance(provider.build_client(other), type(client))


class ConnectionTestTests(unittest.IsolatedAsyncioTestCase):
    async def test_empty_text_cannot_report_success(self):
        res = provider.ResolvedAi(provider="anthropic", model="claude-sonnet-5", api_key="fixture")
        with patch("odysseus_api.routers.settings._resolved_for_test", AsyncMock(return_value=res)), \
                patch.object(provider, "complete_text", AsyncMock(return_value="  ")):
            result = await test_provider(AiTestIn(), db=None)
        self.assertFalse(result["ok"])

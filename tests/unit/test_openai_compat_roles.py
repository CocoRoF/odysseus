"""OpenAI 호환 자체 서버에는 system 이 system 역할로 가고, 대화 메시지와 합쳐지지 않는다."""
import pathlib
import sys
import unittest

REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "apps" / "api"))

from geny_executor.llm_client.types import APIRequest  # noqa: E402

from odysseus_api.ai.provider import ResolvedAi, build_client  # noqa: E402


def payload(provider: str) -> list[dict]:
    client = build_client(ResolvedAi(provider=provider, model="m", api_key="k", base_url="http://127.0.0.1:9/v1"))
    request = APIRequest(model="m", messages=[{"role": "user", "content": "응시자의 글"}], system="출제자 지시")
    return client._build_kwargs(request)["messages"]


class SystemRoleTests(unittest.TestCase):
    def test_self_hosted_servers_receive_system_role_separately(self):
        for provider in ("vllm", "ollama", "lmstudio", "custom"):
            with self.subTest(provider=provider):
                messages = payload(provider)
                self.assertEqual(messages[0], {"role": "system", "content": "출제자 지시"})
                self.assertEqual(messages[1]["role"], "user")
                self.assertNotIn("출제자 지시", str(messages[1]["content"]))

    def test_openai_keeps_its_developer_role(self):
        self.assertEqual(payload("openai")[0]["role"], "developer")


if __name__ == "__main__":
    unittest.main()

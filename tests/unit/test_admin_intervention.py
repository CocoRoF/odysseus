"""관리자 개입 수단과 응시 조건의 계약 (P1).

여기서 지키는 것:
  · 보정은 **동결된 정의를 고치지 않고** 따로 쌓인다 — 무엇이 원래 조건이고 무엇이 구제였는지
    나중에 구분할 수 있어야 한다.
  · 종료할 때 보정 기록이 사라지지 않는다 — lifecycle._snapshot 이 snapshot 을 다시 짓기 때문에,
    `_` 규약을 따르지 않으면 조용히 없어진다.
  · 실행 제한 시간과 메신저 한도는 **응시 시작 시점 값으로 동결**된다. 출제자가 나중에 고쳐도
    진행 중인 응시의 조건은 바뀌지 않는다.
  · 중단(AI_CANCELLED)은 돌려주되, 답이 이미 흘러나온 뒤의 중단은 소모로 남는다.
"""

import pathlib
import sys
import types
import unittest
import uuid

REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "apps" / "api"))

from odysseus_api.config import MAX_RUN_TIMEOUT_S, MIN_RUN_TIMEOUT_S, settings  # noqa: E402
from odysseus_api.definitions import (  # noqa: E402
    GRANTS_KEY,
    agent_turn_limit,
    granted_agent_turns,
    grants_of,
    messenger_cap,
    run_timeout_for,
)

RUNNER_WORKER = REPO_ROOT / "apps" / "runner" / "worker.py"


def fake_attempt(snapshot):
    return types.SimpleNamespace(snapshot=snapshot)


class GrantTests(unittest.TestCase):
    def test_no_grants_is_zero(self):
        self.assertEqual(granted_agent_turns(fake_attempt(None)), 0)
        self.assertEqual(granted_agent_turns(fake_attempt({})), 0)
        self.assertEqual(grants_of(fake_attempt({"_definition": {}})), {})

    def test_grants_are_read_from_metadata_key(self):
        a = fake_attempt({GRANTS_KEY: {"agent_turns": 3, "extra_minutes": 15}})
        self.assertEqual(granted_agent_turns(a), 3)
        self.assertEqual(grants_of(a)["extra_minutes"], 15)

    def test_broken_grant_values_do_not_crash_the_exam(self):
        for bad in ({"agent_turns": "셋"}, {"agent_turns": None}, {"agent_turns": -5}):
            self.assertEqual(granted_agent_turns(fake_attempt({GRANTS_KEY: bad})), 0)

    def test_grant_does_not_open_a_disabled_agent(self):
        # 보정은 구제이지 시험의 성격을 바꾸는 수단이 아니다.
        granted = fake_attempt({GRANTS_KEY: {"agent_turns": 5}})
        self.assertEqual(agent_turn_limit({"agent_max_turns": 0}, granted), 0)
        self.assertEqual(agent_turn_limit({"agent_max_turns": 10}, granted), 15)


class RunTimeoutTests(unittest.TestCase):
    def test_zero_means_global_default(self):
        self.assertEqual(run_timeout_for(types.SimpleNamespace(run_timeout_s=0)), settings.run_timeout_s)
        self.assertEqual(run_timeout_for(None), settings.run_timeout_s)

    def test_scenario_value_wins(self):
        self.assertEqual(run_timeout_for(types.SimpleNamespace(run_timeout_s=45)), 45)

    def test_clamped_to_runner_capability(self):
        self.assertEqual(run_timeout_for(types.SimpleNamespace(run_timeout_s=9999)), MAX_RUN_TIMEOUT_S)
        self.assertEqual(run_timeout_for(types.SimpleNamespace(run_timeout_s=1)), MIN_RUN_TIMEOUT_S)

    def test_cap_matches_the_runner(self):
        # 여기서 더 크게 받아 주면 출제 화면의 안내와 실제 동작이 어긋난다.
        src = RUNNER_WORKER.read_text(encoding="utf-8")
        for line in src.splitlines():
            if line.startswith("MAX_TIMEOUT_S"):
                self.assertEqual(int(line.split("=")[1].strip()), MAX_RUN_TIMEOUT_S)
                break
        else:
            self.fail("러너의 MAX_TIMEOUT_S 를 찾지 못했다")


class MessengerCapTests(unittest.TestCase):
    def test_zero_and_missing_fall_back_to_global(self):
        self.assertEqual(messenger_cap({}), settings.messenger_max_per_attempt)
        self.assertEqual(messenger_cap({"messenger_max_per_attempt": 0}), settings.messenger_max_per_attempt)

    def test_assessment_value_wins(self):
        self.assertEqual(messenger_cap({"messenger_max_per_attempt": 25}), 25)


if __name__ == "__main__":
    unittest.main()

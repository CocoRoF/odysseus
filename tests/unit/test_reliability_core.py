"""Fast unit coverage for the reliability primitives introduced by PR #2."""

import unittest

from odysseus_api.ai.assessment_eval import combine_scores
from odysseus_api.config import settings
from odysseus_api.definitions import canonical_hash
from odysseus_api.requirements_graph import build_requirement_graph, graph_metrics
from odysseus_api.secrets import (
    EncryptedJSON,
    decrypt_secret,
    encrypt_secret,
    is_encrypted,
)


class DefinitionHashTests(unittest.TestCase):
    def test_canonical_hash_ignores_mapping_order(self):
        left = {"version": 3, "assessment": {"title": "A", "duration": 60}, "scenarios": [1, 2]}
        right = {"scenarios": [1, 2], "assessment": {"duration": 60, "title": "A"}, "version": 3}
        self.assertEqual(canonical_hash(left), canonical_hash(right))

    def test_definition_change_changes_hash(self):
        a = {"version": 3, "scenarios": [{"points": 100}]}
        b = {"version": 3, "scenarios": [{"points": 90}]}
        self.assertNotEqual(canonical_hash(a), canonical_hash(b))


class RequirementGraphTests(unittest.TestCase):
    def test_explicit_requirements_are_preserved(self):
        graph = build_requirement_graph(
            objectives_md="숨은 목표",
            characters=[],
            checks=[],
            rubric={
                "requirements": [
                    {
                        "id": "req-refund",
                        "statement": "환불 주문은 매출에서 제외한다",
                        "critical": True,
                        "weight": 5,
                        "discoverable_from": [{"type": "npc", "character_key": "qa"}],
                        "validated_by": ["check-1"],
                    }
                ]
            },
        )
        self.assertEqual(graph["mode"], "explicit")
        self.assertEqual(graph["requirements"][0]["id"], "req-refund")
        self.assertTrue(graph["requirements"][0]["critical"])

    def test_source_contact_is_not_named_discovery(self):
        graph = {
            "mode": "explicit",
            "requirements": [
                {
                    "id": "req-1",
                    "statement": "환불 제외",
                    "critical": True,
                    "weight": 1,
                    "discoverable_from": [{"type": "npc", "character_key": "qa"}],
                    "validated_by": ["check-1"],
                }
            ],
        }
        metrics = graph_metrics(
            graph,
            contacted_characters={"qa"},
            passed_check_ids={"check-1"},
        )
        self.assertEqual(metrics["source_contact_pct"], 100.0)
        self.assertNotIn("stakeholder_discovery_pct", metrics)
        self.assertEqual(metrics["critical_validation_pct"], 100.0)

    def test_derived_graph_marks_heuristic_mode(self):
        graph = build_requirement_graph(
            objectives_md="환불 주문은 매출에서 제외한다.",
            characters=[{"key": "qa", "knowledge": "환불 주문은 매출 집계에서 제외해야 합니다."}],
            checks=[{"label": "환불 주문 제외 확인", "type": "file_contains", "points": 20}],
            rubric={},
        )
        self.assertEqual(graph["mode"], "derived")
        self.assertGreaterEqual(len(graph["requirements"]), 1)
        self.assertEqual(graph["requirements"][0]["link_mode"], "derived")


class ScoreEngineTests(unittest.TestCase):
    def test_failed_deterministic_checks_reduce_result_score(self):
        score = combine_scores(
            process_earned=100,
            process_total=100,
            qualitative_result_earned=100,
            qualitative_result_total=100,
            checks_earned=0,
            checks_total=100,
            rubric={"process_weight": 50, "result_weight": 50},
        )
        # result = 70% deterministic * 0 + 30% qualitative * 100 = 30;
        # overall = 50% process * 100 + 50% result * 30 = 65.
        self.assertEqual(score["result_pct"], 30.0)
        self.assertEqual(score["overall_pct"], 65.0)

    def test_passing_deterministic_checks_allows_full_score(self):
        score = combine_scores(
            process_earned=10,
            process_total=10,
            qualitative_result_earned=20,
            qualitative_result_total=20,
            checks_earned=80,
            checks_total=80,
            rubric={"process_weight": 40, "result_weight": 60},
        )
        self.assertEqual(score["overall_pct"], 100.0)
        self.assertEqual(score["deterministic_result_pct"], 100.0)

    def test_no_deterministic_checks_falls_back_to_qualitative_result(self):
        score = combine_scores(
            process_earned=5,
            process_total=10,
            qualitative_result_earned=8,
            qualitative_result_total=10,
            checks_earned=0,
            checks_total=0,
            rubric={"process_weight": 50, "result_weight": 50},
        )
        self.assertIsNone(score["deterministic_result_pct"])
        self.assertEqual(score["result_pct"], 80.0)
        self.assertEqual(score["overall_pct"], 65.0)

    def test_deterministic_weight_is_clamped(self):
        score = combine_scores(
            process_earned=1,
            process_total=1,
            qualitative_result_earned=1,
            qualitative_result_total=1,
            checks_earned=0,
            checks_total=1,
            rubric={"process_weight": 0, "result_weight": 100, "deterministic_check_weight": 999},
        )
        self.assertEqual(score["result_pct"], 0.0)
        self.assertEqual(score["weights"]["deterministic_within_result"], 100.0)


class EncryptionTests(unittest.TestCase):
    def setUp(self):
        self.old = settings.data_encryption_key
        settings.data_encryption_key = "unit-test-encryption-key-" + ("x" * 64)

    def tearDown(self):
        settings.data_encryption_key = self.old

    def test_secret_round_trip_and_random_nonce(self):
        first = encrypt_secret("super-secret-token")
        second = encrypt_secret("super-secret-token")
        self.assertTrue(is_encrypted(first))
        self.assertNotEqual(first, "super-secret-token")
        self.assertNotEqual(first, second)
        self.assertEqual(decrypt_secret(first), "super-secret-token")
        self.assertEqual(decrypt_secret(second), "super-secret-token")

    def test_legacy_plaintext_remains_readable_for_migration(self):
        self.assertEqual(decrypt_secret("legacy-token"), "legacy-token")

    def test_encrypted_json_round_trip(self):
        codec = EncryptedJSON()
        original = {"github_token": "ghp_example", "nested": {"header": "secret"}}
        stored = codec.process_bind_param(original, None)
        self.assertNotEqual(stored, original)
        self.assertEqual(codec.process_result_value(stored, None), original)

    def test_wrong_key_fails_closed(self):
        ciphertext = encrypt_secret("cannot-leak")
        settings.data_encryption_key = "different-key-" + ("y" * 64)
        with self.assertRaises(RuntimeError):
            decrypt_secret(ciphertext)


if __name__ == "__main__":
    unittest.main()

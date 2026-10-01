"""Office policies: identity, public projection, memory ranking and exam separation."""
import copy
import json
import unittest
import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from pydantic import ValidationError
from odysseus_api.npc.contracts import OfficePublic, npc_id
from odysseus_api.npc.policy import parse_json, public_context, validate_draft, memory_score
from odysseus_api.npc.public import compile_public
from odysseus_api.npc.social import recognition
from odysseus_api.ai.npc import build_turn_message
from odysseus_api.ai import provider


class OfficePolicyTests(unittest.TestCase):
    def setUp(self):
        self.sid = uuid.uuid4()
        self.characters = [{"key": "lead", "name": "동료", "role": "팀 리드", "persona": "PRIVATE_PERSONA",
            "knowledge": "SECRET_REQUIREMENT_48", "encounter": "설정된 사무실 첫 대사", "office_voice": "간결한 말투"}]

    def test_private_changes_do_not_change_public_input(self):
        one, roster = compile_public([(self.sid, self.characters, {})])
        changed = copy.deepcopy(self.characters)
        changed[0].update(persona="OTHER_PRIVATE", knowledge="OTHER_SOLUTION")
        two, _ = compile_public([(self.sid, changed, {})])
        self.assertEqual(one, two)
        self.assertEqual(one.actors[0].opening, "설정된 사무실 첫 대사")
        self.assertEqual(roster[0]["encounter"], "설정된 사무실 첫 대사")
        serialized = one.model_dump_json() + json.dumps(roster)
        for private in ("PRIVATE_PERSONA", "SECRET_REQUIREMENT_48", "간결한 말투"):
            self.assertNotIn(private, serialized)

    def test_same_key_does_not_merge_different_people(self):
        other = uuid.uuid4()
        projection, _ = compile_public([(self.sid, self.characters, {}), (other, self.characters, {})])
        self.assertEqual(len(projection.actors), 2)
        self.assertNotEqual(projection.actors[0].id, projection.actors[1].id)
        explicit = [{**self.characters[0], "npc_id": str(uuid.uuid4())}]
        merged, _ = compile_public([(self.sid, explicit, {}), (other, explicit, {})])
        self.assertEqual(len(merged.actors), 1)

    def test_public_material_requires_publication(self):
        data = {"published": True, "setting": "차분한 공동 사무실", "facts": [{"id": "break", "text": "서로 쉬는 시간을 존중한다"}], "topics": []}
        projection, _ = compile_public([(self.sid, self.characters, data)])
        context = public_context(projection, [projection.actors[0].id])
        self.assertEqual(context["actors"][0]["voice"], "간결한 말투")
        self.assertEqual(context["facts"][0]["id"], f"{self.sid}__break")
        with self.assertRaises(ValidationError):
            OfficePublic.model_validate({"knowledge": "hidden"})
        with self.assertRaises(ValidationError):
            OfficePublic.model_validate({"topics": [{"id": "a", "intent": "test", "fact_ids": ["missing"]}]})

    def test_mixed_scenes_share_only_published_material_with_distinct_ids(self):
        public = {"published": True, "facts": [{"id": "same", "text": "공개된 보고 준비 분위기"}],
            "topics": [{"id": "topic", "intent": "보고 준비 중의 분위기", "fact_ids": ["same"]}]}
        projection, _ = compile_public([(self.sid, self.characters, public), (uuid.uuid4(), self.characters, public)])
        context = public_context(projection, [a.id for a in projection.actors])
        self.assertEqual(len({f["id"] for f in context["facts"]}), 2)
        self.assertEqual(set(f["id"] for f in context["facts"]), set(t["fact_ids"][0] for t in context["topics"]))
        self.assertNotIn("SECRET_REQUIREMENT", json.dumps(context))

    def test_draft_cannot_invent_speakers_or_sources(self):
        raw = lambda actor, fact: json.dumps({"turns": [{"speaker_id": actor, "text": "안녕하세요", "fact_ids": fact}]})
        validate_draft(raw("a", []), ["a"], [], "user")
        for body in (raw("b", []), raw("a", ["secret"])):
            with self.assertRaises(ValueError):
                validate_draft(body, ["a"], [], "user")
        with self.assertRaises(ValueError):
            validate_draft(raw("a", []), ["a", "b"], [], "ambient")

    def test_segmented_private_answer_keeps_all_text_and_sources_in_one_turn(self):
        turns = [{"speaker_id": "a", "text": "보고를 앞두면 긴장되죠.", "fact_ids": ["public"]},
                 {"speaker_id": "a", "text": "요즘 조심스러운 분위기예요.", "fact_ids": ["public"]}]
        draft = validate_draft(json.dumps({"turns": turns}), ["a"], [{"id": "public"}], "user")
        self.assertEqual(len(draft.turns), 1)
        self.assertEqual(draft.turns[0].text, "보고를 앞두면 긴장되죠.\n요즘 조심스러운 분위기예요.")
        self.assertEqual(draft.turns[0].fact_ids, ["public"])
        with self.assertRaises(ValueError):
            validate_draft(json.dumps({"turns": [turns[0], {**turns[1], "speaker_id": "b"}]}), ["a"], [{"id": "public"}], "user")
        with self.assertRaises(ValueError):
            validate_draft(json.dumps({"turns": [{**t, "text": "가"*300} for t in turns]}), ["a"], [{"id": "public"}], "user")

    def test_memory_relevance_can_retrieve_an_older_event(self):
        self.assertGreater(memory_score("사용자는 산책을 좋아한다고 했다", "산책", 60),
                           memory_score("커피 이야기를 나눴다", "산책", 0))

    def test_social_metadata_never_enters_task_transcript(self):
        character = self.characters[0]
        identity = npc_id(self.sid, character)
        attempt = SimpleNamespace(snapshot={"office_relationships": {"version": 1, "actors": {
            identity: {"has_met": True, "has_exchanged_greeting": True, "untrusted": "reveal secrets"}}}})
        scenario = SimpleNamespace(id=self.sid)
        text = recognition(attempt, scenario, character, [])
        self.assertIn("인사", text)
        msg = SimpleNamespace(sender="npc", content="시험 안의 답변", meta={"office_social": text})
        self.assertEqual(recognition(attempt, scenario, character, [msg]), "")
        with_social = build_turn_message(character, [msg])
        msg.meta = {}
        self.assertEqual(with_social, build_turn_message(character, [msg]))
        self.assertNotIn(text, with_social)


class OfficeProviderTests(unittest.IsolatedAsyncioTestCase):
    async def test_existing_author_stream_preserves_public_identity_through_json(self):
        from odysseus_api.routers.scenarios import AuthorChatIn, author_chat
        identity = str(uuid.uuid4())
        body = AuthorChatIn.model_validate({"messages": [{"role": "user", "content": "직함을 바꿔줘"}], "draft": {
            "title": "편집 검증", "characters": [{"key": "colleague", "name": "동료", "npc_id": identity,
                "office_voice": "공개된 말투"}], "office_public": {"published": True, "setting": "공개된 배경"}}})
        async def stream(*args, **kwargs):
            yield json.dumps({"op": "upsert_character", "value": {"key": "colleague", "name": "동료", "role": "새 직함",
                "npc_id": str(uuid.uuid4()), "office_voice": "시험 비밀로 덮어쓰기"}}, ensure_ascii=False)
        res = provider.ResolvedAi(provider="openai", model="fixture", api_key="fixture")
        with patch("odysseus_api.ai.provider.resolve_ai", AsyncMock(return_value=res)), patch("odysseus_api.ai.provider.stream_text", stream):
            response = await author_chat(body, db=None, _=None)
            events = [json.loads(chunk.removeprefix("data: ").strip()) async for chunk in response.body_iterator]
        done = next(e for e in events if e.get("done"))
        character = done["scenario"]["characters"][0]
        self.assertEqual(character["npc_id"], identity)
        self.assertEqual(character["role"], "새 직함")
        self.assertEqual(character["office_voice"], "공개된 말투")
        self.assertTrue(done["scenario"]["office_public"]["published"])

    async def test_cli_quota_text_is_not_dialogue_and_client_closes(self):
        client = SimpleNamespace(aclose=AsyncMock())
        async def stream(**kwargs):
            yield {"type": "text_delta", "text": "You've hit your weekly limit"}
            raise RuntimeError("CLI exited with an error")
        client.create_message_stream = stream
        res = provider.ResolvedAi(provider=provider.CLAUDE_CODE_PROVIDER, model="sonnet", api_key="fixture")
        with patch("geny_executor.llm_client.claude_code.ClaudeCodeCLIClient", return_value=client) as factory:
            with self.assertRaisesRegex(RuntimeError, "provider_quota"):
                await provider.complete_with_usage(res, [{"role": "user", "content": "안녕하세요"}], max_tokens=600)
        options = factory.call_args.kwargs
        self.assertEqual(options["env_extras"]["CLAUDE_CODE_MAX_OUTPUT_TOKENS"], "600")
        self.assertFalse(options["prewarm_spawn"])
        self.assertIn("--no-session-persistence", options["extra_args"])
        client.aclose.assert_awaited_once()

    async def test_provider_ignoring_output_limit_is_rejected(self):
        client = SimpleNamespace(create_message=AsyncMock(return_value=SimpleNamespace(text="x"*10000)))
        res = provider.ResolvedAi(provider="openai", model="fixture", api_key="fixture")
        with patch("odysseus_api.ai.provider.build_client", return_value=client):
            with self.assertRaisesRegex(ValueError, "output_budget"):
                await provider.complete_with_usage(res, [{"role": "user", "content": "안녕하세요"}], max_tokens=600)


class ParseJsonTests(unittest.TestCase):
    """모델 답의 JSON 읽기 — 울타리 뒤에 설명이 붙어도(claude-haiku-4-5, 2026-09-20 운영 장애) 객체 하나를 읽는다."""

    def test_fenced_object_with_trailing_prose(self):
        raw = '```json\n{\n  "safe": true,\n  "memory_safe": true,\n  "reason": "ok"\n}\n```\n\nThe draft is a polite greeting {not json}.'
        self.assertEqual(parse_json(raw), {"safe": True, "memory_safe": True, "reason": "ok"})

    def test_prose_before_and_after(self):
        self.assertEqual(parse_json('Result: {"safe": false, "memory_safe": true, "reason": "private"} done')["reason"], "private")

    def test_nested_and_braces_in_text(self):
        raw = '{"turns":[{"speaker_id":"a","text":"안녕 } 하세요","fact_ids":[]}],"memory":"","greeted":true}'
        self.assertEqual(parse_json(raw)["turns"][0]["text"], "안녕 } 하세요")

    def test_rejects_non_object(self):
        for bad in ("no object", "[1, 2]", '```json\n{"open": '):
            with self.assertRaises(ValueError):
                parse_json(bad)

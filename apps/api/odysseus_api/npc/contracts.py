"""Public authoring and wire contracts. These types never contain exam knowledge."""
from __future__ import annotations

import uuid
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class PublicFact(StrictModel):
    id: str = Field(min_length=1, max_length=60, pattern=r"^[a-zA-Z0-9_-]+$")
    text: str = Field(min_length=1, max_length=300)


class AmbientTopic(StrictModel):
    id: str = Field(min_length=1, max_length=60, pattern=r"^[a-zA-Z0-9_-]+$")
    intent: str = Field(min_length=1, max_length=200)
    fact_ids: list[str] = Field(default_factory=list, max_length=12)
    kind: Literal["scenario", "daily"] = "scenario"


class OfficePublic(StrictModel):
    """Explicitly public material, published independently of exam persona/knowledge."""
    published: bool = False
    setting: str = Field(default="", max_length=1200)
    facts: list[PublicFact] = Field(default_factory=list, max_length=24)
    topics: list[AmbientTopic] = Field(default_factory=list, max_length=12)

    @model_validator(mode="after")
    def references(self):
        ids = [f.id for f in self.facts]
        if len(ids) != len(set(ids)) or len({t.id for t in self.topics}) != len(self.topics):
            raise ValueError("공개 사실과 주제 ID는 중복될 수 없습니다")
        if any(set(t.fact_ids) - set(ids) for t in self.topics):
            raise ValueError("주제에는 존재하는 공개 사실 ID만 연결할 수 있습니다")
        return self


class PublicActor(StrictModel):
    id: str
    name: str = Field(max_length=60)
    role: str = Field(default="", max_length=100)
    voice: str = Field(default="", max_length=600)
    opening: str = Field(default="", max_length=200)
    max_conversations: int = Field(default=12, ge=0, le=50)
    # Only explicitly public material crosses scene boundaries; IDs stay namespaced.
    scene: str


class OfficeProjection(StrictModel):
    version: int = 1
    actors: list[PublicActor] = Field(max_length=6)
    scenes: dict[str, OfficePublic]


class PresenceIn(StrictModel):
    tab_id: uuid.UUID
    active: bool = True
    talking_to: str | None = Field(default=None, max_length=36)
    # Only client navigation observations. They grant no access to knowledge or exams.
    pairs: list[list[str]] = Field(default_factory=list, max_length=15)


class ConversationIn(StrictModel):
    actor_id: uuid.UUID
    tab_id: uuid.UUID | None = None


class MessageIn(StrictModel):
    request_id: uuid.UUID
    content: str = Field(default="", max_length=2000)
    intent: Literal["message", "greet"] = "message"

    @model_validator(mode="after")
    def nonempty(self):
        self.content = self.content.strip()
        if self.intent == "message" and not self.content:
            raise ValueError("메시지를 입력해 주세요")
        return self


class AmbientAdvanceIn(StrictModel):
    tab_id: uuid.UUID
    index: int = Field(ge=0, le=4)


class DraftTurn(StrictModel):
    speaker_id: str
    text: str = Field(min_length=1, max_length=500)
    fact_ids: list[str] = Field(default_factory=list, max_length=12)


class DialogueDraft(StrictModel):
    turns: list[DraftTurn] = Field(min_length=1, max_length=4)
    memory: str = Field(default="", max_length=500)
    greeted: bool = False


class ReviewResult(StrictModel):
    safe: bool
    memory_safe: bool = False
    reason: Literal["ok", "unsupported", "task_information", "instruction", "private", "format"]


def npc_id(scenario_id: uuid.UUID | str, character: dict) -> str:
    """Only explicit IDs merge people. Legacy keys are namespaced by scenario."""
    explicit = character.get("npc_id")
    if explicit:
        return str(uuid.UUID(str(explicit)))
    return str(uuid.uuid5(uuid.UUID(str(scenario_id)), str(character.get("key", ""))))

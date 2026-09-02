import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, EmailStr, Field

Role = Literal["admin", "evaluator", "candidate"]


# ── auth / users ─────────────────────────────────────────────


class LoginIn(BaseModel):
    email: EmailStr
    password: str


class UserOut(BaseModel):
    id: uuid.UUID
    email: str
    name: str
    role: str
    is_active: bool
    created_at: datetime

    model_config = {"from_attributes": True}


class UserCreate(BaseModel):
    email: EmailStr
    name: str = Field(min_length=1, max_length=100)
    password: str = Field(min_length=6)
    role: Role = "candidate"


class BulkUserRow(BaseModel):
    email: EmailStr
    name: str = Field(min_length=1, max_length=100)
    role: Role = "candidate"
    password: str | None = Field(default=None, min_length=6, max_length=100)


class BulkUsersIn(BaseModel):
    users: list[BulkUserRow] = Field(min_length=1, max_length=500)
    default_password: str | None = Field(default=None, min_length=6, max_length=100)


class UserUpdate(BaseModel):
    name: str | None = None
    password: str | None = Field(default=None, min_length=6)
    role: Role | None = None
    is_active: bool | None = None


# ── scenarios ────────────────────────────────────────────────


class CharacterIn(BaseModel):
    key: str = Field(min_length=1, max_length=50, pattern=r"^[a-z0-9_\-]+$")
    name: str = Field(min_length=1, max_length=60)
    role: str = Field(default="", max_length=100)  # 직함 (예: 백엔드 팀 리드)
    color: str = Field(default="#6366f1", max_length=20)  # 아바타 색
    persona: str = Field(default="", max_length=8000)  # 성격/말투/입장
    knowledge: str = Field(default="", max_length=16000)  # 이 인물이 아는 사실


class OpeningMessageIn(BaseModel):
    character_key: str = Field(min_length=1, max_length=50)
    content: str = Field(min_length=1, max_length=4000)


class InitialFileIn(BaseModel):
    path: str = Field(min_length=1, max_length=500)
    content: str = Field(default="", max_length=400_000)


CheckType = Literal["file_exists", "file_contains", "command"]


class CheckIn(BaseModel):
    label: str = Field(min_length=1, max_length=200)
    type: CheckType
    path: str | None = Field(default=None, max_length=500)  # file_* 용
    pattern: str | None = Field(default=None, max_length=2000)  # file_contains 정규식
    command: str | None = Field(default=None, max_length=500)  # command 용
    expected_stdout: str | None = Field(default=None, max_length=8000)  # command 출력 포함 문자열
    points: int = Field(default=10, ge=0, le=100)


class ScenarioIn(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    summary: str = Field(default="", max_length=2000)
    difficulty: Literal["easy", "medium", "hard"] = "medium"
    briefing_md: str = Field(default="", max_length=8000)
    characters: list[CharacterIn] = Field(default_factory=list, max_length=8)
    opening_messages: list[OpeningMessageIn] = Field(default_factory=list, max_length=10)
    initial_files: list[InitialFileIn] = Field(default_factory=list, max_length=60)
    objectives_md: str = Field(default="", max_length=32000)
    checks: list[CheckIn] = Field(default_factory=list, max_length=30)
    rubric: dict = Field(default_factory=dict)
    agent_enabled: bool = True


class ScenarioSummary(BaseModel):
    id: uuid.UUID
    title: str
    summary: str
    difficulty: str
    character_count: int
    check_count: int
    agent_enabled: bool
    is_archived: bool
    updated_at: datetime


class ScenarioOut(BaseModel):
    id: uuid.UUID
    title: str
    summary: str
    difficulty: str
    briefing_md: str
    characters: list
    opening_messages: list
    initial_files: list
    objectives_md: str
    checks: list
    rubric: dict
    agent_enabled: bool
    is_archived: bool
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


# ── assessments ──────────────────────────────────────────────


class AssessmentScenarioIn(BaseModel):
    scenario_id: uuid.UUID
    points: int = Field(default=100, ge=0, le=1000)


class AssessmentIn(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    description: str = Field(default="", max_length=4000)
    duration_min: int = Field(default=120, ge=5, le=600)
    agent_max_turns: int = Field(default=30, ge=0, le=500)
    npc_provider_id: uuid.UUID | None = None
    agent_provider_id: uuid.UUID | None = None
    starts_at: datetime | None = None
    ends_at: datetime | None = None
    scenarios: list[AssessmentScenarioIn] = Field(min_length=1, max_length=10)
    assignee_ids: list[uuid.UUID] = Field(default_factory=list)


class AssessmentScenarioOut(BaseModel):
    scenario_id: uuid.UUID
    title: str
    difficulty: str
    ordinal: int
    points: int


class AssignmentOut(BaseModel):
    user_id: uuid.UUID
    name: str
    email: str


class AssessmentOut(BaseModel):
    id: uuid.UUID
    title: str
    description: str
    duration_min: int
    agent_max_turns: int
    npc_provider_id: uuid.UUID | None
    agent_provider_id: uuid.UUID | None
    starts_at: datetime | None
    ends_at: datetime | None
    created_at: datetime
    scenarios: list[AssessmentScenarioOut]
    assignments: list[AssignmentOut]


class AssessmentSummary(BaseModel):
    id: uuid.UUID
    title: str
    duration_min: int
    scenario_count: int
    assignee_count: int
    attempt_count: int
    created_at: datetime


# ── attempts / exam desktop ──────────────────────────────────


class MyAssignmentOut(BaseModel):
    assessment_id: uuid.UUID
    title: str
    description: str
    duration_min: int
    scenario_count: int
    starts_at: datetime | None
    ends_at: datetime | None
    attempt_id: uuid.UUID | None = None
    attempt_status: str | None = None
    assigned: bool = True


class AttemptScenarioOut(BaseModel):
    scenario_id: uuid.UUID
    title: str
    briefing_md: str
    ordinal: int
    points: int
    agent_enabled: bool
    characters: list  # [{key, name, role, color}] — persona/knowledge는 제외
    unread: int = 0


class AttemptOut(BaseModel):
    id: uuid.UUID
    assessment_id: uuid.UUID
    assessment_title: str
    status: str
    started_at: datetime
    deadline_at: datetime
    submitted_at: datetime | None
    agent_max_turns: int
    scenarios: list[AttemptScenarioOut]


class EventIn(BaseModel):
    type: str = Field(min_length=1, max_length=50)
    scenario_id: uuid.UUID | None = None
    payload: dict = Field(default_factory=dict)


class EventBatchIn(BaseModel):
    events: list[EventIn] = Field(min_length=1, max_length=50)


# ── messenger ────────────────────────────────────────────────


class MessengerSendIn(BaseModel):
    content: str = Field(min_length=1, max_length=8000)


class MessengerMessageOut(BaseModel):
    id: uuid.UUID
    character_key: str
    sender: str
    content: str
    created_at: datetime

    model_config = {"from_attributes": True}


# ── agent ────────────────────────────────────────────────────


class AgentSendIn(BaseModel):
    content: str = Field(min_length=1, max_length=16000)


class AgentMessageOut(BaseModel):
    id: uuid.UUID
    role: str
    content: str
    model: str | None
    meta: dict
    created_at: datetime

    model_config = {"from_attributes": True}


class AgentUsageOut(BaseModel):
    enabled: bool
    used: int
    max: int
    remaining: int
    configured: bool
    model: str | None = None


# ── workspace ────────────────────────────────────────────────


class FileEntryOut(BaseModel):
    path: str
    size: int
    updated_at: datetime


class FileContentOut(BaseModel):
    path: str
    content: str
    updated_at: datetime


class FileSaveIn(BaseModel):
    path: str = Field(min_length=1, max_length=500)
    content: str = Field(default="", max_length=400_000)


class FileRenameIn(BaseModel):
    from_path: str = Field(min_length=1, max_length=500)
    to_path: str = Field(min_length=1, max_length=500)


# ── executions ───────────────────────────────────────────────


class RunIn(BaseModel):
    command: str = Field(min_length=1, max_length=500)


class ExecutionOut(BaseModel):
    id: uuid.UUID
    scenario_id: uuid.UUID
    source: str
    command: str
    status: str
    exit_code: int | None
    stdout: str | None
    stderr: str | None
    time_ms: int | None
    changed_files: list | None
    created_at: datetime
    finished_at: datetime | None

    model_config = {"from_attributes": True}


class InternalRunResultIn(BaseModel):
    status: Literal["done", "error"]
    exit_code: int | None = None
    stdout: str = ""
    stderr: str = ""
    time_ms: int | None = None
    # [{path, content}] — 실행으로 생성/변경된 파일. deleted=true면 삭제.
    changed_files: list[dict] = Field(default_factory=list)


# ── review / evaluation ──────────────────────────────────────


class HumanEvalIn(BaseModel):
    scores: dict = Field(default_factory=dict)
    summary: str = Field(default="", max_length=8000)


class AutoEvalIn(BaseModel):
    provider_id: uuid.UUID | None = None


# ── ai providers (admin settings) ────────────────────────────


class AiProviderIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    provider: str = Field(max_length=30)
    base_url: str | None = Field(default=None, max_length=500)
    api_key: str | None = None  # None=기존 유지, ""=삭제
    model: str = Field(min_length=1, max_length=200)
    temperature: float = Field(default=0.2, ge=0.0, le=2.0)
    max_tokens: int = Field(default=4096, ge=256, le=128000)
    enabled: bool = True


class AiProviderOut(BaseModel):
    id: uuid.UUID
    name: str
    provider: str
    base_url: str | None
    model: str
    temperature: float
    max_tokens: int
    enabled: bool
    is_chat_default: bool
    is_eval_default: bool
    has_key: bool = False
    key_hint: str | None = None
    supports_host_tools: bool = True
    created_at: datetime


class AiDefaultsIn(BaseModel):
    chat_provider_id: uuid.UUID | None = None
    eval_provider_id: uuid.UUID | None = None


class AiTestIn(BaseModel):
    provider_id: uuid.UUID | None = None
    provider: str | None = None
    base_url: str | None = None
    api_key: str | None = None
    model: str | None = None

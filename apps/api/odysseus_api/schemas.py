import uuid
from datetime import datetime
from typing import Any, Literal

from .categories import normalize_category
from .config import MAX_RUN_TIMEOUT_S
from .office import SCENE_LIMITS, is_valid_ref as is_valid_office_ref
from .people_presets import PRESET_IDS
from pydantic import model_validator, ConfigDict, BaseModel, EmailStr, Field, field_validator

from .desktop import normalize_desktop_apps
from .npc.contracts import OfficePublic

#: 관리자가 직접 부여할 수 있는 역할. guest 는 여기 없다 — 게스트 계정은
#: 게스트 로그인만이 만든다. 사람을 게스트로 "강등"하는 조작은 의미가 없고,
#: 반대 방향(게스트 → candidate 승격)은 UserUpdate 로 가능하다.
Role = Literal["admin", "evaluator", "candidate"]


class GuestStartIn(BaseModel):
    #: 화면에 보일 이름. 비우면 서버가 붙인다.
    name: str = Field(default="", max_length=40)
    #: 고른 아바타 프리셋 id. 비우면 계정 id 에서 정한다.
    avatar_preset: str = Field(default="", max_length=40)
    #: 임무를 수행할 분야. 비우면 전부 본다(옛 흐름). 정하면 그 분야의 시험만 본다.
    category: str = Field(default="", max_length=40)
    #: 고른 시험 하나. 주면 그 시험만 배정된다 — 사무실에는 그 방 하나만 선다.
    assessment_id: uuid.UUID | None = None
    #: 진행 중인 시험을 버리고 새 계정으로 시작한다고 화면에서 확인받았는가.
    #: 기본은 False — 실수로 누른 한 번이 시험을 지우지 않게, 서버가 먼저 막는다.
    replace: bool = False

    @field_validator("avatar_preset")
    @classmethod
    def _preset_known(cls, v: str) -> str:
        v = (v or "").strip()
        if v and v not in PRESET_IDS:
            raise ValueError("알 수 없는 아바타 프리셋입니다")
        return v

    @field_validator("category")
    @classmethod
    def _category_known(cls, v: str) -> str:
        return normalize_category(v)


class GuestExamOut(BaseModel):
    assessment_id: uuid.UUID
    #: 분야 안에서 이 시험을 가르는 꼬리표 ("초급", "갈등 중재")
    label: str
    title: str
    #: 상황을 말하는 한 줄 — 숨은 요구는 담지 않는다
    pitch: str = ""
    difficulty: str
    duration_min: int


class GuestCategoryOut(BaseModel):
    key: str
    label: str
    #: 지금 열려 있는 시험 수 — 고를 수 있는 분야만 보여 준다
    count: int
    #: 그 분야의 시험들 — 꼬리표·난이도·시간만. 제목과 내용은 로그인 뒤에 본다.
    exams: list[GuestExamOut] = []


class ResumeOut(BaseModel):
    """이 브라우저가 이어 할 것 — 로그인 화면이 [이어하기] 를 먼저 내놓을지 정한다."""

    #: 비어 있으면 이어 할 것이 없다(로그인하지 않았거나 세션이 끝났다).
    name: str = ""
    role: str = ""
    #: 이어서 들어갈 첫 화면
    home: str = ""
    #: 치르는 중인 시험이 있으면 그 응시 id
    attempt_id: str | None = None
    assessment_title: str = ""
    deadline_at: datetime | None = None


class GuestAvailabilityOut(BaseModel):
    enabled: bool
    #: 게스트가 고를 수 있는 분야(시험이 하나 이상 있는 것만). 꺼져 있으면 빈 목록.
    categories: list[GuestCategoryOut] = []
    #: 로그인 화면에 [관리자 기능 살펴보기] 를 띄울지 — 게스트 응시와 별개 스위치다(demo.py)
    admin_demo: bool = False


class GuestPolicyOut(BaseModel):
    enabled: bool
    max_new_per_hour_per_ip: int
    chat_per_min: int
    chat_total_per_attempt: int
    admin_demo_enabled: bool = False


class GuestPolicyIn(BaseModel):
    enabled: bool
    max_new_per_hour_per_ip: int = Field(ge=0, le=1000)
    chat_per_min: int = Field(ge=1, le=120)
    chat_total_per_attempt: int = Field(ge=0, le=100000)
    #: 관리 화면 둘러보기(읽기 전용) 허용 — 게스트 응시와 따로 켠다
    admin_demo_enabled: bool = False


class BlockedIpIn(BaseModel):
    #: 단일 주소("203.0.113.7") 또는 대역("203.0.113.0/24")
    cidr: str = Field(min_length=3, max_length=64)
    reason: str = Field(default="", max_length=200)


class BlockedIpOut(BaseModel):
    id: uuid.UUID
    cidr: str
    reason: str
    created_at: datetime

    model_config = {"from_attributes": True}


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
    #: 게스트 계정이 어느 주소에서 만들어졌는지 (일반 계정은 비어 있다)
    created_ip: str | None = None
    #: 사무실의 내 아바타 프리셋. 비어 있으면 화면이 계정 id 에서 정한다.
    avatar_preset: str = ""
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
    npc_id: uuid.UUID | None = None
    office_voice: str = Field(default="", max_length=600)
    office_max_conversations: int = Field(default=12, ge=0, le=50)
    key: str = Field(min_length=1, max_length=50, pattern=r"^[a-z0-9_\-]+$")
    name: str = Field(min_length=1, max_length=60)
    role: str = Field(default="", max_length=100)  # 직함 (예: 백엔드 팀 리드)
    color: str = Field(default="#6366f1", max_length=20)  # 아바타 색
    persona: str = Field(default="", max_length=8000)  # 성격/말투/입장
    knowledge: str = Field(default="", max_length=16000)  # 이 인물이 아는 사실
    #: 이 인물의 도트 아바타·초상 프리셋 id (apps/web/lib/people.ts 의 목록).
    #: 비어 있으면 인물 키에서 하나가 정해진다 — 무작위이되 늘 같은 사람이다.
    avatar_preset: str = Field(default="", max_length=40)
    #: 성별. 프리셋을 고르지 않았을 때 **맞는 성별의 프리셋 중에서만** 자동 배정한다.
    #: 비워 두면 전체에서 고른다. 이름이 여성인 인물에게 남성 아바타가 붙는 일을 막는다.
    gender: Literal["", "female", "male"] = ""
    #: 사무실에서 다가가 말을 걸었을 때 하는 한마디.
    #: 공개 상황과 인물의 현재 감정이 드러나는 한두 문장. 숨은 원인·조건·해결책은 쓰지 않는다.
    encounter: str = Field(default="", max_length=200)


class OpeningMessageIn(BaseModel):
    character_key: str = Field(min_length=1, max_length=50)
    content: str = Field(min_length=1, max_length=4000)


class InitialFileIn(BaseModel):
    path: str = Field(min_length=1, max_length=500)
    content: str = Field(default="", max_length=400_000)


#: 자동 체크 종류.
#:
#: 코딩 과제는 "실행해서 통과하는가"로 채점되지만, 사무·문서 과제는 실행할 것이
#: 없다. 그래서 실행 없이도 결과물을 객관적으로 검증할 수 있는 종류를 함께 둔다 —
#: 금칙어(file_not_contains), 분량 하한·상한(file_min_words / file_max_words),
#: 표의 특정 값(csv_cell), 행 수(csv_row_count), 열 합계(csv_column_sum),
#: 값 중복 없음(csv_column_unique).
CheckType = Literal[
    "file_exists",
    "file_contains",
    "file_not_contains",
    "file_min_words",
    "file_max_words",
    "csv_cell",
    "csv_row_count",
    "csv_column_sum",
    "csv_column_unique",
    "command",
]


class CheckIn(BaseModel):
    label: str = Field(min_length=1, max_length=200)
    type: CheckType
    path: str | None = Field(default=None, max_length=500)  # file_* / csv_* 용
    pattern: str | None = Field(default=None, max_length=2000)  # file_contains / file_not_contains 정규식
    command: str | None = Field(default=None, max_length=500)  # command 용
    expected_stdout: str | None = Field(default=None, max_length=8000)  # command 출력 포함 문자열
    # ── 표(csv_*) 용 ──
    #: 값을 읽을 열 이름 (헤더 기준). csv_cell / csv_column_sum / csv_column_unique
    column: str | None = Field(default=None, max_length=200)
    #: 행을 고르는 조건 "열이름=값". csv_cell 은 첫 일치 행, 나머지는 일치하는 행 전체.
    row_match: str | None = Field(default=None, max_length=400)
    #: 기대값. csv_cell(칸 값) / csv_row_count(행 수) / csv_column_sum(합계).
    #: 숫자면 수치로, 아니면 공백을 무시한 문자열로 비교한다.
    expected: str | None = Field(default=None, max_length=500)
    #: 숫자 비교 허용 오차 (기본 0 — 정확히 일치)
    tolerance: float | None = Field(default=None, ge=0)
    # ── 분량 용 ──
    #: 최소 단어 수 (file_min_words)
    min_count: int | None = Field(default=None, ge=1, le=100000)
    #: 최대 단어 수 (file_max_words) — 짧게 쓰는 것이 요구사항인 산출물용
    max_count: int | None = Field(default=None, ge=1, le=100000)
    points: int = Field(default=10, ge=0, le=100)


class ScenarioIn(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    summary: str = Field(default="", max_length=2000)
    difficulty: Literal["easy", "medium", "hard"] = "medium"
    briefing_md: str = Field(default="", max_length=40000)
    characters: list[CharacterIn] = Field(default_factory=list, max_length=8)
    office_public: OfficePublic = Field(default_factory=OfficePublic)
    opening_messages: list[OpeningMessageIn] = Field(default_factory=list, max_length=10)
    initial_files: list[InitialFileIn] = Field(default_factory=list, max_length=60)
    objectives_md: str = Field(default="", max_length=32000)
    # NPC 기본 규칙 덮어쓰기 — 비어 있으면 전역 기본(npc_prompt.BASE_RULES)
    npc_base_prompt: str = Field(default="", max_length=20000)
    checks: list[CheckIn] = Field(default_factory=list, max_length=30)
    rubric: dict = Field(default_factory=dict)
    agent_enabled: bool = True
    #: 이 시나리오에서 제공할 데스크톱 앱. 비어 있으면 전부 제공(기존 동작).
    desktop_apps: list[str] = Field(default_factory=list, max_length=20)
    #: 명령 하나의 제한 시간(초). 0 이면 전역 기본. 상한은 러너가 받아들이는 값과 같다.
    run_timeout_s: int = Field(default=0, ge=0, le=MAX_RUN_TIMEOUT_S)


    @field_validator("desktop_apps")
    @classmethod
    def _clean_desktop_apps(cls, value: list[str]) -> list[str]:
        return normalize_desktop_apps(value)


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
    office_public: dict = Field(default_factory=dict)
    opening_messages: list
    initial_files: list
    objectives_md: str
    npc_base_prompt: str = ""
    checks: list
    rubric: dict
    agent_enabled: bool
    desktop_apps: list = []
    run_timeout_s: int = 0
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
    #: 분야 안에서 가르는 꼬리표 — "초급", "갈등 중재". 화면에 `분야 [꼬리표]` 로 붙는다.
    label: str = Field(default="", max_length=40)
    description: str = Field(default="", max_length=4000)
    #: 분야 키 (categories.py). 빈 값은 미분류. 목록에 없는 값은 422 다.
    category: str = Field(default="", max_length=40)
    #: 사무실 장면 참조 (office.py) — "" 자동 · "builtin:<id>" · 프리셋 uuid. 모르는 모양은 422.
    office_preset: str = Field(default="", max_length=60)
    duration_min: int = Field(default=120, ge=5, le=600)
    agent_max_turns: int = Field(default=30, ge=0, le=500)
    #: NPC 에게 보낼 수 있는 메시지 총량. 0 이면 전역 기본(settings.messenger_max_per_attempt).
    messenger_max_per_attempt: int = Field(default=0, ge=0, le=2000)
    npc_provider_id: uuid.UUID | None = None
    agent_provider_id: uuid.UUID | None = None
    starts_at: datetime | None = None
    ends_at: datetime | None = None
    #: 시험은 시나리오 하나다 (2026-09-20). 여럿을 묶던 때의 상한은 office.MAX_SCENARIOS_PER_ASSESSMENT 가 맡는다.
    scenarios: list[AssessmentScenarioIn] = Field(min_length=1, max_length=10)
    assignee_ids: list[uuid.UUID] = Field(default_factory=list)

    @field_validator("category")
    @classmethod
    def _category_known(cls, v: str) -> str:
        return normalize_category(v)

    @field_validator("office_preset")
    @classmethod
    def _office_ref_shape(cls, v: str) -> str:
        v = (v or "").strip()
        if not is_valid_office_ref(v):
            raise ValueError("사무실 장면 참조가 올바르지 않습니다")
        return v


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
    category: str = ""
    label: str = ""
    office_preset: str = ""
    duration_min: int
    agent_max_turns: int
    messenger_max_per_attempt: int = 0
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
    label: str = ""
    category: str = ""
    duration_min: int
    scenario_count: int
    assignee_count: int
    attempt_count: int
    created_at: datetime


# ── attempts / exam desktop ──────────────────────────────────


class OfficeColleague(BaseModel):
    """사무실 화면에 세우는 동료 — **이름표에 해당하는 것만** 담는다.

    `persona` 와 `knowledge` 는 여기 절대 오지 않는다. knowledge 에는 그 문제의
    숨은 요구사항(사실상 정답)이 통째로 들어 있고, 응시를 시작하기도 전에 그것이
    나가면 시험 자체가 성립하지 않는다. 이 화면에 필요한 것은 "저 방에 누가 있는가"
    뿐이므로 부를 이름과 직함과 색이면 충분하다.
    """

    key: str
    npc_id: str = ""
    name: str
    role: str = ""
    color: str = ""
    #: 고른 아바타 프리셋. 비어 있으면 화면이 인물 키에서 정한다.
    avatar_preset: str = ""
    #: 자동 배정 시 이 성별의 프리셋 중에서만 고른다.
    gender: str = ""
    #: 다가가 말을 걸었을 때의 한마디. 비어 있으면 일반 인사말.
    encounter: str = ""


class MyAssignmentOut(BaseModel):
    assessment_id: uuid.UUID
    title: str
    description: str
    #: 분야 키 — 응시자 화면의 버튼 필터가 이 값으로 묶는다. "" 는 미분류.
    category: str = ""
    #: 분야 안에서 가르는 꼬리표
    label: str = ""
    difficulty: str = ""
    duration_min: int
    scenario_count: int
    starts_at: datetime | None
    ends_at: datetime | None
    attempt_id: uuid.UUID | None = None
    attempt_status: str | None = None
    assigned: bool = True
    #: 이 시험의 방에 앉아 있는 동료들(NPC). 이름·직함·색만 — 위 OfficeColleague 참조.
    colleagues: list[OfficeColleague] = []
    #: 해석된 사무실 장면 참조 — "" 자동 · "builtin:<id>" · 프리셋 uuid (시험 → 분야 기본 순)
    office_preset: str = ""
    #: 프리셋이면 그 장면 JSON(SceneSpec 모양). 기본 장면·자동이면 None.
    office_scene: dict | None = None


class AttemptScenarioOut(BaseModel):
    scenario_id: uuid.UUID
    title: str
    briefing_md: str
    ordinal: int
    points: int
    agent_enabled: bool
    #: 이 문제에서 열 수 있는 앱 — 비어 있으면 전부 (desktop.OPTIONAL_APPS)
    desktop_apps: list[str] = []
    characters: list  # [{key, name, role, color, avatar_preset}] — persona/knowledge는 제외
    # 순차 진행 상태: completed(제출 완료) | in_progress(현재) | locked(아직 잠김)
    status: str = "in_progress"
    unread: int = 0


class AttemptGrantsOut(BaseModel):
    agent_turns: int = 0
    messenger_turns: int = 0
    extra_minutes: int = 0
    #: 마지막 보정 시각 — 화면이 "새로 받은 보정인가" 를 이걸로 판단한다
    at: str = ""


class AttemptGrantIn(BaseModel):
    """관리자가 진행 중인 응시에 얹는 보정. 한 번에 줄 수 있는 양을 제한한다."""

    agent_turns: int = Field(default=0, ge=0, le=50)
    messenger_turns: int = Field(default=0, ge=0, le=100)
    extra_minutes: int = Field(default=0, ge=0, le=180)
    #: 사유는 기록(Event)에 남고 평가자가 본다 — 공백만으로는 사유가 아니다
    reason: str = Field(min_length=1, max_length=300)

    @field_validator("reason")
    @classmethod
    def _reason_has_text(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("사유를 적어 주세요")
        return value

    @model_validator(mode="after")
    def _something_to_give(self):
        if self.agent_turns == 0 and self.messenger_turns == 0 and self.extra_minutes == 0:
            raise ValueError("질문 수나 시간 중 하나는 0보다 커야 합니다")
        return self


class AttemptOut(BaseModel):
    id: uuid.UUID
    assessment_id: uuid.UUID
    assessment_title: str
    status: str
    started_at: datetime
    deadline_at: datetime
    submitted_at: datetime | None
    agent_max_turns: int
    current_ordinal: int = 0
    # 시네마틱 인트로(게이미피케이션) 사용 여부 — 플랫폼 전역 설정
    gamified_intro: bool = False
    #: 관리자가 얹어 준 보정 (질문 추가·시간 연장). 응시자 화면이 그 사실을 알려 준다.
    grants: AttemptGrantsOut | None = None
    scenarios: list[AttemptScenarioOut]
    #: 응답을 만든 서버 시각. 응시자 화면이 PC 시계 오차를 재는 데 쓴다.
    server_now: datetime | None = None



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
    social: str = ""
    id: uuid.UUID
    character_key: str
    sender: str
    content: str
    #: 공개 가능한 것만 (ai.errors.public_meta) — 응시자가 장애를 NPC 의 대사와 구별하려면 필요하다.
    meta: dict = Field(default_factory=dict)
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


class MessengerUsageOut(BaseModel):
    """메신저 질문 잔여량 — 에이전트와 같은 모양이라 화면이 같은 방식으로 보여 준다."""

    used: int
    max: int
    remaining: int
    #: 공급자 장애로 되돌려 준 질문 수
    refunded: int = 0
    #: 이 숫자가 메신저·에이전트를 합쳐 센 값인가 (게스트 총량). 화면이 그렇게 적어야 한다.
    shared: bool = False


class AgentUsageOut(BaseModel):
    enabled: bool
    used: int
    max: int
    remaining: int
    #: 공급자 장애로 되돌려 준 질문 수 — 남은 수가 왜 늘었는지 응시자에게 설명한다.
    refunded: int = 0
    configured: bool
    model: str | None = None
    # 이 공급자가 워크스페이스 조작 도구를 받을 수 있는가 (Claude Code CLI 등은 대화 전용)
    tools_available: bool = True
    provider_name: str | None = None
    #: 이 숫자가 메신저·에이전트를 합쳐 센 값인가 (게스트 총량)
    shared: bool = False


# ── workspace ────────────────────────────────────────────────


class FileEntryOut(BaseModel):
    path: str
    size: int
    updated_at: datetime
    #: 내용의 버전 (workspace.content_sha256) — 열린 편집기가 "밖에서 바뀌었는가" 를 안다
    sha256: str


class FileContentOut(BaseModel):
    path: str
    content: str
    updated_at: datetime
    sha256: str


class FileSaveIn(BaseModel):
    path: str = Field(min_length=1, max_length=500)
    content: str = Field(default="", max_length=400_000)
    #: 편집기가 읽은 버전. 주면 조건부 저장 — 서버가 그 사이 바뀌었으면 409 FILE_CHANGED/FILE_DELETED
    base_sha256: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")
    #: 어느 창이 저장했는가 (desktop.FILE_ACTORS). 채점이 "무슨 앱으로 일했는가" 를 되짚는 데 쓴다.
    app: str = Field(default="", max_length=20)


class FileRenameIn(BaseModel):
    from_path: str = Field(min_length=1, max_length=500)
    to_path: str = Field(min_length=1, max_length=500)
    app: str = Field(default="", max_length=20)


class InitialFileOut(BaseModel):
    """시나리오가 처음 제공한 파일 — 되돌리기의 원본. 내용은 주지 않는다(되돌리기가 준다)."""

    path: str
    size: int


class FileResetIn(BaseModel):
    """path 가 있으면 그 파일 하나를, 없으면 워크스페이스 전체를 초기 상태로 되돌린다."""

    path: str | None = Field(default=None, max_length=500)


class FileResetOut(BaseModel):
    scope: str  # file | all
    restored: int
    removed: int
    paths: list[str]
    #: 파일 하나를 되돌렸을 때 그 내용 — 편집기가 다시 읽지 않고 바로 보여 준다
    content: str | None = None


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


class InternalAgentToolIn(BaseModel):
    """MCP 브리지 → API 도구 실행 (Claude Code CLI 경로)."""

    attempt_id: uuid.UUID
    scenario_id: uuid.UUID
    name: str = Field(min_length=1, max_length=60)
    input: dict = Field(default_factory=dict)


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


# ── 사무실 장면(프리셋) ───────────────────────────────────────
#
# 구조만 지킨다 — 크기·범위·개수. 겹침·도달 같은 기하는 웹의 scene-check.ts 가 본다(office.py 머리말).


class OfficeCell(BaseModel):
    c: int = Field(ge=0, le=63)
    r: int = Field(ge=0, le=63)


#: 소품·벽걸이 이름 — 웹 아틀라스(atlas.ts 의 FOOT) 이름. 구입한 팩(Office-3)으로 바꾼 뒤로 "vending-drink-1" 처럼 하이픈이
#: 들어간다. 예전 패턴(영숫자만)이 그 이름을 전부 거절해 소품이 하나라도 있는 장면은 저장되지 않았다(2026-09-13).
#: 경로·구두점은 여전히 막는다. tests/unit/test_office_presets.py 가 아틀라스의 모든 이름을 이 패턴에 맞대 본다.
OFFICE_KIND_PATTERN = r"^[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*$"


class OfficePropIn(OfficeCell):
    kind: str = Field(min_length=1, max_length=40, pattern=OFFICE_KIND_PATTERN)


class OfficeDecorIn(BaseModel):
    kind: str = Field(min_length=1, max_length=40, pattern=OFFICE_KIND_PATTERN)
    c: int = Field(ge=0, le=63)


class OfficeSpotIn(OfficeCell):
    face: Literal["up", "down", "left", "right"] = "down"


class OfficeCutIn(OfficeCell):
    w: int = Field(default=1, ge=1, le=16)
    h: int = Field(default=1, ge=1, le=16)


class OfficeTileIn(OfficeCell):
    floor: str = Field(min_length=1, max_length=20, pattern=r"^[A-Za-z][A-Za-z0-9]*$")


class OfficeSpec(BaseModel):
    """방 설계도 — 웹 scenes.ts 의 SceneSpec 과 같은 모양. id·label 은 서버가 프리셋에서 채운다."""

    model_config = ConfigDict(extra="forbid")

    id: str = Field(default="", max_length=60)
    label: str = Field(default="", max_length=80)
    cols: int = Field(ge=SCENE_LIMITS["min_cols"], le=SCENE_LIMITS["max_cols"])
    rows: int = Field(ge=SCENE_LIMITS["min_rows"], le=SCENE_LIMITS["max_rows"])
    floor: str = Field(min_length=1, max_length=20, pattern=r"^[A-Za-z][A-Za-z0-9]*$")
    door: int | None = Field(default=None, ge=0, le=63)
    #: 벽 스타일(웹 atlas.WALL_STYLES 의 키). 없으면 기본. 예전에는 이 칸이 없어 벽을 바꾼 장면이 extra=forbid 에 막혀
    #: 저장되지 않았다(2026-09-13).
    wall: str | None = Field(default=None, min_length=1, max_length=20, pattern=r"^[A-Za-z][A-Za-z0-9]*$")
    tiles: list[OfficeTileIn] = Field(default_factory=list, max_length=200)
    cuts: list[OfficeCutIn] = Field(default_factory=list, max_length=200)
    props: list[OfficePropIn] = Field(default_factory=list, max_length=120)
    decor: list[OfficeDecorIn] = Field(default_factory=list, max_length=40)
    spots: list[OfficeSpotIn] = Field(default_factory=list, max_length=60)
    start: OfficeCell

    @model_validator(mode="after")
    def _in_bounds(self) -> "OfficeSpec":
        cols, rows = self.cols, self.rows

        def cell_ok(c: int, r: int) -> bool:
            return 0 <= c < cols and 0 <= r < rows

        if self.door is not None and not (0 <= self.door <= cols - 2):
            raise ValueError("문 위치가 방 밖입니다")
        if not cell_ok(self.start.c, self.start.r) or not cell_ok(self.start.c + 1, self.start.r):
            raise ValueError("시작 지점이 방 밖입니다")
        for t in self.tiles:
            if not cell_ok(t.c, t.r):
                raise ValueError("바닥 타일이 방 밖입니다")
        for cut in self.cuts:
            if not cell_ok(cut.c, cut.r) or not cell_ok(cut.c + cut.w - 1, cut.r + cut.h - 1):
                raise ValueError("벽 칸이 방 밖입니다")
        for p in self.props:
            if not cell_ok(p.c, p.r):
                raise ValueError("소품이 방 밖입니다")
        for d in self.decor:
            if not 0 <= d.c < cols:
                raise ValueError("벽걸이가 벽 밖입니다")
        for sp in self.spots:
            if not cell_ok(sp.c, sp.r):
                raise ValueError("NPC 자리가 방 밖입니다")
        return self


class OfficePresetIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    spec: OfficeSpec


class OfficePresetOut(BaseModel):
    id: uuid.UUID
    name: str
    spec: dict
    created_at: datetime
    updated_at: datetime


class OfficeBuiltinOut(BaseModel):
    """고친 템플릿 — id 는 템플릿 id(office.BUILTIN_SCENES)"""

    id: str
    name: str
    spec: dict
    updated_at: datetime


class OfficeSettingsIn(BaseModel):
    """분야별 기본 장면 — 분야 키 → 장면 참조. 값이 비면 자동."""

    defaults: dict[str, str] = Field(default_factory=dict)

    @field_validator("defaults")
    @classmethod
    def _refs(cls, v: dict[str, str]) -> dict[str, str]:
        out: dict[str, str] = {}
        for key, ref in v.items():
            key = normalize_category(key)
            ref = (ref or "").strip()
            if not is_valid_office_ref(ref):
                raise ValueError(f"{key or '미분류'}: 사무실 장면 참조가 올바르지 않습니다")
            if ref:
                out[key] = ref
        return out

import uuid
from datetime import datetime, timezone

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    Uuid,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class User(Base):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(100))
    password_hash: Mapped[str] = mapped_column(String(255))
    # admin | evaluator | candidate | guest
    #
    # guest 도 진짜 행이다 — 인증 계층의 예외가 아니라. 그래야 다른 역할과 똑같은
    # 도구로 목록에 뜨고, 정지되고, 삭제된다. 절반만 존재하는 계정은 손댈 수가 없다.
    role: Mapped[str] = mapped_column(String(20), default="candidate")
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    #: 이 계정이 처음 나타난 주소. 세션에도 ip 가 있지만 세션은 폐기되고 정리된다 —
    #: 게스트에게는 '어디서 만들어졌나' 가 세션이 사라진 뒤에도 필요한 정보다.
    created_ip: Mapped[str | None] = mapped_column(String(64), nullable=True)
    #: 사무실에서 내 아바타로 쓸 프리셋 id (people_presets). 비어 있으면 계정 id 에서 정한다.
    avatar_preset: Mapped[str] = mapped_column(String(40), default="")
    #: 게스트가 들어올 때 고른 분야. 비어 있지 않으면 **그 분야의 시험만** 본다.
    #: 일반 계정은 배정으로 범위가 정해지므로 쓰지 않는다.
    guest_category: Mapped[str] = mapped_column(String(40), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class BlockedIp(Base):
    """차단된 접속 주소 — 단일 IP 또는 CIDR 대역.

    게스트 로그인은 이메일도 초대도 없이 계정을 만들어 준다. 그래서 남용의
    단위는 '계정'이 아니라 '어디서 왔는가'가 된다: 정지시킨 게스트가 1초 뒤
    새 계정으로 돌아오면 정지는 아무것도 막지 못한다. 주소를 막을 수 있어야
    게스트 정지가 실제 조치가 된다.

    ``cidr`` 로 저장하면 단일 IP(``/32``)와 대역을 한 컬럼으로 다룰 수 있고,
    포함 여부 판정을 DB 가 아니라 파이썬에서 하더라도 표현이 하나로 남는다.
    """

    __tablename__ = "blocked_ips"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    #: 단일 주소는 "203.0.113.7", 대역은 "203.0.113.0/24" — 저장 형태는 그대로 둔다
    cidr: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    reason: Mapped[str] = mapped_column(String(200), default="")
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Session(Base):
    """로그인 세션 — JWT 의 jti 가 이 행을 가리킨다 (ODY-023).

    상태 없는 JWT 만으로는 로그아웃·비밀번호 변경·비활성화가 토큰을 무효화하지 못한다. 요청마다
    이 행을 확인해 revoked/만료/유휴 초과면 거부한다.
    """

    __tablename__ = "sessions"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    revoked_reason: Mapped[str | None] = mapped_column(String(40), nullable=True)
    ip: Mapped[str | None] = mapped_column(String(64), nullable=True)
    user_agent: Mapped[str | None] = mapped_column(String(200), nullable=True)


class GuestArrival(Base):
    """손님 계정이 만들어진 기록 — **계정이 지워져도 남는다.**

    시간당 상한을 ``users`` 행으로 세면, 계정을 지우는 순간 그 자리가 빈다. 손님 계정은 나가면
    지워지므로(account_sweep), 나갔다 들어오기를 반복하는 것만으로 상한이 사실상 없어졌다
    (2026-09-19 운영 데이터로 확인: 6개를 만들었는데 카운트는 5). 그래서 "몇 개를 만들었는가" 는
    계정이 아니라 이 원장에서 센다. 한 시간이 지난 행은 청소가 지운다.
    """

    __tablename__ = "guest_arrivals"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    #: 계정을 만든 주소. 개인을 특정하려는 것이 아니라 한 회선의 총량을 세기 위한 값이다.
    ip: Mapped[str] = mapped_column(String(64), index=True)
    #: guest | demo_admin — 상한이 역할마다 따로 있다.
    role: Mapped[str] = mapped_column(String(20), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)


class Scenario(Base):
    """시나리오 — 하나의 '가상 업무 상황' 전체.

    문제는 지문으로 직접 제시되지 않는다. 응시자는 데스크톱(메신저·IDE·에이전트·폴더)
    안에서 등장인물과 대화하며 요구사항을 스스로 파악하고 워크스페이스에 결과물을 만든다.

    characters: [{key, name, role, color, persona, knowledge}]
      - persona: 말투/성격/입장 (NPC 시스템 프롬프트에 주입)
      - knowledge: 이 인물이 알고 있는 사실 — 물어보면 답할 수 있는 범위의 전부
    opening_messages: [{character_key, content}] — 응시 시작 시 도착해 있는 메시지
    initial_files: [{path, content}] — 워크스페이스 초기 상태
    objectives_md: 숨은 진짜 요구사항(정답 정의). NPC 컨텍스트·자동평가에만 쓰이고
                   응시자에게 절대 노출되지 않는다.
    checks: [{label, type, path?, pattern?, command?, expected_stdout?, column?, row_match?,
              expected?, tolerance?, min_count?, max_count?, points}] — 결과물 자동 검증.
             type: file_exists | file_contains | file_not_contains | file_min_words |
                   file_max_words | csv_cell | csv_row_count | csv_column_sum |
                   csv_column_unique | command
    desktop_apps: 이 시나리오에서 제공할 앱 목록 (빈 목록 = 전부)
    rubric: {process_weight, result_weight, process: [{name, points, desc}], result: [...]}
    """

    __tablename__ = "scenarios"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    title: Mapped[str] = mapped_column(String(200))
    summary: Mapped[str] = mapped_column(Text, default="")  # 관리자용 한줄 설명 (응시자 비노출)
    difficulty: Mapped[str] = mapped_column(String(20), default="medium")  # easy | medium | hard
    briefing_md: Mapped[str] = mapped_column(Text, default="")  # 응시자에게 보이는 최소 안내
    characters: Mapped[list] = mapped_column(JSONB, default=list)
    office_public: Mapped[dict] = mapped_column(JSONB, default=dict)
    opening_messages: Mapped[list] = mapped_column(JSONB, default=list)
    initial_files: Mapped[list] = mapped_column(JSONB, default=list)
    objectives_md: Mapped[str] = mapped_column(Text, default="")
    # 이 시나리오의 NPC 기본 규칙(영문). 비어 있으면 전역 기본(npc_prompt.BASE_RULES)을 쓴다.
    npc_base_prompt: Mapped[str] = mapped_column(Text, default="")
    checks: Mapped[list] = mapped_column(JSONB, default=list)
    rubric: Mapped[dict] = mapped_column(JSONB, default=dict)
    agent_enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    #: 이 시나리오에서 명령 하나가 돌 수 있는 초. 0 이면 전역 기본(settings.run_timeout_s).
    #: 러너가 받아들이는 상한(worker.MAX_TIMEOUT_S)을 넘으면 러너가 자른다.
    run_timeout_s: Mapped[int] = mapped_column(Integer, default=0)
    # 이 시나리오에서 제공할 데스크톱 앱(desktop.OPTIONAL_APPS 의 부분집합).
    # 비어 있으면 전부 제공한다 — 기존 시나리오는 아무것도 바뀌지 않는다.
    desktop_apps: Mapped[list] = mapped_column(JSONB, default=list)
    is_archived: Mapped[bool] = mapped_column(Boolean, default=False)
    #: 코드 프리셋에서 마지막으로 받아 적은 내용의 지문(seed.spec_hash). 지금 내용의 지문과 같으면
    #: 관리자가 손대지 않은 것이고, 그런 시나리오만 코드가 바뀔 때 따라온다. NULL 이면 프리셋이 아니다.
    preset_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class Assessment(Base):
    __tablename__ = "assessments"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    title: Mapped[str] = mapped_column(String(200))
    description: Mapped[str] = mapped_column(Text, default="")
    #: 분야 — categories.ASSESSMENT_CATEGORIES 의 키. "" 는 미분류. 응시자 화면의 필터 축이다.
    category: Mapped[str] = mapped_column(String(40), default="")
    #: 같은 분야 안에서 이 시험을 가르는 꼬리표 — "초급", "갈등 중재", "쿠버네티스". 화면에는
    #: `분야 [꼬리표]` 로 붙는다. 시험은 시나리오 하나이므로(2026-09-20 부터) 분야 안에 여럿이 서고,
    #: 제목만으로는 무엇이 다른지 한눈에 읽히지 않는다.
    label: Mapped[str] = mapped_column(String(40), default="")
    #: 사무실 장면 참조 (office.py) — "" 자동 · "builtin:<id>" · 프리셋 uuid
    office_preset: Mapped[str] = mapped_column(String(60), default="")
    duration_min: Mapped[int] = mapped_column(Integer, default=120)
    agent_max_turns: Mapped[int] = mapped_column(Integer, default=30)  # 에이전트 질문 한도 (0=비활성)
    #: 이 시험에서 NPC 에게 보낼 수 있는 메시지 총량. 0 이면 전역 기본(settings.messenger_max_per_attempt).
    #: 대화가 곧 평가 대상이므로 "몇 번 더 물어볼 수 있는가" 는 응시 전략이고, 시험마다 달라야 한다.
    messenger_max_per_attempt: Mapped[int] = mapped_column(Integer, default=0)
    # NPC(등장인물)와 에이전트가 쓸 LLM 공급자 — 없으면 기본 채팅 공급자
    npc_provider_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("ai_providers.id", ondelete="SET NULL"), nullable=True
    )
    agent_provider_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("ai_providers.id", ondelete="SET NULL"), nullable=True
    )
    starts_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    ends_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    scenarios: Mapped[list["AssessmentScenario"]] = relationship(
        back_populates="assessment", cascade="all, delete-orphan", order_by="AssessmentScenario.ordinal"
    )
    assignments: Mapped[list["Assignment"]] = relationship(
        back_populates="assessment", cascade="all, delete-orphan"
    )


class AssessmentScenario(Base):
    __tablename__ = "assessment_scenarios"
    __table_args__ = (UniqueConstraint("assessment_id", "scenario_id"),)

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    assessment_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("assessments.id", ondelete="CASCADE"), index=True)
    scenario_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("scenarios.id", ondelete="CASCADE"))
    ordinal: Mapped[int] = mapped_column(Integer, default=0)
    points: Mapped[int] = mapped_column(Integer, default=100)

    assessment: Mapped[Assessment] = relationship(back_populates="scenarios")
    scenario: Mapped[Scenario] = relationship()


class Assignment(Base):
    __tablename__ = "assignments"
    __table_args__ = (UniqueConstraint("assessment_id", "user_id"),)

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    assessment_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("assessments.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    assessment: Mapped[Assessment] = relationship(back_populates="assignments")
    user: Mapped[User] = relationship()


class Attempt(Base):
    """응시 — 재응시 시 이전 시도는 삭제하지 않고 superseded로 표시해 기록을 보존한다."""

    __tablename__ = "attempts"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    assessment_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("assessments.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    status: Mapped[str] = mapped_column(String(20), default="in_progress")  # in_progress | submitted | expired
    superseded: Mapped[bool] = mapped_column(Boolean, default=False)
    # 다중 시나리오 시험은 순차 진행 — 현재 풀고 있는 시나리오의 ordinal
    current_ordinal: Mapped[int] = mapped_column(Integer, default=0)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    deadline_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # 종료 시점의 시나리오별 워크스페이스 요약(내용 해시·파일 수·대화/실행 수) — lifecycle.finalize_attempt
    snapshot: Mapped[dict | None] = mapped_column(JSONB, nullable=True)

    assessment: Mapped[Assessment] = relationship()
    user: Mapped[User] = relationship()


class MessengerMessage(Base):
    """메신저 대화 — 등장인물별 스레드. sender: candidate | npc."""

    __tablename__ = "messenger_messages"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    attempt_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("attempts.id", ondelete="CASCADE"), index=True)
    scenario_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("scenarios.id", ondelete="CASCADE"), index=True)
    character_key: Mapped[str] = mapped_column(String(50), index=True)
    sender: Mapped[str] = mapped_column(String(20))  # candidate | npc
    content: Mapped[str] = mapped_column(Text)
    model: Mapped[str | None] = mapped_column(String(100), nullable=True)
    meta: Mapped[dict] = mapped_column(JSONB, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)


    @property
    def social(self) -> str:
        return str((self.meta or {}).get("office_social") or "")


class AgentMessage(Base):
    """응시자 전용 AI 에이전트 대화 — meta.steps 에 도구 호출 기록."""

    __tablename__ = "agent_messages"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    attempt_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("attempts.id", ondelete="CASCADE"), index=True)
    scenario_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("scenarios.id", ondelete="CASCADE"), index=True)
    role: Mapped[str] = mapped_column(String(20))  # user | assistant
    content: Mapped[str] = mapped_column(Text)
    model: Mapped[str | None] = mapped_column(String(100), nullable=True)
    meta: Mapped[dict] = mapped_column(JSONB, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)


class WorkspaceFile(Base):
    """응시별 워크스페이스 파일 — IDE·에이전트·러너가 공유하는 단일 진실."""

    __tablename__ = "workspace_files"
    __table_args__ = (UniqueConstraint("attempt_id", "scenario_id", "path"),)

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    attempt_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("attempts.id", ondelete="CASCADE"), index=True)
    scenario_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("scenarios.id", ondelete="CASCADE"), index=True)
    path: Mapped[str] = mapped_column(String(500))
    content: Mapped[str] = mapped_column(Text, default="")
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class Execution(Base):
    """워크스페이스 명령 실행 — 러너가 파일을 물질화해 실행하고 변경분을 되돌려 쓴다."""

    __tablename__ = "executions"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    attempt_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("attempts.id", ondelete="CASCADE"), index=True)
    scenario_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("scenarios.id", ondelete="CASCADE"))
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    source: Mapped[str] = mapped_column(String(10), default="ide")  # ide | agent | check
    command: Mapped[str] = mapped_column(Text)
    # 실행 요청 당시 workspace payload. Redis 전달 장애/재시작에도 정확히 같은 입력을 재생한다.
    # 명령 요청 시점의 워크스페이스 전체(재전송용). 실행이 끝나면 비운다 — 산출물은 changed_files 와
    # 워크스페이스에 남는다. 터미널 폴링(GET) 은 이 큰 컬럼을 defer 로 빼고 읽는다 (routers/executions.py).
    input_files: Mapped[list | None] = mapped_column(JSONB, nullable=True)
    status: Mapped[str] = mapped_column(String(20), default="queued")  # queued | running | done | error
    exit_code: Mapped[int | None] = mapped_column(Integer, nullable=True)
    stdout: Mapped[str | None] = mapped_column(Text, nullable=True)
    stderr: Mapped[str | None] = mapped_column(Text, nullable=True)
    time_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    changed_files: Mapped[list | None] = mapped_column(JSONB, nullable=True)  # [{path, action}]
    # 러너가 결과를 보고할 때 제시해야 하는 일회용 토큰 — 큐에 실려 러너에게만 전달되고,
    # 결과가 접수되면 지워진다. API 응답(ExecutionOut)에는 나가지 않는다.
    callback_token: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class Event(Base):
    """응시 중 발생한 모든 행동의 append-only 로그."""

    __tablename__ = "events"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    attempt_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("attempts.id", ondelete="CASCADE"), index=True)
    scenario_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True)
    type: Mapped[str] = mapped_column(String(50), index=True)
    payload: Mapped[dict] = mapped_column(JSONB, default=dict)
    # 누가 관측했는가 (ODY-017): server = 서버가 직접 본 사실, client_untrusted = 브라우저가 보고한 값
    source: Mapped[str] = mapped_column(String(20), default="server")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)


class AiProvider(Base):
    """LLM 공급자 프로파일 — geny-executor llm_client 백엔드 하나에 대응."""

    __tablename__ = "ai_providers"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(100))
    provider: Mapped[str] = mapped_column(String(30))
    base_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    api_key: Mapped[str] = mapped_column(Text, default="")
    model: Mapped[str] = mapped_column(String(200))
    temperature: Mapped[float] = mapped_column(Float, default=0.2)
    max_tokens: Mapped[int] = mapped_column(Integer, default=4096)
    default_headers: Mapped[dict] = mapped_column(JSONB, default=dict)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    is_chat_default: Mapped[bool] = mapped_column(Boolean, default=False)
    is_eval_default: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class OfficePreset(Base):
    """관리자가 만든 사무실 장면(방 설계도). spec 은 웹 scenes.ts 의 SceneSpec 과 같은 모양의 JSON."""

    __tablename__ = "office_presets"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(80))
    spec: Mapped[dict] = mapped_column(JSONB, default=dict)
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class OfficeBuiltinOverride(Base):
    """관리자가 고친 템플릿(코드에 있는 기본 장면, office.BUILTIN_SCENES). 행이 없으면 코드의 기본값을 쓴다.

    코드(웹 scenes.ts)는 배포할 때마다 새로 깔리지만 이 표는 DB 에 남는다 — 재배포해도 관리자가 고친 모양이 유지된다.
    [기본값으로 되돌리기]는 행을 지운다(그 배포의 코드 기본값으로 돌아간다). 표는 기동 때 create_all 이 만든다.
    """

    __tablename__ = "office_builtin_overrides"

    builtin_id: Mapped[str] = mapped_column(String(40), primary_key=True)
    name: Mapped[str] = mapped_column(String(80))
    spec: Mapped[dict] = mapped_column(JSONB, default=dict)
    updated_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class AppSetting(Base):
    __tablename__ = "app_settings"

    key: Mapped[str] = mapped_column(String(50), primary_key=True)
    value: Mapped[dict] = mapped_column(JSONB, default=dict)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class Evaluation(Base):
    __tablename__ = "evaluations"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    attempt_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("attempts.id", ondelete="CASCADE"), index=True)
    kind: Mapped[str] = mapped_column(String(10))  # auto | human
    evaluator_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    scores: Mapped[dict] = mapped_column(JSONB, default=dict)
    summary: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    evaluator: Mapped[User | None] = relationship()


# main 을 거치지 않고 models 만 임포트하는 스크립트도 암호화 타입을 본다 (평문 기록·암호문 노출 방지).
from .secrets import install_encrypted_types as _install_encrypted_types  # noqa: E402

_install_encrypted_types()


class OfficeWorld(Base):
    """One private room history per user, assessment and immutable public revision."""
    __tablename__ = "office_worlds"
    __table_args__ = (UniqueConstraint("user_id", "assessment_id", "revision"),)
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    assessment_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("assessments.id", ondelete="CASCADE"), index=True)
    revision: Mapped[str] = mapped_column(String(64))
    projection: Mapped[dict] = mapped_column(JSONB)
    sequence: Mapped[int] = mapped_column(BigInteger, default=0)
    relations: Mapped[dict] = mapped_column(JSONB, default=dict)
    presence: Mapped[dict] = mapped_column(JSONB, default=dict)
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    next_ambient_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class OfficeConversation(Base):
    __tablename__ = "office_conversations"
    __table_args__ = (UniqueConstraint("world_id", "actor_id"),)
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    world_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("office_worlds.id", ondelete="CASCADE"), index=True)
    actor_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    mode: Mapped[str] = mapped_column(String(20))  # user | ambient
    participants: Mapped[list] = mapped_column(JSONB, default=list)
    status: Mapped[str] = mapped_column(String(20), default="idle")
    topic_id: Mapped[str] = mapped_column(String(120), default="")
    state: Mapped[dict] = mapped_column(JSONB, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class OfficeEvent(Base):
    __tablename__ = "office_events"
    __table_args__ = (UniqueConstraint("world_id", "sequence"),)
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    world_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("office_worlds.id", ondelete="CASCADE"), index=True)
    conversation_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("office_conversations.id", ondelete="CASCADE"), nullable=True, index=True)
    sequence: Mapped[int] = mapped_column(BigInteger)
    kind: Mapped[str] = mapped_column(String(30))
    speaker_id: Mapped[str] = mapped_column(String(36), default="")
    content: Mapped[str] = mapped_column(Text, default="")
    meta: Mapped[dict] = mapped_column(JSONB, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class OfficeJob(Base):
    """Durable outbox and fenced execution. No provider call holds a DB transaction."""
    __tablename__ = "office_jobs"
    __table_args__ = (UniqueConstraint("world_id", "request_id"),)
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    world_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("office_worlds.id", ondelete="CASCADE"), index=True)
    conversation_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("office_conversations.id", ondelete="CASCADE"), index=True)
    request_id: Mapped[uuid.UUID] = mapped_column(Uuid)
    kind: Mapped[str] = mapped_column(String(20))
    status: Mapped[str] = mapped_column(String(20), default="queued", index=True)
    priority: Mapped[int] = mapped_column(Integer, default=0)
    budget_tokens: Mapped[int] = mapped_column(Integer, default=0)
    generation: Mapped[int] = mapped_column(Integer, default=0)
    payload: Mapped[dict] = mapped_column(JSONB, default=dict)
    result: Mapped[dict] = mapped_column(JSONB, default=dict)
    error: Mapped[str] = mapped_column(String(120), default="")
    lease_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    deadline_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class OfficeDialogueCache(Base):
    """NPC 끼리의 잡담 대본 캐시 — 발화자 → 수신자, 주제, 두 인물의 공개 페르소나 지문으로 찾는다(npc/cache.py).
    세계(world)에 붙지 않는다: 같은 시험의 다른 응시자 사무실에서 되풀이하는 것이 목적이다."""
    __tablename__ = "office_dialogue_cache"
    __table_args__ = (Index("ix_office_dialogue_cache_key", "speaker_id", "listener_id", "topic_id", "public_hash"),)
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    speaker_id: Mapped[str] = mapped_column(String(36))
    listener_id: Mapped[str] = mapped_column(String(36))
    topic_id: Mapped[str] = mapped_column(String(120), default="")
    public_hash: Mapped[str] = mapped_column(String(64))
    turns: Mapped[list] = mapped_column(JSONB)
    replays: Mapped[int] = mapped_column(Integer, default=0)
    source_job_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True)
    #: 어느 세계에서 만든 대본인가 — 그 세계(같은 사용자·시험)에서는 되풀이하지 않는다
    source_world_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)


class OfficeMemory(Base):
    """Derived, source-linked episodic memory. Raw events remain the source of truth."""
    __tablename__ = "office_memories"
    __table_args__ = (UniqueConstraint("conversation_id", "through_sequence"),)
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    world_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("office_worlds.id", ondelete="CASCADE"), index=True)
    conversation_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("office_conversations.id", ondelete="CASCADE"), index=True)
    participants: Mapped[list] = mapped_column(JSONB)
    scope: Mapped[str] = mapped_column(String(20))
    summary: Mapped[str] = mapped_column(Text)
    source_ids: Mapped[list] = mapped_column(JSONB)
    through_sequence: Mapped[int] = mapped_column(BigInteger)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

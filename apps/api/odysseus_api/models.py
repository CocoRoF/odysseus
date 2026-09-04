import uuid
from datetime import datetime, timezone

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    Float,
    ForeignKey,
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
    role: Mapped[str] = mapped_column(String(20), default="candidate")  # admin | evaluator | candidate
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


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
    checks: [{label, type: file_exists|file_contains|command, path?, pattern?, command?,
              expected_stdout?, points}] — 결과물 자동 검증
    rubric: {process_weight, result_weight, process: [{name, points, desc}], result: [...]}
    """

    __tablename__ = "scenarios"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    title: Mapped[str] = mapped_column(String(200))
    summary: Mapped[str] = mapped_column(Text, default="")  # 관리자용 한줄 설명 (응시자 비노출)
    difficulty: Mapped[str] = mapped_column(String(20), default="medium")  # easy | medium | hard
    briefing_md: Mapped[str] = mapped_column(Text, default="")  # 응시자에게 보이는 최소 안내
    characters: Mapped[list] = mapped_column(JSONB, default=list)
    opening_messages: Mapped[list] = mapped_column(JSONB, default=list)
    initial_files: Mapped[list] = mapped_column(JSONB, default=list)
    objectives_md: Mapped[str] = mapped_column(Text, default="")
    checks: Mapped[list] = mapped_column(JSONB, default=list)
    rubric: Mapped[dict] = mapped_column(JSONB, default=dict)
    agent_enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    is_archived: Mapped[bool] = mapped_column(Boolean, default=False)
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class Assessment(Base):
    __tablename__ = "assessments"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    title: Mapped[str] = mapped_column(String(200))
    description: Mapped[str] = mapped_column(Text, default="")
    duration_min: Mapped[int] = mapped_column(Integer, default=120)
    agent_max_turns: Mapped[int] = mapped_column(Integer, default=30)  # 에이전트 질문 한도 (0=비활성)
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

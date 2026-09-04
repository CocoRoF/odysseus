"""시나리오 CRUD — 관리자 스튜디오의 저장 대상."""

import uuid

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..ai.autoeval import default_rubric
from ..ai.errors import describe_error
from ..db import get_db
from ..deps import require_admin, require_staff
from ..models import AssessmentScenario, Scenario, User
from ..schemas import ScenarioIn, ScenarioOut, ScenarioSummary
from pydantic import BaseModel, Field


class AuthorChatIn(BaseModel):
    """대화형 편집 — 이전 턴 전체와 현재 초안을 보낸다."""

    messages: list[dict] = Field(min_length=1, max_length=60)
    draft: ScenarioIn | None = None
    provider_id: uuid.UUID | None = None


class AuthorIn(BaseModel):
    """AI 작성 요청 — brief 로 새로 만들거나, draft + instruction 으로 다듬는다."""

    brief: str = Field(default="", max_length=6000)
    draft: ScenarioIn | None = None
    instruction: str | None = Field(default=None, max_length=4000)
    provider_id: uuid.UUID | None = None

router = APIRouter(prefix="/scenarios", tags=["scenarios"])


def _validate(body: ScenarioIn) -> None:
    keys = [c.key for c in body.characters]
    if len(keys) != len(set(keys)):
        raise HTTPException(400, "등장인물 key가 중복됩니다")
    key_set = set(keys)
    for om in body.opening_messages:
        if om.character_key not in key_set:
            raise HTTPException(400, f"오프닝 메시지의 등장인물이 없습니다: {om.character_key}")
    paths = [f.path for f in body.initial_files]
    if len(paths) != len(set(paths)):
        raise HTTPException(400, "초기 파일 경로가 중복됩니다")
    for c in body.checks:
        if c.type in ("file_exists", "file_contains") and not (c.path or "").strip():
            raise HTTPException(400, f"체크 '{c.label}': path가 필요합니다")
        if c.type == "file_contains" and not (c.pattern or "").strip():
            raise HTTPException(400, f"체크 '{c.label}': pattern이 필요합니다")
        if c.type == "command" and not (c.command or "").strip():
            raise HTTPException(400, f"체크 '{c.label}': command가 필요합니다")


def _apply(row: Scenario, body: ScenarioIn) -> None:
    row.title = body.title
    row.summary = body.summary
    row.difficulty = body.difficulty
    row.briefing_md = body.briefing_md
    row.characters = [c.model_dump() for c in body.characters]
    row.opening_messages = [m.model_dump() for m in body.opening_messages]
    row.initial_files = [f.model_dump() for f in body.initial_files]
    row.objectives_md = body.objectives_md
    row.npc_base_prompt = body.npc_base_prompt.strip()
    row.checks = [c.model_dump() for c in body.checks]
    row.rubric = body.rubric or default_rubric()
    row.agent_enabled = body.agent_enabled


@router.get("", response_model=list[ScenarioSummary])
async def list_scenarios(db: AsyncSession = Depends(get_db), _=Depends(require_staff)):
    rows = (
        await db.execute(select(Scenario).order_by(Scenario.updated_at.desc()))
    ).scalars().all()
    return [
        ScenarioSummary(
            id=r.id,
            title=r.title,
            summary=r.summary,
            difficulty=r.difficulty,
            character_count=len(r.characters or []),
            check_count=len(r.checks or []),
            agent_enabled=r.agent_enabled,
            is_archived=r.is_archived,
            updated_at=r.updated_at,
        )
        for r in rows
    ]


@router.post("/author")
async def author_with_ai(
    body: AuthorIn, db: AsyncSession = Depends(get_db), _=Depends(require_admin)
):
    """시나리오 전체를 AI 가 설계한다. 저장은 하지 않는다 — 스튜디오에 채워 주고 사람이 확인한다."""
    from ..ai import provider as ai_provider
    from ..ai.scenario_author import author_scenario

    if not body.brief.strip() and body.draft is None:
        raise HTTPException(400, "어떤 시나리오를 만들지 한 줄이라도 적어 주세요")
    res = await ai_provider.resolve_ai(db, "chat", override_provider_id=body.provider_id)
    if not res:
        raise HTTPException(503, "LLM 공급자가 설정되어 있지 않습니다 — [설정]에서 먼저 등록하세요")
    try:
        scenario, notes, warnings = await author_scenario(
            res,
            brief=body.brief,
            draft=body.draft.model_dump() if body.draft else None,
            instruction=body.instruction,
        )
    except ValueError as e:
        info = describe_error(e, where="author")
        raise HTTPException(502, f"{info['message']} (참조: {info['correlation_id']})")
    except Exception as e:  # noqa: BLE001 — 공급자 오류를 그대로 보여 준다
        info = describe_error(e, where="author")
        raise HTTPException(502, f"{info['message']} (참조: {info['correlation_id']})")
    return {"scenario": scenario, "notes": notes, "warnings": warnings, "provider": res.name}


@router.post("/author/stream")
async def author_chat(body: AuthorChatIn, db: AsyncSession = Depends(get_db), _=Depends(require_admin)):
    """여러 턴에 걸쳐 시나리오를 설계·고도화한다. 편집 명령을 검증해 실시간으로 흘려보낸다."""
    import json as _json

    from ..ai import provider as ai_provider
    from ..ai.scenario_author import author_chat_stream

    res = await ai_provider.resolve_ai(db, "chat", override_provider_id=body.provider_id)
    if not res:
        raise HTTPException(503, "LLM 공급자가 설정되어 있지 않습니다 — [설정]에서 먼저 등록하세요")
    draft = body.draft.model_dump() if body.draft else None

    async def gen():
        try:
            async for event in author_chat_stream(res, history=body.messages, draft=draft):
                yield f"data: {_json.dumps(event, ensure_ascii=False)}\n\n"
        except ValueError as e:
            info = describe_error(e, where="author-stream")
            yield f"data: {_json.dumps({'error': info['message'], 'code': info['code'], 'correlation_id': info['correlation_id']}, ensure_ascii=False)}\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@router.get("/rubric-default")
async def rubric_default(_=Depends(require_staff)):
    return default_rubric()


@router.get("/npc-default-prompt")
async def npc_default_prompt(_=Depends(require_staff)):
    """전역 NPC 기본 규칙 — 시나리오가 비워 두면 이것이 쓰인다. 편집기의 '기본값 불러오기' 가 읽는다."""
    from ..ai.npc_prompt import BASE_RULES

    return {"prompt": BASE_RULES}


@router.post("", response_model=ScenarioOut)
async def create_scenario(
    body: ScenarioIn, db: AsyncSession = Depends(get_db), user: User = Depends(require_admin)
):
    _validate(body)
    row = Scenario(created_by=user.id)
    _apply(row, body)
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row


@router.get("/{scenario_id}", response_model=ScenarioOut)
async def get_scenario(scenario_id: uuid.UUID, db: AsyncSession = Depends(get_db), _=Depends(require_staff)):
    row = await db.get(Scenario, scenario_id)
    if not row:
        raise HTTPException(404, "시나리오를 찾을 수 없습니다")
    return row


@router.put("/{scenario_id}", response_model=ScenarioOut)
async def update_scenario(
    scenario_id: uuid.UUID, body: ScenarioIn, db: AsyncSession = Depends(get_db), _=Depends(require_admin)
):
    row = await db.get(Scenario, scenario_id)
    if not row:
        raise HTTPException(404, "시나리오를 찾을 수 없습니다")
    _validate(body)
    _apply(row, body)
    await db.commit()
    await db.refresh(row)
    return row


@router.delete("/{scenario_id}")
async def delete_scenario(
    scenario_id: uuid.UUID, db: AsyncSession = Depends(get_db), _=Depends(require_admin)
):
    row = await db.get(Scenario, scenario_id)
    if not row:
        raise HTTPException(404, "시나리오를 찾을 수 없습니다")
    used = (
        await db.execute(
            select(func.count(AssessmentScenario.id)).where(AssessmentScenario.scenario_id == scenario_id)
        )
    ).scalar() or 0
    if used:
        # 시험에 연결된 시나리오는 기록 보존을 위해 삭제 대신 보관 처리
        row.is_archived = True
        await db.commit()
        return {"ok": True, "archived": True}
    await db.delete(row)
    await db.commit()
    return {"ok": True, "archived": False}

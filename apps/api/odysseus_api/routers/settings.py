import asyncio
import time
import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..ai import provider as ai
from ..ai.claude_login import ClaudeLoginError, manager as claude_login
from ..config import settings as env
from ..ai.errors import redact
from ..ai_incidents import recent_failures
from ..db import get_db
from ..demo import is_demo_admin
from ..deps import get_current_user, require_admin
from ..models import AiProvider, AppSetting
from ..schemas import AiDefaultsIn, AiProviderIn, AiProviderOut, AiTestIn

router = APIRouter(prefix="/admin/settings", tags=["settings"], dependencies=[Depends(require_admin)])

#: [연결 테스트] 가 기다리는 최대 시간. 실제 대화용 타임아웃(CLI 는 300초)과 분리한다 —
#: 설정이 맞는지 보려고 누르는 버튼이 5분을 매달려 있으면 그것 자체가 진단을 막는다.
TEST_TIMEOUT_S = 45


def _key_hint(key: str) -> str | None:
    if not key:
        return None
    return f"…{key[-4:]}" if len(key) >= 8 else "설정됨"


def _out(row: AiProvider, viewer=None) -> AiProviderOut:
    return AiProviderOut(
        id=row.id,
        name=row.name,
        provider=row.provider,
        base_url=row.base_url,
        model=row.model,
        temperature=row.temperature,
        max_tokens=row.max_tokens,
        enabled=row.enabled,
        is_chat_default=row.is_chat_default,
        is_eval_default=row.is_eval_default,
        has_key=bool(row.api_key),
        # 둘러보기 계정에게는 힌트도 주지 않는다 — 끝 네 글자도 열쇠의 일부다 (demo.py)
        key_hint=("설정됨" if row.api_key else None) if is_demo_admin(viewer) else _key_hint(row.api_key),
        supports_host_tools=ai.provider_supports_host_tools(row.provider),
        created_at=row.created_at,
    )


async def _all_rows(db: AsyncSession) -> list[AiProvider]:
    return list(
        (await db.execute(select(AiProvider).order_by(AiProvider.created_at))).scalars().all()
    )


def _validate(body: AiProviderIn, existing_key: str = "") -> None:
    entry = ai.catalog_entry(body.provider)
    if not entry:
        raise HTTPException(400, f"지원하지 않는 공급자 유형입니다: {body.provider}")
    effective_key = body.api_key if body.api_key is not None else existing_key
    if entry["needs_base_url"] and not (body.base_url or "").strip():
        raise HTTPException(400, f"{entry['label']}은(는) Base URL이 필수입니다")
    if entry["needs_key"] and not effective_key:
        raise HTTPException(400, f"{entry['label']}은(는) API 키가 필수입니다")


@router.get("/ai/health")
async def ai_health(minutes: int = 15, db: AsyncSession = Depends(get_db)):
    """최근 AI 실패 현황 — 공급자가 소진·차단됐음을 관리자가 **먼저** 알기 위한 것.

    지금까지 이것을 아는 경로는 응시자의 항의뿐이었고, 항의하지 않는 응시자는 조용히
    손해를 봤다. 여기서는 조치를 자동으로 하지 않는다 — 진행 중인 응시가 공급자를 명시적으로
    지정하고 있으면 그것을 끄는 순간 그 응시들이 전부 503 으로 멈추기 때문이다(resolve_attempt_ai).
    사람이 보고 판단하도록 사실만 보여 준다.
    """
    return await recent_failures(db, minutes=max(1, min(int(minutes), 720)))


@router.get("/ai/meta")
async def ai_meta(db: AsyncSession = Depends(get_db)):
    """설정 패널 메타 — 공급자 카탈로그 + 현재 유효 채팅/평가 해석 결과."""
    chat = await ai.resolve_ai(db, "chat")
    eval_ = await ai.resolve_ai(db, "eval")

    def brief(res: ai.ResolvedAi | None) -> dict | None:
        if res is None:
            return None
        return {
            "configured": res.configured,
            "provider": res.provider,
            "model": res.model,
            "name": res.name,
            "source": res.source,
        }

    return {
        "catalog": ai.PROVIDER_CATALOG,
        "effective_chat": brief(chat),
        "effective_eval": brief(eval_),
        "env_fallback_available": bool(env.ai_api_key),
    }


@router.get("/ai/providers", response_model=list[AiProviderOut])
async def list_providers(db: AsyncSession = Depends(get_db), viewer=Depends(get_current_user)):
    return [_out(r, viewer) for r in await _all_rows(db)]


@router.post("/ai/providers", response_model=AiProviderOut)
async def create_provider(body: AiProviderIn, db: AsyncSession = Depends(get_db)):
    _validate(body)
    rows = await _all_rows(db)
    row = AiProvider(
        name=body.name,
        provider=body.provider,
        base_url=(body.base_url or "").strip() or None,
        api_key=(body.api_key or "").strip(),
        model=body.model.strip(),
        temperature=body.temperature,
        max_tokens=body.max_tokens,
        enabled=body.enabled,
        # 첫 공급자는 자동으로 채팅/평가 기본
        is_chat_default=not rows,
        is_eval_default=not rows,
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return _out(row)


@router.put("/ai/providers/{provider_id}", response_model=AiProviderOut)
async def update_provider(provider_id: uuid.UUID, body: AiProviderIn, db: AsyncSession = Depends(get_db)):
    row = await db.get(AiProvider, provider_id)
    if not row:
        raise HTTPException(404, "공급자를 찾을 수 없습니다")
    _validate(body, existing_key=row.api_key)
    row.name = body.name
    row.provider = body.provider
    row.base_url = (body.base_url or "").strip() or None
    if body.api_key is not None:  # None=유지, ""=삭제
        row.api_key = body.api_key.strip()
    row.model = body.model.strip()
    row.temperature = body.temperature
    row.max_tokens = body.max_tokens
    row.enabled = body.enabled
    await db.commit()
    await db.refresh(row)
    return _out(row)


@router.delete("/ai/providers/{provider_id}")
async def delete_provider(provider_id: uuid.UUID, db: AsyncSession = Depends(get_db)):
    row = await db.get(AiProvider, provider_id)
    if not row:
        raise HTTPException(404, "공급자를 찾을 수 없습니다")
    await db.delete(row)
    await db.commit()
    return {"ok": True}


@router.put("/ai/defaults", response_model=list[AiProviderOut])
async def set_defaults(body: AiDefaultsIn, db: AsyncSession = Depends(get_db)):
    rows = await _all_rows(db)
    ids = {r.id for r in rows}
    if body.chat_provider_id and body.chat_provider_id not in ids:
        raise HTTPException(400, "존재하지 않는 채팅 공급자입니다")
    if body.eval_provider_id and body.eval_provider_id not in ids:
        raise HTTPException(400, "존재하지 않는 평가 공급자입니다")
    for r in rows:
        if body.chat_provider_id is not None:
            r.is_chat_default = r.id == body.chat_provider_id
        if body.eval_provider_id is not None:
            r.is_eval_default = r.id == body.eval_provider_id
    await db.commit()
    return [_out(r) for r in await _all_rows(db)]


async def _resolved_for_test(body: AiTestIn, db: AsyncSession) -> ai.ResolvedAi:
    base = None
    if body.provider_id:
        row = await db.get(AiProvider, body.provider_id)
        if not row:
            raise HTTPException(404, "공급자를 찾을 수 없습니다")
        base = ai.resolved_from_row(row)
    if base is None:
        if not body.provider:
            raise HTTPException(400, "provider 또는 provider_id가 필요합니다")
        base = ai.ResolvedAi(provider=body.provider, model=body.model or "", name="(임시)")
    if body.provider:
        base.provider = body.provider
    if body.base_url is not None:
        base.base_url = body.base_url.strip() or None
    if body.api_key:
        base.api_key = body.api_key.strip()
    if body.model:
        base.model = body.model.strip()
    return base


@router.post("/ai/test")
async def test_provider(body: AiTestIn, db: AsyncSession = Depends(get_db)):
    """라이브 연결 테스트 — 저장 전 입력값으로도, 저장된 공급자로도 실행 가능."""
    res = await _resolved_for_test(body, db)
    if not res.model:
        return {"ok": False, "error": "모델을 입력하세요"}
    if not res.configured:
        return {"ok": False, "error": "필수 설정(API 키 또는 Base URL)이 비어 있습니다"}
    started = time.monotonic()
    try:
        # 공급자 자체의 타임아웃은 실제 대화용이라 길다 (Claude Code CLI 는 300초). 그 값을 그대로
        # 쓰면 **진단하려고 누른 버튼이 5분을 잡아먹는다** — 화면은 "테스트 중…" 에서 멈춘 것처럼
        # 보이고, 관리자는 설정이 틀렸는지 서버가 죽었는지 알 수 없다. 여기서만 짧게 끊는다.
        reply = await asyncio.wait_for(
            ai.complete_text(
                res,
                [{"role": "user", "content": "연결 확인입니다. '정상'이라고만 답하세요."}],
                max_tokens=512,
            ),
            timeout=TEST_TIMEOUT_S,
        )
    except asyncio.TimeoutError:
        return {
            "ok": False,
            "error": f"{TEST_TIMEOUT_S}초 안에 응답이 없습니다. Base URL 과 네트워크를 확인하세요 "
            "(Claude Code CLI 는 Base URL 이 비어 있어야 합니다 — 게이트웨이를 쓸 때만 채웁니다).",
        }
    except Exception as e:  # noqa: BLE001 — 실패 사유를 그대로 관리자에게 보여준다
        return {"ok": False, "error": redact(str(e))[:600]}  # 관리자 화면 — 키·토큰·쿼리는 가린다
    if not (reply or "").strip():
        return {"ok": False, "error": "모델에서 텍스트 응답을 받지 못했습니다. 응답 토큰 설정을 확인하세요."}
    return {
        "ok": True,
        "latency_ms": int((time.monotonic() - started) * 1000),
        "provider": res.provider,
        "model": res.model,
        "reply": (reply or "").strip()[:200],
    }


@router.post("/ai/models")
async def discover(body: AiTestIn, db: AsyncSession = Depends(get_db)):
    """공급자가 실제 서빙 중인 모델 목록 (라이브 디스커버리, 실패 시 unavailable)."""
    res = await _resolved_for_test(body, db)
    return await ai.list_models(res)


# ── Claude 계정 로그인 (setup-token 중계) ────────────────────────
#
# 관리자 전용. `claude setup-token`을 서버 PTY에서 구동해 OAuth URL을 넘겨주고,
# 관리자가 브라우저 로그인 후 받은 코드를 되받아 장수 토큰(sk-ant-oat…)을 얻는다.
# 얻은 토큰은 공급자의 API 키 자리에 저장되며, 이후 실행은 기존 setup_token
# 채널(CLAUDE_CODE_OAUTH_TOKEN)로 흐른다.


# ── 응시 환경(UI) 설정 ───────────────────────────────────────────
#
# 플랫폼 전역 설정. 지금은 시네마틱 인트로(게이미피케이션) 하나뿐이며 기본은 꺼짐.

UI_SETTING_KEY = "ui"
UI_DEFAULTS: dict = {"gamified_intro": False}


class UiSettingsIn(BaseModel):
    gamified_intro: bool = False


async def get_ui_settings(db: AsyncSession) -> dict:
    row = await db.get(AppSetting, UI_SETTING_KEY)
    return {**UI_DEFAULTS, **(row.value if row else {})}


@router.get("/ui")
async def read_ui_settings(db: AsyncSession = Depends(get_db)):
    return await get_ui_settings(db)


@router.put("/ui")
async def write_ui_settings(body: UiSettingsIn, db: AsyncSession = Depends(get_db)):
    row = await db.get(AppSetting, UI_SETTING_KEY)
    if row:
        row.value = body.model_dump()
    else:
        db.add(AppSetting(key=UI_SETTING_KEY, value=body.model_dump()))
    await db.commit()
    return await get_ui_settings(db)


# ── 참고 자료(GitHub) 설정 ──────────────────────────────────────


class ReferenceSettingsIn(BaseModel):
    github_enabled: bool = True
    github_token: str | None = None  # None=기존 유지, ""=삭제


def _key_hint_of(value: str) -> str | None:
    if not value:
        return None
    return f"…{value[-4:]}" if len(value) >= 8 else "설정됨"


@router.get("/reference")
async def read_reference_settings(db: AsyncSession = Depends(get_db), viewer=Depends(get_current_user)):
    from .reference import get_reference_settings

    s = await get_reference_settings(db)
    return {
        "github_enabled": s["github_enabled"],
        "has_github_token": bool(s["github_token"]),
        "github_token_hint": ("설정됨" if s["github_token"] else None)
        if is_demo_admin(viewer)
        else _key_hint_of(s["github_token"]),
    }


@router.put("/reference")
async def write_reference_settings(body: ReferenceSettingsIn, db: AsyncSession = Depends(get_db)):
    from .reference import REFERENCE_KEY, get_reference_settings

    current = await get_reference_settings(db)
    # 통째로 다시 적는다 — [인터넷] 을 걷어내며 남은 옛 키(web_enabled·search_*)도 여기서 사라진다.
    value = {
        "github_enabled": body.github_enabled,
        # None 이면 기존 비밀값 유지 (화면에 되돌려주지 않으므로)
        "github_token": current["github_token"] if body.github_token is None else body.github_token.strip(),
    }
    row = await db.get(AppSetting, REFERENCE_KEY)
    if row:
        row.value = value
    else:
        db.add(AppSetting(key=REFERENCE_KEY, value=value))
    await db.commit()
    return await read_reference_settings(db)


class ClaudeLoginCodeIn(BaseModel):
    code: str = Field(min_length=4, max_length=4000)


def _login_error(e: ClaudeLoginError) -> HTTPException:
    return HTTPException(e.code, e.message)


@router.post("/ai/claude-login")
async def claude_login_start():
    try:
        return await asyncio.to_thread(claude_login.start)
    except ClaudeLoginError as e:
        raise _login_error(e)


@router.get("/ai/claude-login/{session_id}")
async def claude_login_status(session_id: str):
    try:
        return await asyncio.to_thread(claude_login.status, session_id)
    except ClaudeLoginError as e:
        raise _login_error(e)


@router.post("/ai/claude-login/{session_id}/code")
async def claude_login_code(session_id: str, body: ClaudeLoginCodeIn):
    try:
        return await asyncio.to_thread(claude_login.submit_code, session_id, body.code)
    except ClaudeLoginError as e:
        raise _login_error(e)


@router.delete("/ai/claude-login/{session_id}")
async def claude_login_cancel(session_id: str):
    await asyncio.to_thread(claude_login.cancel, session_id)
    return {"ok": True}


# ── 레거시(v0.2 단일 설정) 마이그레이션 — 앱 기동 시 1회 호출 ──────


async def migrate_legacy_ai_settings(db: AsyncSession) -> None:
    rows = await _all_rows(db)
    if rows:
        return
    legacy = await db.get(AppSetting, "ai")
    if not legacy:
        return
    v = dict(legacy.value or {})
    if not v.get("api_key") or v.get("migrated"):
        return
    base_url = (v.get("base_url") or "").rstrip("/")
    provider = "openai" if (not base_url or "api.openai.com" in base_url) else "custom"
    db.add(
        AiProvider(
            name="기존 설정 (자동 이전)",
            provider=provider,
            base_url=base_url or None,
            api_key=v["api_key"],
            model=v.get("chat_model") or env.ai_chat_model,
            is_chat_default=True,
            is_eval_default=True,
        )
    )
    legacy.value = {**v, "migrated": True}
    await db.commit()
    print("[settings] legacy ai settings migrated to ai_providers")

import time
import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..ai import provider as ai
from ..config import settings as env
from ..db import get_db
from ..deps import require_admin
from ..models import AiProvider, AppSetting
from ..schemas import AiDefaultsIn, AiProviderIn, AiProviderOut, AiTestIn

router = APIRouter(prefix="/admin/settings", tags=["settings"], dependencies=[Depends(require_admin)])


def _key_hint(key: str) -> str | None:
    if not key:
        return None
    return f"…{key[-4:]}" if len(key) >= 8 else "설정됨"


def _out(row: AiProvider) -> AiProviderOut:
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
        key_hint=_key_hint(row.api_key),
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
async def list_providers(db: AsyncSession = Depends(get_db)):
    return [_out(r) for r in await _all_rows(db)]


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
        reply = await ai.complete_text(
            res,
            [{"role": "user", "content": "연결 확인입니다. '정상'이라고만 답하세요."}],
            max_tokens=512,
        )
    except Exception as e:  # noqa: BLE001 — 실패 사유를 그대로 관리자에게 보여준다
        return {"ok": False, "error": str(e)[:600]}
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

"""관리자 — 사무실 장면(프리셋) CRUD 와 분야별 기본 장면.

장면의 모양은 schemas.OfficeSpec 이, 기하는 웹 검증기가 지킨다(office.py 머리말). 프리셋을 지우면
그것을 가리키던 시험과 분야 기본값은 자동("")으로 돌아간다 — 응시자 화면이 없어진 장면을 찾지 않는다.

템플릿(코드의 기본 장면)은 지우지 않는다. 고치면 office_builtin_overrides 에 한 행이 생기고, 되돌리면 그 행이 지워진다.
템플릿을 가리키는 참조("builtin:<id>")는 어느 쪽이든 그대로 살아 있다.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_db
from ..deps import require_admin
from ..models import AppSetting, Assessment, OfficeBuiltinOverride, OfficePreset, User
from ..office import BUILTIN_SCENES, OFFICE_DEFAULTS, OFFICE_SETTING_KEY, parse_ref, stamp_scene
from ..schemas import OfficeBuiltinOut, OfficePresetIn, OfficePresetOut, OfficeSettingsIn

router = APIRouter(prefix="/admin/office", tags=["office"], dependencies=[Depends(require_admin)])


def scene_of(row: OfficePreset) -> dict:
    """저장된 spec 에 프리셋의 id·이름을 새겨 준다 — 웹은 spec.id 로 장면을 구별하고 spec.label 을 문패에 쓴다."""
    return stamp_scene(row.spec, str(row.id), row.name)


def builtin_scene_of(row: OfficeBuiltinOverride) -> dict:
    """고친 템플릿의 장면 — id 는 템플릿 id 그대로(웹이 코드의 기본값 자리에 끼운다)."""
    return stamp_scene(row.spec, row.builtin_id, row.name)


async def builtin_overrides(db: AsyncSession) -> dict[str, dict]:
    """고친 템플릿 전부 — 템플릿 id → 장면. 코드에서 사라진 템플릿의 행은 뺀다(가리킬 곳이 없다)."""
    rows = (await db.execute(select(OfficeBuiltinOverride))).scalars().all()
    return {r.builtin_id: builtin_scene_of(r) for r in rows if r.builtin_id in BUILTIN_SCENES}


def _builtin_id(builtin_id: str) -> str:
    if builtin_id not in BUILTIN_SCENES:
        raise HTTPException(404, "없는 템플릿입니다")
    return builtin_id


def _builtin_out(row: OfficeBuiltinOverride) -> OfficeBuiltinOut:
    return OfficeBuiltinOut(id=row.builtin_id, name=row.name, spec=builtin_scene_of(row), updated_at=row.updated_at)


def _out(row: OfficePreset) -> OfficePresetOut:
    return OfficePresetOut(id=row.id, name=row.name, spec=scene_of(row), created_at=row.created_at, updated_at=row.updated_at)


async def get_office_settings(db: AsyncSession) -> dict:
    row = await db.get(AppSetting, OFFICE_SETTING_KEY)
    value = {**OFFICE_DEFAULTS, **(row.value if row else {})}
    value["defaults"] = dict(value.get("defaults") or {})
    return value


@router.get("/presets", response_model=list[OfficePresetOut])
async def list_presets(db: AsyncSession = Depends(get_db)):
    rows = (await db.execute(select(OfficePreset).order_by(OfficePreset.created_at))).scalars().all()
    return [_out(r) for r in rows]


@router.post("/presets", response_model=OfficePresetOut)
async def create_preset(body: OfficePresetIn, db: AsyncSession = Depends(get_db), user: User = Depends(require_admin)):
    row = OfficePreset(name=body.name.strip(), spec=body.spec.model_dump(), created_by=user.id)
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return _out(row)


@router.get("/presets/{preset_id}", response_model=OfficePresetOut)
async def read_preset(preset_id: uuid.UUID, db: AsyncSession = Depends(get_db)):
    row = await db.get(OfficePreset, preset_id)
    if not row:
        raise HTTPException(404, "프리셋이 없습니다")
    return _out(row)


@router.put("/presets/{preset_id}", response_model=OfficePresetOut)
async def update_preset(preset_id: uuid.UUID, body: OfficePresetIn, db: AsyncSession = Depends(get_db)):
    row = await db.get(OfficePreset, preset_id)
    if not row:
        raise HTTPException(404, "프리셋이 없습니다")
    row.name = body.name.strip()
    row.spec = body.spec.model_dump()
    await db.commit()
    await db.refresh(row)
    return _out(row)


@router.delete("/presets/{preset_id}")
async def delete_preset(preset_id: uuid.UUID, db: AsyncSession = Depends(get_db)):
    row = await db.get(OfficePreset, preset_id)
    if not row:
        raise HTTPException(404, "프리셋이 없습니다")
    ref = str(row.id)
    # 가리키던 곳은 자동으로 — 시험과 분야 기본값
    await db.execute(update(Assessment).where(Assessment.office_preset == ref).values(office_preset=""))
    setting = await db.get(AppSetting, OFFICE_SETTING_KEY)
    if setting:
        defaults = {k: v for k, v in dict((setting.value or {}).get("defaults") or {}).items() if v != ref}
        setting.value = {**(setting.value or {}), "defaults": defaults}
    await db.delete(row)
    await db.commit()
    return {"ok": True}


@router.get("/builtins", response_model=list[OfficeBuiltinOut])
async def list_builtins(db: AsyncSession = Depends(get_db)):
    """고친 템플릿만 — 여기 없는 템플릿은 코드의 기본값 그대로다."""
    rows = (await db.execute(select(OfficeBuiltinOverride).order_by(OfficeBuiltinOverride.builtin_id))).scalars().all()
    return [_builtin_out(r) for r in rows if r.builtin_id in BUILTIN_SCENES]


@router.put("/builtins/{builtin_id}", response_model=OfficeBuiltinOut)
async def save_builtin(
    builtin_id: str, body: OfficePresetIn, db: AsyncSession = Depends(get_db), user: User = Depends(require_admin)
):
    """템플릿을 고친 모양으로 덮는다. 배포가 코드를 새로 깔아도 이 행은 남는다."""
    _builtin_id(builtin_id)
    spec = body.spec.model_dump()
    spec["id"], spec["label"] = "", ""  # id·이름은 행이 안다
    row = await db.get(OfficeBuiltinOverride, builtin_id)
    if row:
        row.name = body.name.strip()
        row.spec = spec
        row.updated_by = user.id
    else:
        row = OfficeBuiltinOverride(builtin_id=builtin_id, name=body.name.strip(), spec=spec, updated_by=user.id)
        db.add(row)
    await db.commit()
    await db.refresh(row)
    return _builtin_out(row)


@router.delete("/builtins/{builtin_id}")
async def reset_builtin(builtin_id: str, db: AsyncSession = Depends(get_db)):
    """기본값으로 되돌리기 — 고친 행을 지운다. 고친 적이 없어도 성공이다(이미 기본값)."""
    _builtin_id(builtin_id)
    row = await db.get(OfficeBuiltinOverride, builtin_id)
    if row:
        await db.delete(row)
        await db.commit()
    return {"ok": True, "reset": bool(row)}


@router.get("/settings")
async def read_settings(db: AsyncSession = Depends(get_db)):
    return await get_office_settings(db)


@router.put("/settings")
async def write_settings(body: OfficeSettingsIn, db: AsyncSession = Depends(get_db)):
    # 프리셋 참조는 실제로 있어야 한다
    for key, ref in body.defaults.items():
        kind, value = parse_ref(ref)
        if kind == "custom" and not await db.get(OfficePreset, uuid.UUID(value)):
            raise HTTPException(400, f"{key or '미분류'}: 존재하지 않는 사무실 프리셋입니다")
    row = await db.get(AppSetting, OFFICE_SETTING_KEY)
    value = {"defaults": body.defaults}
    if row:
        row.value = value
    else:
        db.add(AppSetting(key=OFFICE_SETTING_KEY, value=value))
    await db.commit()
    return await get_office_settings(db)

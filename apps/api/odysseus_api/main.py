import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text

from .config import check_startup_security, settings
from .db import Base, SessionLocal, engine
from .routers import (
    agent,
    assessments,
    attempts,
    auth,
    executions,
    files,
    internal,
    messenger,
    reference,
    resources,
    review,
    scenarios,
    settings as settings_router,
    users,
)
from .seed import bootstrap_if_empty, seed_demo_if_empty

# create_all은 기존 테이블에 컬럼을 추가하지 않는다 — 스키마 변경은 여기에 idempotent DDL로 누적
MIGRATIONS: list[str] = [
    # 순차 진행(다중 시나리오) — 현재 시나리오 위치
    "ALTER TABLE attempts ADD COLUMN IF NOT EXISTS current_ordinal INTEGER NOT NULL DEFAULT 0",
    # ODY-002: 실행 결과 콜백의 일회용 토큰
    "ALTER TABLE executions ADD COLUMN IF NOT EXISTS callback_token VARCHAR(64)",
    # ODY-007: 종료 시점 스냅샷 + 제출 뒤 워크스페이스 동결 (애플리케이션 버그·늦은 콜백과 무관하게 DB 가 막는다)
    "ALTER TABLE attempts ADD COLUMN IF NOT EXISTS snapshot JSONB",
    """
    CREATE OR REPLACE FUNCTION workspace_files_frozen_guard() RETURNS trigger AS $$
    DECLARE st TEXT;
    BEGIN
        SELECT status INTO st FROM attempts WHERE id = COALESCE(NEW.attempt_id, OLD.attempt_id);
        -- 응시가 없으면(CASCADE 삭제 중) 통과, 진행 중이 아니면 거부
        IF st IS NOT NULL AND st <> 'in_progress' THEN
            RAISE EXCEPTION 'workspace is frozen: attempt % is %', COALESCE(NEW.attempt_id, OLD.attempt_id), st
                USING ERRCODE = 'check_violation';
        END IF;
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
    END $$ LANGUAGE plpgsql
    """,
    "DROP TRIGGER IF EXISTS workspace_files_frozen ON workspace_files",
    """
    CREATE TRIGGER workspace_files_frozen BEFORE INSERT OR UPDATE OR DELETE ON workspace_files
        FOR EACH ROW EXECUTE FUNCTION workspace_files_frozen_guard()
    """,
]


@asynccontextmanager
async def lifespan(app: FastAPI):
    for i in range(30):
        try:
            async with engine.begin() as conn:
                await conn.run_sync(Base.metadata.create_all)
                for stmt in MIGRATIONS:
                    await conn.execute(text(stmt))
            break
        except Exception:
            if i == 29:
                raise
            await asyncio.sleep(2)
    # 빈 DB: 운영은 관리자 부트스트랩, 개발(명시적 플래그)은 데모 시드. 운영에서 데모 시드는 기동 거부.
    check_startup_security()
    async with SessionLocal() as db:
        if settings.seed_demo_data:
            await seed_demo_if_empty(db)
        else:
            await bootstrap_if_empty(db)
    yield
    await engine.dispose()


app = FastAPI(title="Odysseus API", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3100", "http://127.0.0.1:3100"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(users.router)
app.include_router(scenarios.router)
app.include_router(assessments.router)
app.include_router(attempts.router)
app.include_router(messenger.router)
app.include_router(agent.router)
app.include_router(files.router)
app.include_router(reference.router)
app.include_router(resources.router)
app.include_router(executions.router)
app.include_router(review.router)
app.include_router(settings_router.router)
app.include_router(internal.router)


@app.get("/healthz")
async def healthz():
    return {"ok": True}

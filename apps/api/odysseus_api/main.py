import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text

from .config import settings
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
    review,
    scenarios,
    settings as settings_router,
    users,
)
from .seed import seed_if_empty

# create_all은 기존 테이블에 컬럼을 추가하지 않는다 — 스키마 변경은 여기에 idempotent DDL로 누적
MIGRATIONS: list[str] = [
    # 순차 진행(다중 시나리오) — 현재 시나리오 위치
    "ALTER TABLE attempts ADD COLUMN IF NOT EXISTS current_ordinal INTEGER NOT NULL DEFAULT 0",
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
    if settings.seed_demo_data:
        async with SessionLocal() as db:
            await seed_if_empty(db)
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
app.include_router(executions.router)
app.include_router(review.router)
app.include_router(settings_router.router)
app.include_router(internal.router)


@app.get("/healthz")
async def healthz():
    return {"ok": True}

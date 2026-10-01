import asyncio
from contextlib import asynccontextmanager, suppress

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import check_startup_security, https_only_enabled, settings
from .db import Base, SessionLocal, engine
from .account_sweep import account_sweep_loop
from .migrations import run_schema_migrations
from .queue_recovery import recovery_loop
from .secrets import install_encrypted_types, migrate_encrypted_storage, report_unreadable_secrets
from .routers import (
    access,
    agent,
    assessments,
    attempts,
    auth,
    executions,
    files,
    internal,
    mail,
    messenger,
    office,
    office_dialogue,
    reference,
    resources,
    review,
    scenarios,
    settings as settings_router,
    users,
)
from .seed import bootstrap_if_empty, seed_demo_if_empty, sync_presets

install_encrypted_types()


@asynccontextmanager
async def lifespan(app: FastAPI):
    # 시크릿 길이·자리표시자·운영 데모시드 금지(ODY-001) + DATA_ENCRYPTION_KEY — DB 를 만지기 전에 거부한다
    check_startup_security()
    for i in range(30):
        try:
            async with engine.begin() as conn:
                # Fresh installations still get the current baseline from metadata. Existing installs
                # then advance through the durable, versioned migration ledger. The migration runner
                # owns the cross-replica advisory lock.
                await run_schema_migrations(conn, create_all=Base.metadata.create_all)
            break
        except Exception:
            if i == 29:
                raise
            await asyncio.sleep(2)

    async with SessionLocal() as db:
        await migrate_encrypted_storage(db)
        await report_unreadable_secrets(db)
        if settings.seed_demo_data:
            await seed_demo_if_empty(db)
        else:
            await bootstrap_if_empty(db)
        # 코드에 새로 들어온 프리셋은 기존 설치본에도 도착해야 한다
        await sync_presets(db)

    queue_recovery_task = asyncio.create_task(recovery_loop(), name="execution-queue-recovery")
    account_sweep_task = asyncio.create_task(account_sweep_loop(), name="visitor-account-sweep")
    try:
        yield
    finally:
        for task in (queue_recovery_task, account_sweep_task):
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task
        await engine.dispose()


app = FastAPI(title="Odysseus API", version="0.1.0", lifespan=lifespan)

PROXY_MARKERS = ("x-forwarded-for", "x-forwarded-proto", "cf-visitor", "cf-connecting-ip")
MUTATING = frozenset({"POST", "PUT", "PATCH", "DELETE"})


@app.middleware("http")
async def no_store_and_origin_check(request, call_next):
    """ODY-023: API 응답 비저장 + ODY-024: 프록시 변경 요청의 same-origin 검증."""
    if request.method in MUTATING and any(h in request.headers for h in PROXY_MARKERS):
        origin = request.headers.get("origin")
        host = request.headers.get("host", "")
        proto = (request.headers.get("x-forwarded-proto") or "http").split(",")[0].strip().lower()
        if origin:
            if origin.lower() != f"{proto}://{host}".lower():
                from fastapi.responses import JSONResponse

                return JSONResponse({"detail": "다른 출처에서 온 요청입니다"}, status_code=403)
        else:
            site = (request.headers.get("sec-fetch-site") or "").lower()
            if site in ("cross-site", "same-site"):
                from fastapi.responses import JSONResponse

                return JSONResponse({"detail": "다른 출처에서 온 요청입니다"}, status_code=403)
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-store, private"
    response.headers["Pragma"] = "no-cache"
    return response


@app.middleware("http")
async def require_https_behind_proxy(request, call_next):
    if https_only_enabled() and request.method in MUTATING and any(h in request.headers for h in PROXY_MARKERS):
        proto = (request.headers.get("x-forwarded-proto") or "").split(",")[0].strip().lower()
        if proto != "https":
            from fastapi.responses import JSONResponse

            return JSONResponse({"detail": "HTTPS 로만 접속할 수 있습니다"}, status_code=403)
    return await call_next(request)


app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3100", "http://127.0.0.1:3100"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(users.router)
app.include_router(access.router)
app.include_router(scenarios.router)
app.include_router(assessments.router)
app.include_router(attempts.router)
app.include_router(messenger.router)
app.include_router(mail.router)
app.include_router(agent.router)
app.include_router(files.router)
app.include_router(reference.router)
app.include_router(resources.router)
app.include_router(executions.router)
app.include_router(review.router)
app.include_router(settings_router.router)
app.include_router(office.router)
app.include_router(office_dialogue.router)
app.include_router(internal.router)


@app.get("/healthz")
async def healthz():
    return {"ok": True}

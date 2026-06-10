"""FastAPI app factory: routers, RU error envelope, request-id, health, metrics."""
from __future__ import annotations

import logging
import time
import uuid

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, PlainTextResponse
from sqlalchemy import text

from app.api import attachments, auth, export, tasks, users
from app.core.config import settings
from app.core.errors import AppError
from app.core.observability import (
    init_sentry, observe_request, render_metrics, setup_logging,
)
from app.db.session import engine
from app.services.sessions import _redis

setup_logging()
init_sentry()
_log = logging.getLogger("http")

app = FastAPI(title=settings.app_name, docs_url=None, redoc_url=None)
app.include_router(auth.router)
app.include_router(tasks.router)
app.include_router(users.router)
app.include_router(attachments.router)
app.include_router(export.router)


@app.middleware("http")
async def request_id_mw(request: Request, call_next):
    rid = request.headers.get("x-request-id") or uuid.uuid4().hex
    request.state.request_id = rid
    start = time.perf_counter()
    response = await call_next(request)
    duration = time.perf_counter() - start
    response.headers["X-Request-Id"] = rid
    endpoint = request.scope.get("route").path if request.scope.get("route") else request.url.path
    observe_request(endpoint, response.status_code, duration)
    _log.info(
        "request",
        extra={
            "request_id": rid,
            "method": request.method,
            "path": endpoint,
            "status": response.status_code,
            "duration_ms": round(duration * 1000, 2),
        },
    )
    return response


@app.get("/api/metrics")
async def metrics() -> PlainTextResponse:
    return PlainTextResponse(render_metrics(), media_type="text/plain; version=0.0.4")


@app.exception_handler(AppError)
async def app_error_handler(request: Request, exc: AppError):
    return JSONResponse(status_code=exc.status_code, content=exc.detail)


@app.exception_handler(RequestValidationError)
async def validation_handler(request: Request, exc: RequestValidationError):
    return JSONResponse(
        status_code=422,
        content={"code": "VALIDATION", "message": "Ошибка валидации данных",
                 "details": exc.errors()},
    )


@app.get("/api/health")
async def health():
    db_ok = redis_ok = False
    try:
        async with engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
        db_ok = True
    except Exception:
        db_ok = False
    try:
        redis_ok = await _redis.ping()
    except Exception:
        redis_ok = False
    status = "ok" if (db_ok and redis_ok) else "degraded"
    code = 200 if status == "ok" else 503
    return JSONResponse(status_code=code, content={"status": status, "db": db_ok, "redis": bool(redis_ok)})

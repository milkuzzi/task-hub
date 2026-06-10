"""FastAPI app factory: routers, RU error envelope, request-id, health."""
from __future__ import annotations

import uuid

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app.api import auth, tasks
from app.core.config import settings
from app.core.errors import AppError
from app.db.session import engine
from app.services.sessions import _redis

app = FastAPI(title=settings.app_name, docs_url=None, redoc_url=None)
app.include_router(auth.router)
app.include_router(tasks.router)


@app.middleware("http")
async def request_id_mw(request: Request, call_next):
    rid = request.headers.get("x-request-id") or uuid.uuid4().hex
    request.state.request_id = rid
    response = await call_next(request)
    response.headers["X-Request-Id"] = rid
    return response


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

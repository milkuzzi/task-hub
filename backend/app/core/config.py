"""Application settings (Pydantic v2 BaseSettings).

Reads from environment / Docker secrets. No real secrets live here.
asyncpg behind PgBouncer transaction pooling requires statement_cache_size=0.
"""
from __future__ import annotations

from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # --- core ---
    app_name: str = "TaskHub"
    environment: str = "production"
    secret_key: str = Field(default="change-me")
    tz_display: str = "Europe/Moscow"

    # --- database ---
    # Runtime URL points at PgBouncer (transaction pool). asyncpg + PgBouncer
    # transaction mode => statement_cache_size=0 (set in db.session connect_args).
    database_url: str = Field(
        default="postgresql+asyncpg://taskhub:taskhub@pgbouncer:6432/taskhub"
    )
    # Alembic / direct admin connection should bypass PgBouncer (session mode)
    # to run DDL safely. Point straight at postgres:5432.
    alembic_database_url: str = Field(
        default="postgresql+asyncpg://taskhub:taskhub@postgres:5432/taskhub"
    )

    # SQLAlchemy app-side pool. Formula (documented in README):
    #   per_worker_pool = max(2, floor( PgBouncer default_pool_size / gunicorn_workers ))
    # With 4 vCPU => 4 workers; PgBouncer default_pool_size=20 => ~5 each.
    db_pool_size: int = 5
    db_max_overflow: int = 0  # transaction pooling: keep app pool tight, PgBouncer multiplexes
    db_pool_timeout: int = 5

    # --- redis ---
    redis_url: str = Field(default="redis://redis:6379/0")
    redis_cache_url: str = Field(default="redis://redis:6379/1")

    # --- auth ---
    access_token_ttl_seconds: int = 900          # 15 min
    refresh_token_ttl_seconds: int = 60 * 60 * 24 * 14  # 14 days
    # argon2id params (OWASP floor; tuned to login p95 budget, see README)
    argon2_time_cost: int = 3
    argon2_memory_cost: int = 65536  # 64 MiB
    argon2_parallelism: int = 2
    cookie_secure: bool = True
    cookie_domain: str | None = None

    # --- files ---
    upload_dir: str = "/data/uploads"
    max_upload_bytes: int = 25 * 1024 * 1024  # 25 MiB

    # --- notifications / SendPulse ---
    sendpulse_client_id: str = ""
    sendpulse_client_secret: str = ""
    sendpulse_from_email: str = "noreply@example.com"
    sendpulse_from_name: str = "TaskHub"
    notification_max_attempts: int = 5

    # --- observability ---
    sentry_dsn: str | None = None
    log_level: str = "INFO"


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()

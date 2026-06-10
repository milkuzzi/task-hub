"""Async engine + session factory.

statement_cache_size=0 is MANDATORY: asyncpg prepared-statement cache is
incompatible with PgBouncer transaction pooling (prepared statements live on
a backend connection that PgBouncer may hand to another client).
"""
from __future__ import annotations

from collections.abc import AsyncGenerator

from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from app.core.config import settings

engine = create_async_engine(
    settings.database_url,
    pool_size=settings.db_pool_size,
    max_overflow=settings.db_max_overflow,
    pool_timeout=settings.db_pool_timeout,
    pool_pre_ping=True,
    connect_args={
        "statement_cache_size": 0,            # PgBouncer transaction mode
        "prepared_statement_cache_size": 0,
    },
)

SessionLocal = async_sessionmaker(
    engine, expire_on_commit=False, autoflush=False
)


async def get_session() -> AsyncGenerator[AsyncSession, None]:
    async with SessionLocal() as session:
        yield session

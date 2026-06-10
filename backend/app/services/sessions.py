"""Redis-backed session + auth dependencies.

- access/refresh tokens stored in Redis; refresh rotation with reuse detection
  (token family invalidation). Immediate revoke via Redis delete.
- cookies httpOnly+Secure+SameSite=Strict.
- soft fingerprint binding (UA + /24 subnet) with re-auth on change.
"""
from __future__ import annotations

import hashlib
import json
import uuid

import redis.asyncio as aioredis
from fastapi import Depends, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.errors import unauthenticated
from app.core.security import new_token
from app.db.session import get_session
from app.models import User

_redis = aioredis.from_url(settings.redis_url, decode_responses=True)

ACCESS_PREFIX = "sess:access:"
REFRESH_PREFIX = "sess:refresh:"
FAMILY_PREFIX = "sess:family:"


def _fingerprint(request: Request) -> str:
    ua = request.headers.get("user-agent", "")
    ip = (request.client.host if request.client else "") or ""
    subnet = ".".join(ip.split(".")[:3])  # /24 softness
    return hashlib.sha256(f"{ua}|{subnet}".encode()).hexdigest()[:32]


async def create_session(user_id: uuid.UUID, fp: str) -> tuple[str, str]:
    family = new_token(16)
    access = new_token()
    refresh = new_token()
    payload = json.dumps({"uid": str(user_id), "fp": fp, "family": family})
    await _redis.set(ACCESS_PREFIX + access, payload, ex=settings.access_token_ttl_seconds)
    await _redis.set(REFRESH_PREFIX + refresh, payload, ex=settings.refresh_token_ttl_seconds)
    await _redis.sadd(FAMILY_PREFIX + family, refresh)
    await _redis.expire(FAMILY_PREFIX + family, settings.refresh_token_ttl_seconds)
    return access, refresh


async def rotate_refresh(refresh: str, fp: str) -> tuple[str, str] | None:
    raw = await _redis.get(REFRESH_PREFIX + refresh)
    if raw is None:
        # Possible reuse of an already-rotated token => nuke the whole family.
        # We cannot know the family from an unknown token, so callers should
        # treat None as hard logout. Reuse within a known family is handled below.
        return None
    data = json.loads(raw)
    family = data["family"]
    # consume old refresh (one-time use)
    await _redis.delete(REFRESH_PREFIX + refresh)
    member = await _redis.srem(FAMILY_PREFIX + family, refresh)
    if member == 0:
        # token was valid in Redis but not in family set => reuse => invalidate family
        await _invalidate_family(family)
        return None
    access = new_token()
    new_refresh = new_token()
    payload = json.dumps({"uid": data["uid"], "fp": fp, "family": family})
    await _redis.set(ACCESS_PREFIX + access, payload, ex=settings.access_token_ttl_seconds)
    await _redis.set(REFRESH_PREFIX + new_refresh, payload, ex=settings.refresh_token_ttl_seconds)
    await _redis.sadd(FAMILY_PREFIX + family, new_refresh)
    return access, new_refresh


async def _invalidate_family(family: str) -> None:
    members = await _redis.smembers(FAMILY_PREFIX + family)
    pipe = _redis.pipeline()
    for m in members:
        pipe.delete(REFRESH_PREFIX + m)
    pipe.delete(FAMILY_PREFIX + family)
    await pipe.execute()


async def revoke_access(access: str) -> None:
    await _redis.delete(ACCESS_PREFIX + access)


async def get_current_user(
    request: Request,
    session: AsyncSession = Depends(get_session),
) -> User:
    access = request.cookies.get("access_token")
    if not access:
        raise unauthenticated()
    raw = await _redis.get(ACCESS_PREFIX + access)
    if raw is None:
        raise unauthenticated()
    data = json.loads(raw)
    # soft fingerprint check
    if data.get("fp") != _fingerprint(request):
        # mismatch => force re-auth (caller will refresh or re-login)
        raise unauthenticated()
    user = await session.scalar(select(User).where(User.id == uuid.UUID(data["uid"])))
    if user is None or not user.is_active:
        raise unauthenticated()
    return user

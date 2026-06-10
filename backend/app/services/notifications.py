"""Notification channel adapter + idempotent send.

EmailChannel  -> SendPulse REST (OAuth token cached in Redis, auto-refresh).
MaxChannel    -> stub (logs only).

Idempotency contract: caller INSERTs notifications_log (ON CONFLICT DO NOTHING).
Only when rowcount==1 do we send. On failure we bump attempts + last_error.
"""
from __future__ import annotations

import time
from abc import ABC, abstractmethod

import httpx
import redis.asyncio as aioredis

from app.core.config import settings

_redis = aioredis.from_url(settings.redis_url, decode_responses=True)
SP_TOKEN_KEY = "sendpulse:token"


class Channel(ABC):
    @abstractmethod
    async def send(self, *, to_email: str, subject: str, html: str) -> None: ...


class MaxChannel(Channel):
    async def send(self, *, to_email, subject, html) -> None:
        # Stub channel — integration point for the MAX messenger.
        print(f"[MAX stub] -> {to_email}: {subject}")


class EmailChannel(Channel):
    async def _token(self) -> str:
        tok = await _redis.get(SP_TOKEN_KEY)
        if tok:
            return tok
        async with httpx.AsyncClient(timeout=10) as c:
            r = await c.post("https://api.sendpulse.com/oauth/access_token", json={
                "grant_type": "client_credentials",
                "client_id": settings.sendpulse_client_id,
                "client_secret": settings.sendpulse_client_secret,
            })
            r.raise_for_status()
            data = r.json()
        tok = data["access_token"]
        # refresh slightly before expiry
        await _redis.set(SP_TOKEN_KEY, tok, ex=max(60, int(data.get("expires_in", 3600)) - 60))
        return tok

    async def send(self, *, to_email, subject, html) -> None:
        token = await self._token()
        async with httpx.AsyncClient(timeout=15) as c:
            r = await c.post(
                "https://api.sendpulse.com/smtp/emails",
                headers={"Authorization": f"Bearer {token}"},
                json={"email": {
                    "subject": subject,
                    "html": html,
                    "from": {"name": settings.sendpulse_from_name, "email": settings.sendpulse_from_email},
                    "to": [{"email": to_email}],
                }},
            )
            if r.status_code == 401:
                await _redis.delete(SP_TOKEN_KEY)  # force refresh next time
            r.raise_for_status()


def get_channel(kind: str = "email") -> Channel:
    return EmailChannel() if kind == "email" else MaxChannel()

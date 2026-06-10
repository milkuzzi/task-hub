"""CSRF protection: double-submit token + Origin/Referer check.

Works alongside SameSite=Strict cookies. The CSRF token is issued via
GET /api/auth/csrf (readable cookie + returned value); state-changing requests
must echo it in the X-CSRF-Token header, and it must match the cookie.
"""
from __future__ import annotations

from fastapi import Request

from app.core.errors import forbidden
from app.core.security import new_token

SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}


def issue_csrf() -> str:
    return new_token(24)


def _origin_ok(request: Request) -> bool:
    origin = request.headers.get("origin") or request.headers.get("referer")
    if origin is None:
        # Same-origin browsers send Origin on state-changing requests; absence
        # on a mutation is suspicious.
        return False
    host = request.headers.get("host", "")
    return host in origin


def enforce_csrf(request: Request) -> None:
    if request.method in SAFE_METHODS:
        return
    if not _origin_ok(request):
        raise forbidden("Недопустимый источник запроса")
    cookie = request.cookies.get("csrf_token")
    header = request.headers.get("x-csrf-token")
    if not cookie or not header or cookie != header:
        raise forbidden("Неверный CSRF-токен")

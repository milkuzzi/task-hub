"""Auth API router — /api/auth: register, login, logout, me, csrf, refresh.

Registration is registry-only: the e-mail must already exist in users (seeded by
ADMIN) with a NULL password_hash. login/refresh set httpOnly+Secure+SameSite=Strict
cookies. CSRF token issued via /csrf.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Request, Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.csrf import enforce_csrf, issue_csrf
from app.core.errors import forbidden, unauthenticated
from app.core.security import hash_password, needs_rehash, verify_password
from app.db.session import get_session
from app.models import User
from app.schemas import LoginIn, MeOut, RegisterIn
from app.services import sessions as sess

router = APIRouter(prefix="/api/auth", tags=["auth"])

COOKIE_KW = dict(httponly=True, secure=settings.cookie_secure, samesite="strict", path="/")


def _set_auth_cookies(resp: Response, access: str, refresh: str) -> None:
    resp.set_cookie("access_token", access, max_age=settings.access_token_ttl_seconds, **COOKIE_KW)
    resp.set_cookie("refresh_token", refresh, max_age=settings.refresh_token_ttl_seconds, **COOKIE_KW)


@router.get("/csrf")
async def get_csrf(response: Response):
    token = issue_csrf()
    # csrf cookie is readable by JS-less double-submit: NOT httpOnly
    response.set_cookie("csrf_token", token, secure=settings.cookie_secure, samesite="strict", path="/")
    return {"csrf_token": token}


@router.post("/register", response_model=MeOut)
async def register(body: RegisterIn, request: Request, response: Response,
                   session: AsyncSession = Depends(get_session)):
    enforce_csrf(request)
    user = await session.scalar(select(User).where(User.email == body.email))
    # registry-only: must be pre-seeded and not yet activated
    if user is None or user.password_hash is not None or not user.is_active:
        raise forbidden("Регистрация доступна только по e-mail из реестра")
    user.password_hash = hash_password(body.password)
    user.full_name = body.full_name or user.full_name
    await session.commit()
    fp = sess._fingerprint(request)
    access, refresh = await sess.create_session(user.id, fp)
    _set_auth_cookies(response, access, refresh)
    return MeOut.model_validate(user)


@router.post("/login", response_model=MeOut)
async def login(body: LoginIn, request: Request, response: Response,
                session: AsyncSession = Depends(get_session)):
    enforce_csrf(request)
    user = await session.scalar(select(User).where(User.email == body.email))
    if user is None or user.password_hash is None or not user.is_active:
        raise unauthenticated()
    if not verify_password(body.password, user.password_hash):
        raise unauthenticated()
    if needs_rehash(user.password_hash):
        user.password_hash = hash_password(body.password)
        await session.commit()
    fp = sess._fingerprint(request)
    access, refresh = await sess.create_session(user.id, fp)
    _set_auth_cookies(response, access, refresh)
    return MeOut.model_validate(user)


@router.post("/refresh", response_model=MeOut)
async def refresh(request: Request, response: Response,
                  session: AsyncSession = Depends(get_session)):
    token = request.cookies.get("refresh_token")
    if not token:
        raise unauthenticated()
    fp = sess._fingerprint(request)
    rotated = await sess.rotate_refresh(token, fp)
    if rotated is None:
        # reuse detected or expired => clear cookies
        response.delete_cookie("access_token", path="/")
        response.delete_cookie("refresh_token", path="/")
        raise unauthenticated()
    access, new_refresh = rotated
    _set_auth_cookies(response, access, new_refresh)
    # fetch user from the freshly-issued access payload
    import json
    import uuid as _uuid
    raw = await sess._redis.get(sess.ACCESS_PREFIX + access)
    data = json.loads(raw)
    user = await session.scalar(select(User).where(User.id == _uuid.UUID(data["uid"])))
    return MeOut.model_validate(user)


@router.post("/logout", status_code=204)
async def logout(request: Request, response: Response):
    access = request.cookies.get("access_token")
    if access:
        await sess.revoke_access(access)
    refresh = request.cookies.get("refresh_token")
    if refresh:
        await sess.rotate_refresh(refresh, sess._fingerprint(request))  # consumes it
    response.delete_cookie("access_token", path="/")
    response.delete_cookie("refresh_token", path="/")
    response.delete_cookie("csrf_token", path="/")


@router.get("/me", response_model=MeOut)
async def me(user: User = Depends(sess.get_current_user)):
    return MeOut.model_validate(user)

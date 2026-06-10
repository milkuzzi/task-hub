"""Admin-only users CRUD under /api/users. Registration stays registry-only:
an admin creates a user row (NULL password_hash) and the user self-activates via
/api/auth/register. ADMIN gate on every route.
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.csrf import enforce_csrf
from app.core.errors import forbidden, not_found
from app.db.session import get_session
from app.models import User
from app.schemas import UserCreateIn, UserListOut, UserOut, UserUpdateIn
from app.services.sessions import get_current_user

router = APIRouter(prefix='/api/users', tags=['users'])


def _admin(user: User = Depends(get_current_user)) -> User:
    if not user.is_admin:
        raise forbidden('\u0422\u0440\u0435\u0431\u0443\u044e\u0442\u0441\u044f \u043f\u0440\u0430\u0432\u0430 \u0430\u0434\u043c\u0438\u043d\u0438\u0441\u0442\u0440\u0430\u0442\u043e\u0440\u0430')
    return user


@router.get('', response_model=UserListOut)
async def list_users(_: User = Depends(_admin), session: AsyncSession = Depends(get_session)):
    rows = (await session.execute(select(User).order_by(User.created_at.desc()))).scalars().all()
    return UserListOut(items=[UserOut.model_validate(r) for r in rows])


@router.post('', response_model=UserOut, status_code=201)
async def create_user(body: UserCreateIn, request: Request,
                      _: User = Depends(_admin), session: AsyncSession = Depends(get_session)):
    enforce_csrf(request)
    existing = await session.scalar(select(User).where(User.email == body.email))
    if existing is not None:
        raise forbidden('\u041f\u043e\u043b\u044c\u0437\u043e\u0432\u0430\u0442\u0435\u043b\u044c \u0441 \u0442\u0430\u043a\u0438\u043c e-mail \u0443\u0436\u0435 \u0441\u0443\u0449\u0435\u0441\u0442\u0432\u0443\u0435\u0442')
    user = User(email=body.email, full_name=body.full_name, is_admin=body.is_admin, password_hash=None)
    session.add(user)
    await session.commit()
    await session.refresh(user)
    return UserOut.model_validate(user)


@router.patch('/{user_id}', response_model=UserOut)
async def update_user(user_id: uuid.UUID, body: UserUpdateIn, request: Request,
                      _: User = Depends(_admin), session: AsyncSession = Depends(get_session)):
    enforce_csrf(request)
    user = await session.get(User, user_id)
    if user is None:
        raise not_found()
    for k, v in body.model_dump(exclude_unset=True).items():
        setattr(user, k, v)
    await session.commit()
    await session.refresh(user)
    return UserOut.model_validate(user)


@router.delete('/{user_id}', status_code=204)
async def deactivate_user(user_id: uuid.UUID, request: Request,
                          admin: User = Depends(_admin), session: AsyncSession = Depends(get_session)):
    enforce_csrf(request)
    user = await session.get(User, user_id)
    if user is None:
        raise not_found()
    if user.id == admin.id:
        raise forbidden('\u041d\u0435\u043b\u044c\u0437\u044f \u0434\u0435\u0430\u043a\u0442\u0438\u0432\u0438\u0440\u043e\u0432\u0430\u0442\u044c \u0441\u0435\u0431\u044f')
    user.is_active = False  # soft-deactivate; tasks reference RESTRICT
    await session.commit()

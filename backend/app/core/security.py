"""Password hashing (argon2id) + token helpers.

argon2id params come from settings (OWASP floor). Login p95 budget is met by
tuning memory_cost; see README for the calibration procedure.
"""
from __future__ import annotations

import secrets

from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError
from argon2.low_level import Type

from app.core.config import settings

_ph = PasswordHasher(
    time_cost=settings.argon2_time_cost,
    memory_cost=settings.argon2_memory_cost,
    parallelism=settings.argon2_parallelism,
    type=Type.ID,  # argon2id
)


def hash_password(raw: str) -> str:
    return _ph.hash(raw)


def verify_password(raw: str, hashed: str) -> bool:
    try:
        _ph.verify(hashed, raw)
        return True
    except VerifyMismatchError:
        return False


def needs_rehash(hashed: str) -> bool:
    return _ph.check_needs_rehash(hashed)


def new_token(nbytes: int = 32) -> str:
    return secrets.token_urlsafe(nbytes)

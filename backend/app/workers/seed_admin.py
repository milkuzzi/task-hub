"""Idempotent first-ADMIN seed. Run: python -m app.workers.seed_admin

Reads ADMIN_EMAIL / ADMIN_NAME / ADMIN_PASSWORD from env. Safe to run repeatedly:
INSERT ... ON CONFLICT (email) DO NOTHING, then ensures is_admin=true.
"""
from __future__ import annotations

import os
from sqlalchemy import create_engine, text

from app.core.config import settings
from app.core.security import hash_password


def main() -> None:
    email = os.environ["ADMIN_EMAIL"]
    name = os.environ.get("ADMIN_NAME", "Администратор")
    pw = os.environ["ADMIN_PASSWORD"]
    eng = create_engine(settings.alembic_database_url.replace("+asyncpg", ""))
    with eng.begin() as c:
        c.execute(text(
            "INSERT INTO users (email, full_name, password_hash, is_admin, is_active) "
            "VALUES (:e,:n,:p,true,true) ON CONFLICT (email) DO UPDATE "
            "SET is_admin = true, is_active = true"
        ), {"e": email, "n": name, "p": hash_password(pw)})
    print(f"ADMIN ensured: {email}")


if __name__ == "__main__":
    main()

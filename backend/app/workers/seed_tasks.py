"""Seed ~100k tasks for performance / EXPLAIN reproduction.

Usage (inside backend container):
  N=100000 python -m app.workers.seed_tasks

Creates one owner if none exists, then bulk-inserts N tasks with a realistic
spread of deadlines (incl. NULLs for NULLS-LAST keyset coverage) and statuses.
Uses a single multi-row INSERT batched to keep it fast.
"""
from __future__ import annotations

import os
import random
import datetime as dt

from sqlalchemy import create_engine, text

from app.core.config import settings

N = int(os.environ.get('N', '100000'))
BATCH = 5000
STATUSES = ['NEW', 'IN_PROGRESS', 'DONE', 'CANCELLED']


def main() -> None:
    url = settings.alembic_database_url.replace('+asyncpg', '+psycopg2')
    eng = create_engine(url, future=True)
    with eng.begin() as c:
        owner = c.execute(text('SELECT id FROM users LIMIT 1')).scalar()
        if owner is None:
            owner = c.execute(text(
                "INSERT INTO users (email, full_name, is_admin) "
                "VALUES ('seed@example.com','Seed Owner', true) RETURNING id"
            )).scalar()
        now = dt.datetime.now(dt.timezone.utc)
        inserted = 0
        while inserted < N:
            rows = []
            for i in range(min(BATCH, N - inserted)):
                # ~10% NULL deadline to exercise NULLS LAST keyset branch
                if random.random() < 0.1:
                    deadline = None
                else:
                    deadline = now + dt.timedelta(days=random.randint(-60, 120))
                rows.append({
                    'title': f'Seed task {inserted + i}',
                    'owner': owner,
                    'status': random.choice(STATUSES),
                    'deadline': deadline,
                })
            c.execute(text(
                'INSERT INTO tasks (title, owner_id, status, deadline) '
                'VALUES (:title, :owner, :status, :deadline)'
            ), rows)
            inserted += len(rows)
            print(f'inserted {inserted}/{N}')
        c.execute(text('ANALYZE tasks'))
    print('done')


if __name__ == '__main__':
    main()

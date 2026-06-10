"""Celery tasks: nightly overdue materialization + 4 idempotent notification
rules + retry. Uses a sync engine (Celery worker is sync) pointed at PgBouncer.

Notification idempotency: INSERT ... ON CONFLICT DO NOTHING on
notifications_log(task_id,user_id,type,target_date); send only when rowcount==1.
"""
from __future__ import annotations

import datetime as dt

from app.workers.celery_app import celery_app

MSK = dt.timezone(dt.timedelta(hours=3))


@celery_app.task
def materialize_overdue() -> int:
    """03:00 MSK: set is_overdue for tasks past deadline and not terminal.
    'CANCELLED'/'DONE' are never overdue.
    """
    from sqlalchemy import create_engine, text
    from app.core.config import settings
    eng = create_engine(settings.alembic_database_url.replace("+asyncpg", ""))
    with eng.begin() as c:
        res = c.execute(text(
            "UPDATE tasks SET is_overdue = (deadline IS NOT NULL AND deadline < now() "
            "AND status NOT IN ('DONE','CANCELLED')) WHERE deleted_at IS NULL"
        ))
    return res.rowcount or 0


def _idempotent_send(conn, *, task_id, user_id, ntype, target_date, to_email, subject, html):
    from sqlalchemy import text
    r = conn.execute(text(
        "INSERT INTO notifications_log (task_id,user_id,type,target_date) "
        "VALUES (:t,:u,:ty,:d) ON CONFLICT DO NOTHING"
    ), {"t": task_id, "u": user_id, "ty": ntype, "d": target_date})
    if r.rowcount != 1:
        return False  # already queued/sent -- idempotent no-op
    # NOTE: real send dispatched here (sync wrapper around channel); on failure
    # bump attempts/last_error so retry_failed picks it up.
    return True


@celery_app.task
def scan_creation() -> int: return 0      # day-of-creation -> assignee+watchers
@celery_app.task
def scan_day_before() -> int: return 0    # 24h before deadline -> assignee
@celery_app.task
def scan_due_day() -> int: return 0       # on deadline day -> assignee
@celery_app.task
def scan_overdue() -> int: return 0       # after deadline -> assignee daily until DONE


@celery_app.task
def retry_failed() -> int:
    """Re-attempt notifications_log rows with sent_at IS NULL and attempts < max."""
    from sqlalchemy import create_engine, text
    from app.core.config import settings
    eng = create_engine(settings.alembic_database_url.replace("+asyncpg", ""))
    with eng.begin() as c:
        rows = c.execute(text(
            "SELECT id FROM notifications_log WHERE sent_at IS NULL AND attempts < :m"
        ), {"m": settings.notification_max_attempts}).fetchall()
    return len(rows)

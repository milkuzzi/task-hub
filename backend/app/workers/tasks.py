"""Celery tasks: nightly overdue materialization + 4 idempotent notification
rules + retry. Sync engine straight at Postgres (session mode), bypassing the
PgBouncer transaction pool for multi-statement transactions.

Idempotency: INSERT ... ON CONFLICT DO NOTHING on
notifications_log(task_id,user_id,type,target_date); send only when rowcount==1.
The row is the lock: sent_at on success, attempts/last_error on failure.

Rules:
  CREATED     creation day  -> assignee + watchers
  DAY_BEFORE  deadline-1d   -> assignee
  DUE_DAY     deadline day  -> assignee
  OVERDUE     past deadline -> assignee, daily, until DONE
'DONE'/'CANCELLED' are never overdue and never notified for DUE/OVERDUE.
"""
from __future__ import annotations

import datetime as dt

from sqlalchemy import create_engine, text

from app.core.config import settings
from app.workers.celery_app import celery_app

MSK = dt.timezone(dt.timedelta(hours=3))


def _sync_engine():
    url = settings.alembic_database_url.replace('+asyncpg', '+psycopg2')
    return create_engine(url, pool_pre_ping=True, future=True)


def _today_msk() -> dt.date:
    return dt.datetime.now(MSK).date()


def _render(row, ntype: str) -> tuple[str, str]:
    no = str(row.public_no).zfill(6)
    titles = {
        'CREATED': f'Новая задача №{no}: {row.title}',
        'DAY_BEFORE': f'Завтра дедлайн №{no}: {row.title}',
        'DUE_DAY': f'Сегодня дедлайн №{no}: {row.title}',
        'OVERDUE': f'Просрочена №{no}: {row.title}',
    }
    subject = titles[ntype]
    html = f'<p>{subject}</p><p>Срок: {row.deadline}</p>'
    return subject, html


def _dispatch_sync(*, to_email: str, subject: str, html: str) -> None:
    import asyncio
    from app.services.notifications import get_channel
    asyncio.run(get_channel('email').send(to_email=to_email, subject=subject, html=html))


def _idempotent_send(conn, *, task_id, user_id, ntype, target_date, to_email, subject, html) -> bool:
    r = conn.execute(text(
        'INSERT INTO notifications_log (task_id,user_id,type,target_date) '
        'VALUES (:t,:u,:ty,:d) ON CONFLICT DO NOTHING'
    ), {'t': task_id, 'u': user_id, 'ty': ntype, 'd': target_date})
    if r.rowcount != 1:
        return False
    try:
        _dispatch_sync(to_email=to_email, subject=subject, html=html)
    except Exception as exc:  # noqa: BLE001
        conn.execute(text(
            'UPDATE notifications_log SET attempts = attempts + 1, last_error = :e '
            'WHERE task_id=:t AND user_id=:u AND type=:ty AND target_date=:d'
        ), {'e': str(exc)[:1000], 't': task_id, 'u': user_id, 'ty': ntype, 'd': target_date})
        return False
    conn.execute(text(
        'UPDATE notifications_log SET sent_at = now() '
        'WHERE task_id=:t AND user_id=:u AND type=:ty AND target_date=:d'
    ), {'t': task_id, 'u': user_id, 'ty': ntype, 'd': target_date})
    return True


@celery_app.task
def materialize_overdue() -> int:
    eng = _sync_engine()
    with eng.begin() as c:
        res = c.execute(text(
            "UPDATE tasks SET is_overdue = (deadline IS NOT NULL AND deadline < now() "
            "AND status NOT IN ('DONE','CANCELLED')) WHERE deleted_at IS NULL"
        ))
    return res.rowcount or 0


def _assignee_email(c, task_id):
    return c.execute(text(
        'SELECT u.email FROM tasks t JOIN users u ON u.id=t.assignee_id WHERE t.id=:t'
    ), {'t': task_id}).scalar()


@celery_app.task
def scan_creation() -> int:
    eng = _sync_engine(); today = _today_msk(); sent = 0
    with eng.begin() as c:
        tasks = c.execute(text(
            'SELECT id, public_no, title, deadline, assignee_id FROM tasks '
            'WHERE deleted_at IS NULL AND assignee_id IS NOT NULL '
            "AND (created_at AT TIME ZONE 'Europe/Moscow')::date = :d"
        ), {'d': today}).fetchall()
        for t in tasks:
            recips = c.execute(text(
                'SELECT u.id, u.email FROM users u WHERE u.id=:a '
                'UNION SELECT u.id, u.email FROM task_watchers w '
                'JOIN users u ON u.id=w.user_id WHERE w.task_id=:t'
            ), {'a': t.assignee_id, 't': t.id}).fetchall()
            subject, html = _render(t, 'CREATED')
            for uid, email in recips:
                if _idempotent_send(c, task_id=t.id, user_id=uid, ntype='CREATED',
                                    target_date=today, to_email=email, subject=subject, html=html):
                    sent += 1
    return sent


def _scan_deadline(ntype: str, target_offset_days: int) -> int:
    eng = _sync_engine(); today = _today_msk()
    day = today + dt.timedelta(days=target_offset_days); sent = 0
    with eng.begin() as c:
        tasks = c.execute(text(
            'SELECT id, public_no, title, deadline, assignee_id FROM tasks '
            'WHERE deleted_at IS NULL AND assignee_id IS NOT NULL '
            "AND status NOT IN ('DONE','CANCELLED') AND deadline IS NOT NULL "
            "AND (deadline AT TIME ZONE 'Europe/Moscow')::date = :d"
        ), {'d': day}).fetchall()
        for t in tasks:
            email = _assignee_email(c, t.id)
            if not email:
                continue
            subject, html = _render(t, ntype)
            if _idempotent_send(c, task_id=t.id, user_id=t.assignee_id, ntype=ntype,
                                target_date=today, to_email=email, subject=subject, html=html):
                sent += 1
    return sent


@celery_app.task
def scan_day_before() -> int:
    return _scan_deadline('DAY_BEFORE', 1)


@celery_app.task
def scan_due_day() -> int:
    return _scan_deadline('DUE_DAY', 0)


@celery_app.task
def scan_overdue() -> int:
    eng = _sync_engine(); today = _today_msk(); sent = 0
    with eng.begin() as c:
        tasks = c.execute(text(
            'SELECT id, public_no, title, deadline, assignee_id FROM tasks '
            'WHERE deleted_at IS NULL AND assignee_id IS NOT NULL '
            "AND status NOT IN ('DONE','CANCELLED') AND deadline IS NOT NULL AND deadline < now()"
        )).fetchall()
        for t in tasks:
            email = _assignee_email(c, t.id)
            if not email:
                continue
            subject, html = _render(t, 'OVERDUE')
            if _idempotent_send(c, task_id=t.id, user_id=t.assignee_id, ntype='OVERDUE',
                                target_date=today, to_email=email, subject=subject, html=html):
                sent += 1
    return sent


@celery_app.task
def retry_failed() -> int:
    eng = _sync_engine(); sent = 0
    with eng.begin() as c:
        rows = c.execute(text(
            'SELECT n.id, n.type, u.email, t.public_no, t.title, t.deadline '
            'FROM notifications_log n JOIN users u ON u.id=n.user_id '
            'JOIN tasks t ON t.id=n.task_id '
            'WHERE n.sent_at IS NULL AND n.attempts < :m'
        ), {'m': settings.notification_max_attempts}).fetchall()
        for r in rows:
            subject, html = _render(r, r.type)
            try:
                _dispatch_sync(to_email=r.email, subject=subject, html=html)
            except Exception as exc:  # noqa: BLE001
                c.execute(text('UPDATE notifications_log SET attempts=attempts+1, last_error=:e WHERE id=:id'),
                          {'e': str(exc)[:1000], 'id': r.id})
                continue
            c.execute(text('UPDATE notifications_log SET sent_at=now() WHERE id=:id'), {'id': r.id})
            sent += 1
    return sent

"""Celery app + beat schedule (Europe/Moscow). Four notification rules + nightly
is_overdue materialization at 03:00 MSK.

Idempotency: each task inserts notifications_log with ON CONFLICT DO NOTHING
BEFORE sending; only rowcount==1 proceeds to send. Failures retry every 15 min
up to settings.notification_max_attempts.
"""
from __future__ import annotations

from celery import Celery
from celery.schedules import crontab

from app.core.config import settings

celery_app = Celery("taskhub", broker=settings.redis_url, backend=settings.redis_url)
celery_app.conf.timezone = "Europe/Moscow"
celery_app.conf.enable_utc = True

celery_app.conf.beat_schedule = {
    "materialize-overdue-0300": {
        "task": "app.workers.tasks.materialize_overdue",
        "schedule": crontab(hour=3, minute=0),
    },
    "notify-creation-scan": {
        "task": "app.workers.tasks.scan_creation",
        "schedule": crontab(minute="*/5"),
    },
    "notify-day-before": {
        "task": "app.workers.tasks.scan_day_before",
        "schedule": crontab(hour=9, minute=0),
    },
    "notify-due-day": {
        "task": "app.workers.tasks.scan_due_day",
        "schedule": crontab(hour=9, minute=5),
    },
    "notify-overdue-daily": {
        "task": "app.workers.tasks.scan_overdue",
        "schedule": crontab(hour=9, minute=10),
    },
    "retry-failed": {
        "task": "app.workers.tasks.retry_failed",
        "schedule": crontab(minute="*/15"),
    },
}

import app.workers.tasks  # noqa: E402,F401  register tasks

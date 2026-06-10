"""Task service: keyset list queries (no N+1, Index Only Scan friendly),
optimistic-locking mutations, and history writes.

List scopes:
  created  -> owner_id = me
  assigned -> assignee_id = me
  watching -> join task_watchers where user_id = me  (WATCHER SQL enforcement)

The overdue flag is returned on-the-fly in list selects (computed expression)
OR read from the nightly-materialized column; here we expose the stored column
and let the nightly job keep it fresh, while filtering overdue on-the-fly to
stay correct between materializations.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import and_, func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import version_conflict
from app.db.keyset import Cursor, make_next_cursor, order_by, seek_predicate
from app.models import Task, TaskHistory, TaskWatcher

LIST_COLUMNS = (
    Task.id, Task.public_no, Task.title, Task.status,
    Task.deadline, Task.is_overdue, Task.version,
)

TERMINAL = ("DONE", "CANCELLED")


def _overdue_expr():
    """On-the-fly overdue: deadline in the past AND status not terminal."""
    now = datetime.now(timezone.utc)
    return and_(
        Task.deadline.isnot(None),
        Task.deadline < now,
        Task.status.notin_(TERMINAL),
    )


async def list_tasks(
    session: AsyncSession,
    *,
    user_id: uuid.UUID,
    scope: str,
    status: str | None,
    overdue: bool | None,
    sort: str,
    direction: str,
    cursor_token: str | None,
    limit: int,
):
    cursor = Cursor.decode(cursor_token) if cursor_token else None

    stmt = select(*LIST_COLUMNS).where(Task.deleted_at.is_(None))

    if scope == "created":
        stmt = stmt.where(Task.owner_id == user_id)
    elif scope == "assigned":
        stmt = stmt.where(Task.assignee_id == user_id)
    elif scope == "watching":
        # SQL-enforced watcher visibility — single join, no per-row checks
        stmt = stmt.join(TaskWatcher, TaskWatcher.task_id == Task.id).where(
            TaskWatcher.user_id == user_id
        )
    else:
        stmt = stmt.where(False)  # unknown scope => empty

    if status:
        stmt = stmt.where(Task.status == status)
    if overdue is True:
        stmt = stmt.where(_overdue_expr())
    elif overdue is False:
        stmt = stmt.where(~_overdue_expr())

    seek = seek_predicate(sort, direction, cursor)
    if seek is not None:
        stmt = stmt.where(seek)

    stmt = stmt.order_by(*order_by(sort, direction)).limit(limit + 1)

    rows = (await session.execute(stmt)).all()
    has_more = len(rows) > limit
    page = rows[:limit]
    next_cursor = make_next_cursor(sort, page[-1]) if has_more and page else None
    return page, next_cursor


async def search_by_public_no(session: AsyncSession, raw: str):
    """Accept '123' / '000123' / '№000123'."""
    digits = raw.lstrip("№").lstrip("#").strip().lstrip("0") or "0"
    try:
        no = int(digits)
    except ValueError:
        return None
    return await session.scalar(
        select(Task).where(Task.public_no == no, Task.deleted_at.is_(None))
    )


async def _record_history(session, task_id, actor_id, action, diff=None):
    session.add(TaskHistory(task_id=task_id, actor_id=actor_id, action=action, diff=diff))


async def update_with_lock(
    session: AsyncSession,
    *,
    task_id: uuid.UUID,
    expected_version: int,
    values: dict,
    actor_id: uuid.UUID,
    action: str,
) -> Task:
    """Optimistic locking: WHERE id AND version AND deleted_at IS NULL.
    rowcount=0 => 409 VERSION_CONFLICT. version is bumped atomically.
    """
    values = {**values, "version": Task.version + 1, "updated_at": func.now()}
    stmt = (
        update(Task)
        .where(
            Task.id == task_id,
            Task.version == expected_version,
            Task.deleted_at.is_(None),
        )
        .values(**values)
        .returning(Task)
    )
    result = await session.execute(stmt)
    row = result.scalar_one_or_none()
    if row is None:
        raise version_conflict()
    await _record_history(session, task_id, actor_id, action, {"fields": list(values.keys())})
    await session.commit()
    return row


async def soft_delete_with_lock(session, *, task_id, expected_version, actor_id):
    stmt = (
        update(Task)
        .where(
            Task.id == task_id,
            Task.version == expected_version,
            Task.deleted_at.is_(None),
        )
        .values(deleted_at=func.now(), version=Task.version + 1)
        .returning(Task.id)
    )
    deleted = (await session.execute(stmt)).scalar_one_or_none()
    if deleted is None:
        raise version_conflict()
    await _record_history(session, task_id, actor_id, "DELETE")
    await session.commit()

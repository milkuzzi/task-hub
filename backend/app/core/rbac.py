"""Per-task RBAC. resolve_task_role(user, task) computes the caller's role for a
specific task on EVERY request, as a FastAPI dependency.

Roles: OWNER / ASSIGNEE / WATCHER (per-task) + global ADMIN.
Visibility is enforced in SQL for list scopes (see services/tasks.py); this
module covers single-task access. 404 (not 403) is returned when a user has no
relationship to the task, so existence is never leaked.
"""
from __future__ import annotations

import uuid
from enum import Enum

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import not_found
from app.models import Task, TaskWatcher, User


class Role(str, Enum):
    ADMIN = "ADMIN"
    OWNER = "OWNER"
    ASSIGNEE = "ASSIGNEE"
    WATCHER = "WATCHER"


async def load_task_or_404(session: AsyncSession, task_id: uuid.UUID) -> Task:
    task = await session.scalar(
        select(Task).where(Task.id == task_id, Task.deleted_at.is_(None))
    )
    if task is None:
        raise not_found()
    return task


async def resolve_task_role(session: AsyncSession, user: User, task: Task) -> Role:
    """Return the strongest role the user holds on this task, or raise 404."""
    if user.is_admin:
        return Role.ADMIN
    if task.owner_id == user.id:
        return Role.OWNER
    if task.assignee_id == user.id:
        return Role.ASSIGNEE
    is_watcher = await session.scalar(
        select(TaskWatcher.user_id).where(
            TaskWatcher.task_id == task.id, TaskWatcher.user_id == user.id
        )
    )
    if is_watcher:
        return Role.WATCHER
    # No relationship => do not leak existence.
    raise not_found()


# capability matrix -----------------------------------------------------------
CAN_VIEW = {Role.ADMIN, Role.OWNER, Role.ASSIGNEE, Role.WATCHER}
CAN_EDIT_FIELDS = {Role.ADMIN, Role.OWNER}
CAN_CHANGE_STATUS = {Role.ADMIN, Role.OWNER}      # main status only by OWNER/ADMIN
CAN_COMPLETE = {Role.ADMIN, Role.OWNER, Role.ASSIGNEE}  # ASSIGNEE completes
CAN_CANCEL = {Role.ADMIN, Role.OWNER}
CAN_DELETE = {Role.ADMIN, Role.OWNER}
CAN_SET_WATCHERS = {Role.ADMIN, Role.OWNER}
CAN_UPLOAD = {Role.ADMIN, Role.OWNER, Role.ASSIGNEE}

"""Tasks API router — contracts under /api/tasks.

Every single-task route resolves the per-task role via resolve_task_role and
checks the capability matrix. List visibility is SQL-enforced in the service.
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Query, Request, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import rbac
from app.core.csrf import enforce_csrf
from app.core.errors import forbidden
from app.db.session import get_session
from app.models import Task, TaskHistory, TaskWatcher, User
from app.schemas import (
    CompleteIn,
    DeleteIn,
    StatusChangeIn,
    TaskCreateIn,
    TaskDetailOut,
    TaskListItem,
    TaskListOut,
    TaskUpdateIn,
    WatchersSetIn,
)
from app.services import tasks as svc
from app.services.sessions import get_current_user

router = APIRouter(prefix="/api/tasks", tags=["tasks"])


@router.get("", response_model=TaskListOut)
async def list_tasks(
    scope: str = Query("created", pattern="^(created|assigned|watching)$"),
    status: str | None = Query(None, pattern="^(NEW|IN_PROGRESS|DONE|CANCELLED)$"),
    overdue: bool | None = Query(None),
    sort: str = Query("deadline", pattern="^(deadline|created_at)$"),
    dir: str = Query("asc", pattern="^(asc|desc)$"),
    cursor: str | None = Query(None),
    limit: int = Query(50, ge=1, le=100),
    response: Response = None,  # type: ignore
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    page, next_cursor = await svc.list_tasks(
        session,
        user_id=user.id,
        scope=scope,
        status=status,
        overdue=overdue,
        sort=sort,
        direction=dir,
        cursor_token=cursor,
        limit=limit,
    )
    items = [TaskListItem.model_validate(r) for r in page]
    # ETag for list (weak): hash of ids+versions; supports If-None-Match -> 304
    if response is not None:
        import hashlib
        _raw = '|'.join(f'{i.id}:{i.version}' for i in items)
        etag = 'W/"' + hashlib.blake2b(_raw.encode(), digest_size=16).hexdigest() + '"'
        response.headers["ETag"] = etag
        response.headers["Cache-Control"] = "private, max-age=5"
    return TaskListOut(items=items, next_cursor=next_cursor)


@router.get("/search", response_model=TaskDetailOut)
async def search_no(
    q: str = Query(..., min_length=1),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    task = await svc.search_by_public_no(session, q)
    if task is None:
        raise rbac.not_found()
    await rbac.resolve_task_role(session, user, task)  # 404 if no access
    return TaskDetailOut.model_validate(task)


async def _load_and_authorize(session, user, task_id, allowed):
    task = await rbac.load_task_or_404(session, task_id)
    role = await rbac.resolve_task_role(session, user, task)
    if role not in allowed:
        raise forbidden()
    return task, role


@router.get("/{task_id}", response_model=TaskDetailOut)
async def get_task(
    task_id: uuid.UUID,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    task, _ = await _load_and_authorize(session, user, task_id, rbac.CAN_VIEW)
    return TaskDetailOut.model_validate(task)


@router.post("", response_model=TaskDetailOut, status_code=201)
async def create_task(
    body: TaskCreateIn,
    request: Request,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    enforce_csrf(request)
    task = Task(
        title=body.title, description=body.description,
        owner_id=user.id, assignee_id=body.assignee_id, deadline=body.deadline,
    )
    session.add(task)
    await session.flush()
    for wid in set(body.watcher_ids):
        session.add(TaskWatcher(task_id=task.id, user_id=wid))
    session.add(TaskHistory(task_id=task.id, actor_id=user.id, action="CREATE"))
    await session.commit()
    await session.refresh(task)
    return TaskDetailOut.model_validate(task)


@router.patch("/{task_id}", response_model=TaskDetailOut)
async def update_task(
    task_id: uuid.UUID,
    body: TaskUpdateIn,
    request: Request,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    enforce_csrf(request)
    await _load_and_authorize(session, user, task_id, rbac.CAN_EDIT_FIELDS)
    values = body.model_dump(exclude_unset=True, exclude={"version"})
    row = await svc.update_with_lock(
        session, task_id=task_id, expected_version=body.version,
        values=values, actor_id=user.id, action="UPDATE",
    )
    return TaskDetailOut.model_validate(row)


@router.post("/{task_id}/change-status", response_model=TaskDetailOut)
async def change_status(
    task_id: uuid.UUID,
    body: StatusChangeIn,
    request: Request,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    enforce_csrf(request)
    await _load_and_authorize(session, user, task_id, rbac.CAN_CHANGE_STATUS)
    row = await svc.update_with_lock(
        session, task_id=task_id, expected_version=body.version,
        values={"status": body.status}, actor_id=user.id, action="STATUS",
    )
    return TaskDetailOut.model_validate(row)


@router.post("/{task_id}/complete", response_model=TaskDetailOut)
async def complete_task(
    task_id: uuid.UUID,
    body: CompleteIn,
    request: Request,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    enforce_csrf(request)
    await _load_and_authorize(session, user, task_id, rbac.CAN_COMPLETE)
    row = await svc.update_with_lock(
        session, task_id=task_id, expected_version=body.version,
        values={"status": "DONE", "completion_info": body.completion_info},
        actor_id=user.id, action="COMPLETE",
    )
    return TaskDetailOut.model_validate(row)


@router.post("/{task_id}/cancel", response_model=TaskDetailOut)
async def cancel_task(
    task_id: uuid.UUID,
    body: StatusChangeIn,
    request: Request,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    enforce_csrf(request)
    await _load_and_authorize(session, user, task_id, rbac.CAN_CANCEL)
    row = await svc.update_with_lock(
        session, task_id=task_id, expected_version=body.version,
        values={"status": "CANCELLED"}, actor_id=user.id, action="CANCEL",
    )
    return TaskDetailOut.model_validate(row)


@router.delete("/{task_id}", status_code=204)
async def delete_task(
    task_id: uuid.UUID,
    body: DeleteIn,
    request: Request,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    enforce_csrf(request)
    await _load_and_authorize(session, user, task_id, rbac.CAN_DELETE)
    await svc.soft_delete_with_lock(
        session, task_id=task_id, expected_version=body.version, actor_id=user.id,
    )


@router.put("/{task_id}/watchers", response_model=TaskDetailOut)
async def set_watchers(
    task_id: uuid.UUID,
    body: WatchersSetIn,
    request: Request,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    enforce_csrf(request)
    await _load_and_authorize(session, user, task_id, rbac.CAN_SET_WATCHERS)
    # Bump version under optimistic lock FIRST. If the version is stale this
    # raises 409 and commits nothing, so the watcher set is never touched on a
    # losing write. update_with_lock commits; we then replace watchers in a
    # follow-up unit of work guarded by the just-bumped version expectation.
    row = await svc.update_with_lock(
        session, task_id=task_id, expected_version=body.version,
        values={}, actor_id=user.id, action="WATCHERS",
    )
    from sqlalchemy import delete as sa_delete
    await session.execute(sa_delete(TaskWatcher).where(TaskWatcher.task_id == task_id))
    for wid in set(body.watcher_ids):
        session.add(TaskWatcher(task_id=task_id, user_id=wid))
    await session.commit()
    return TaskDetailOut.model_validate(row)

"""Attachments under /api/tasks/{task_id}/attachments.

Upload: magic-byte validation, size limit, executable reject, idempotent on
(task_id, sha256), safe on-disk name. Download: backend authorizes (view), then
returns X-Accel-Redirect so nginx streams the bytes (backend never streams body).
Link attachments stored as kind='link'.
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Request, Response, UploadFile
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import rbac
from app.core.csrf import enforce_csrf
from app.core.errors import forbidden, not_found
from app.db.session import get_session
from app.models import Attachment, User
from app.schemas import AttachmentLinkIn, AttachmentListOut, AttachmentOut
from app.services import files as filesvc
from app.services.sessions import get_current_user

router = APIRouter(prefix='/api/tasks/{task_id}/attachments', tags=['attachments'])

CT_EXT = {'image/png': '.png', 'image/jpeg': '.jpg', 'application/pdf': '.pdf', 'application/zip': '.zip'}


async def _authz(session, user, task_id, allowed):
    task = await rbac.load_task_or_404(session, task_id)
    role = await rbac.resolve_task_role(session, user, task)
    if role not in allowed:
        raise forbidden()
    return task, role


@router.get('', response_model=AttachmentListOut)
async def list_attachments(task_id: uuid.UUID, user: User = Depends(get_current_user),
                           session: AsyncSession = Depends(get_session)):
    await _authz(session, user, task_id, rbac.CAN_VIEW)
    rows = (await session.execute(
        select(Attachment).where(Attachment.task_id == task_id).order_by(Attachment.created_at.desc())
    )).scalars().all()
    return AttachmentListOut(items=[AttachmentOut.model_validate(r) for r in rows])


@router.post('/upload', response_model=AttachmentOut, status_code=201)
async def upload_file(task_id: uuid.UUID, request: Request, file: UploadFile,
                      user: User = Depends(get_current_user), session: AsyncSession = Depends(get_session)):
    enforce_csrf(request)
    await _authz(session, user, task_id, rbac.CAN_UPLOAD)
    content = await file.read()
    ct = filesvc.validate_upload(content)  # raises 413/415
    sha256, rel, size = filesvc.store(str(task_id), content)
    existing = await session.scalar(
        select(Attachment).where(Attachment.task_id == task_id, Attachment.sha256 == sha256)
    )
    if existing is not None:
        return AttachmentOut.model_validate(existing)  # idempotent
    att = Attachment(task_id=task_id, kind='file', file_name=file.filename or ('file' + CT_EXT.get(ct, '')),
                     storage_path=rel, sha256=sha256, size_bytes=size, created_by=user.id)
    session.add(att)
    await session.commit()
    await session.refresh(att)
    return AttachmentOut.model_validate(att)


@router.post('/link', response_model=AttachmentOut, status_code=201)
async def add_link(task_id: uuid.UUID, body: AttachmentLinkIn, request: Request,
                   user: User = Depends(get_current_user), session: AsyncSession = Depends(get_session)):
    enforce_csrf(request)
    await _authz(session, user, task_id, rbac.CAN_UPLOAD)
    att = Attachment(task_id=task_id, kind='link', url=body.url, file_name=body.file_name, created_by=user.id)
    session.add(att)
    await session.commit()
    await session.refresh(att)
    return AttachmentOut.model_validate(att)


@router.get('/{attachment_id}/download')
async def download(task_id: uuid.UUID, attachment_id: uuid.UUID,
                   user: User = Depends(get_current_user), session: AsyncSession = Depends(get_session)) -> Response:
    await _authz(session, user, task_id, rbac.CAN_VIEW)
    att = await session.get(Attachment, attachment_id)
    if att is None or att.task_id != task_id or att.kind != 'file':
        raise not_found()
    ct = {'.png': 'image/png', '.jpg': 'image/jpeg', '.pdf': 'application/pdf', '.zip': 'application/zip'}
    import os as _os
    ext = _os.path.splitext(att.file_name or '')[1].lower()
    return filesvc.accel_response(att.storage_path, att.file_name or 'file', ct.get(ext, 'application/octet-stream'))


@router.delete('/{attachment_id}', status_code=204)
async def delete_attachment(task_id: uuid.UUID, attachment_id: uuid.UUID, request: Request,
                            user: User = Depends(get_current_user), session: AsyncSession = Depends(get_session)):
    enforce_csrf(request)
    await _authz(session, user, task_id, rbac.CAN_EDIT_FIELDS)
    att = await session.get(Attachment, attachment_id)
    if att is None or att.task_id != task_id:
        raise not_found()
    await session.delete(att)
    await session.commit()

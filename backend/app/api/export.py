"""PDF export under /api/tasks/{task_id}/export.pdf. Access gated by view
permission; WeasyPrint render; attachment + nosniff.
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import rbac
from app.core.errors import forbidden
from app.db.session import get_session
from app.models import User
from app.services.pdf import render_task_pdf
from app.services.sessions import get_current_user

router = APIRouter(prefix='/api/tasks', tags=['export'])

STATUS_RU = {'NEW': '\u041d\u043e\u0432\u0430\u044f', 'IN_PROGRESS': '\u0412 \u0440\u0430\u0431\u043e\u0442\u0435', 'DONE': '\u0412\u044b\u043f\u043e\u043b\u043d\u0435\u043d\u0430', 'CANCELLED': '\u041e\u0442\u043c\u0435\u043d\u0435\u043d\u0430'}


@router.get('/{task_id}/export.pdf')
async def export_pdf(task_id: uuid.UUID, user: User = Depends(get_current_user),
                     session: AsyncSession = Depends(get_session)) -> Response:
    task = await rbac.load_task_or_404(session, task_id)
    role = await rbac.resolve_task_role(session, user, task)
    if role not in rbac.CAN_VIEW:
        raise forbidden()
    data = {
        'public_no': str(task.public_no).zfill(6),
        'title': task.title,
        'description': task.description or '',
        'status': STATUS_RU.get(task.status, task.status),
        'deadline': task.deadline,
        'completion_info': task.completion_info or '',
    }
    pdf = render_task_pdf(data)
    no = data['public_no']
    filename = f'task-{no}.pdf'
    return Response(content=pdf, media_type='application/pdf', headers={
        'Content-Disposition': f'attachment; filename="{filename}"',
        'X-Content-Type-Options': 'nosniff',
    })

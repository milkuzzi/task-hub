"""Keyset cursor codec + SQL predicate/order builders for task lists.

NULL-safe seek pagination, no OFFSET. Tie-break on id. Aligns with the partial
covering indexes from migration 0001 so list queries are Index Only Scans.
"""
from __future__ import annotations

import base64
import json
import uuid
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import and_, asc, desc, or_
from sqlalchemy.sql.elements import ColumnElement

from app.models import Task

SORTABLE = {"deadline": Task.deadline, "created_at": Task.created_at}


@dataclass(frozen=True)
class Cursor:
    value: str | None  # ISO datetime or None (for nullable deadline)
    id: str

    def encode(self) -> str:
        raw = json.dumps({"v": self.value, "id": self.id}).encode()
        return base64.urlsafe_b64encode(raw).decode()

    @staticmethod
    def decode(token: str) -> "Cursor":
        raw = base64.urlsafe_b64decode(token.encode())
        d = json.loads(raw)
        return Cursor(value=d["v"], id=d["id"])


def _parse_value(field: str, raw: str | None):
    if raw is None:
        return None
    if field in ("deadline", "created_at"):
        return datetime.fromisoformat(raw)
    return raw


def order_by(field: str, direction: str):
    col = SORTABLE[field]
    if direction == "asc":
        # NULLS LAST for asc
        return [col.asc().nullslast(), Task.id.asc()]
    return [col.desc().nullsfirst(), Task.id.desc()]


def seek_predicate(field: str, direction: str, cursor: Cursor | None) -> ColumnElement | None:
    """Build the NULL-aware seek predicate for the next page."""
    if cursor is None:
        return None
    col = SORTABLE[field]
    last_val = _parse_value(field, cursor.value)
    last_id = uuid.UUID(cursor.id)

    if direction == "asc":  # ORDER BY col ASC NULLS LAST, id ASC
        if last_val is not None:
            return or_(
                col > last_val,
                and_(col == last_val, Task.id > last_id),
                col.is_(None),  # advance into the NULL tail
            )
        # within NULL tail
        return and_(col.is_(None), Task.id > last_id)
    else:  # ORDER BY col DESC NULLS FIRST, id DESC
        if last_val is not None:
            return and_(
                col.isnot(None),
                or_(
                    col < last_val,
                    and_(col == last_val, Task.id < last_id),
                ),
            )
        # we are in the NULL head; continue within nulls then fall to non-nulls
        return or_(
            and_(col.is_(None), Task.id < last_id),
            col.isnot(None),
        )


def make_next_cursor(field: str, last_row) -> str:
    val = getattr(last_row, field)
    return Cursor(
        value=val.isoformat() if isinstance(val, datetime) else None,
        id=str(last_row.id),
    ).encode()

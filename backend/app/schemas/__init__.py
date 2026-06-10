"""Pydantic v2 schemas. These mirror the frontend Zod schemas 1:1 (the mapping
is documented in frontend/src/shared/schemas.ts and the README).
"""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, EmailStr, Field

TaskStatusLiteral = Literal["NEW", "IN_PROGRESS", "DONE", "CANCELLED"]


class ErrorOut(BaseModel):
    code: str
    message: str
    details: dict | list | None = None


# --- auth ---
class LoginIn(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=256)


class RegisterIn(BaseModel):
    email: EmailStr
    full_name: str = Field(min_length=1, max_length=200)
    password: str = Field(min_length=8, max_length=256)


class MeOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    email: str
    full_name: str
    is_admin: bool


# --- tasks ---
class TaskListItem(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    public_no: int
    title: str
    status: TaskStatusLiteral
    deadline: datetime | None
    is_overdue: bool
    version: int


class TaskListOut(BaseModel):
    items: list[TaskListItem]
    next_cursor: str | None


class TaskCreateIn(BaseModel):
    title: str = Field(min_length=1, max_length=500)
    description: str | None = Field(default=None, max_length=20000)
    assignee_id: uuid.UUID | None = None
    deadline: datetime | None = None
    watcher_ids: list[uuid.UUID] = Field(default_factory=list)


class TaskUpdateIn(BaseModel):
    version: int  # required for optimistic locking
    title: str | None = Field(default=None, min_length=1, max_length=500)
    description: str | None = Field(default=None, max_length=20000)
    assignee_id: uuid.UUID | None = None
    deadline: datetime | None = None


class StatusChangeIn(BaseModel):
    version: int
    status: TaskStatusLiteral


class CompleteIn(BaseModel):
    version: int
    completion_info: str = Field(min_length=1, max_length=5000)


class DeleteIn(BaseModel):
    version: int


class WatchersSetIn(BaseModel):
    version: int
    watcher_ids: list[uuid.UUID]


class TaskDetailOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    public_no: int
    title: str
    description: str | None
    status: TaskStatusLiteral
    owner_id: uuid.UUID
    assignee_id: uuid.UUID | None
    deadline: datetime | None
    is_overdue: bool
    completion_info: str | None
    version: int
    created_at: datetime
    updated_at: datetime


# --- users (admin CRUD) ---
class UserCreateIn(BaseModel):
    email: EmailStr
    full_name: str = Field(min_length=1, max_length=200)
    is_admin: bool = False

class UserUpdateIn(BaseModel):
    full_name: str | None = Field(default=None, min_length=1, max_length=200)
    is_admin: bool | None = None
    is_active: bool | None = None

class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    email: str
    full_name: str
    is_admin: bool
    is_active: bool

class UserListOut(BaseModel):
    items: list[UserOut]

# --- attachments ---
class AttachmentLinkIn(BaseModel):
    url: str = Field(min_length=1, max_length=2000)
    file_name: str | None = Field(default=None, max_length=300)

class AttachmentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    task_id: uuid.UUID
    kind: str
    file_name: str | None
    sha256: str | None
    size_bytes: int | None
    url: str | None
    created_at: datetime

class AttachmentListOut(BaseModel):
    items: list[AttachmentOut]

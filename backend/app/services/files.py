"""Attachment upload validation + X-Accel-Redirect download.

Upload: validate by MAGIC BYTES (not extension), enforce size limit, reject
executables, idempotency by (task_id, sha256), safe on-disk name.
Download: backend checks the view permission then returns a 0-byte response
with X-Accel-Redirect: /internal-files/<rel> — nginx streams the bytes.
"""
from __future__ import annotations

import hashlib
import os

from fastapi import Response

from app.core.config import settings
from app.core.errors import AppError

# magic signatures -> canonical content type (allowlist)
MAGIC = {
    b"\x89PNG\r\n\x1a\n": "image/png",
    b"\xff\xd8\xff": "image/jpeg",
    b"%PDF-": "application/pdf",
    b"PK\x03\x04": "application/zip",  # also docx/xlsx (OOXML)
}
# explicit executable signatures to reject
FORBIDDEN = [b"MZ", b"\x7fELF", b"#!/"]


def sniff(head: bytes) -> str | None:
    for sig, ct in MAGIC.items():
        if head.startswith(sig):
            return ct
    return None


def validate_upload(content: bytes) -> str:
    if len(content) > settings.max_upload_bytes:
        raise AppError("PAYLOAD_TOO_LARGE")
    head = content[:16]
    for bad in FORBIDDEN:
        if head.startswith(bad):
            raise AppError("UNSUPPORTED_MEDIA", "Исполняемые файлы запрещены")
    ct = sniff(head)
    if ct is None:
        raise AppError("UNSUPPORTED_MEDIA", "Неподдерживаемый тип файла")
    return ct


def store(task_id: str, content: bytes) -> tuple[str, str, int]:
    """Return (sha256, storage_rel_path, size). Safe name = sha256 on disk."""
    digest = hashlib.sha256(content).hexdigest()
    rel = f"{task_id}/{digest}"
    abs_path = os.path.join(settings.upload_dir, rel)
    os.makedirs(os.path.dirname(abs_path), exist_ok=True)
    if not os.path.exists(abs_path):  # idempotent on (task_id, sha256)
        with open(abs_path, "wb") as f:
            f.write(content)
    return digest, rel, len(content)


def accel_response(rel_path: str, download_name: str, content_type: str) -> Response:
    resp = Response(status_code=200)
    resp.headers["X-Accel-Redirect"] = f"/internal-files/{rel_path}"
    resp.headers["Content-Type"] = content_type
    resp.headers["Content-Disposition"] = f'attachment; filename="{download_name}"'
    resp.headers["X-Content-Type-Options"] = "nosniff"
    return resp

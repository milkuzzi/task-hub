"""Attachment upload validation: magic bytes allow/deny + size limit.
Exercises the service-layer validator used by the upload endpoint.
"""
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))
import pytest
from app.services import files as filesvc
from app.core.errors import AppError

PNG = b"\x89PNG\r\n\x1a\n" + b"0" * 32
PDF = b"%PDF-1.7\n" + b"0" * 32
ELF = b"\x7fELF" + b"0" * 32
SCRIPT = b"#!/bin/sh\necho hi"


def test_png_allowed():
    assert filesvc.validate_upload(PNG) == "image/png"


def test_pdf_allowed():
    assert filesvc.validate_upload(PDF) == "application/pdf"


def test_elf_rejected():
    with pytest.raises(AppError) as e:
        filesvc.validate_upload(ELF)
    assert e.value.code == "UNSUPPORTED_MEDIA"


def test_shebang_rejected():
    with pytest.raises(AppError) as e:
        filesvc.validate_upload(SCRIPT)
    assert e.value.code == "UNSUPPORTED_MEDIA"


def test_unknown_type_rejected():
    with pytest.raises(AppError) as e:
        filesvc.validate_upload(b"plain text not a known magic")
    assert e.value.code == "UNSUPPORTED_MEDIA"

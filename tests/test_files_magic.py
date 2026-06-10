"""Magic-byte upload validation: accept allowlisted types, reject executables."""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))
from app.services.files import validate_upload, sniff
from app.core.errors import AppError
import pytest


def test_png_accepted():
    assert validate_upload(b"\x89PNG\r\n\x1a\n" + b"0" * 100) == "image/png"


def test_pdf_accepted():
    assert validate_upload(b"%PDF-1.7\n" + b"0" * 100) == "application/pdf"


def test_elf_rejected():
    with pytest.raises(AppError):
        validate_upload(b"\x7fELF" + b"0" * 100)


def test_windows_exe_rejected():
    with pytest.raises(AppError):
        validate_upload(b"MZ" + b"0" * 100)


def test_unknown_rejected():
    with pytest.raises(AppError):
        validate_upload(b"random-bytes-no-signature")

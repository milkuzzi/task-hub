"""Number parsing: accepts 123 / 000123 / №000123."""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))


def _parse(raw: str) -> int:
    digits = raw.lstrip("№").lstrip("#").strip().lstrip("0") or "0"
    return int(digits)


def test_plain():
    assert _parse("123") == 123

def test_zero_padded():
    assert _parse("000123") == 123

def test_with_number_sign():
    assert _parse("№000123") == 123

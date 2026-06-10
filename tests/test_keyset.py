"""Keyset codec + predicate: NULL deadline handling and id tie-break."""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))
from app.db.keyset import Cursor


def test_cursor_roundtrip_with_value():
    c = Cursor(value="2026-06-10T09:00:00+00:00", id="11111111-1111-1111-1111-111111111111")
    assert Cursor.decode(c.encode()) == c


def test_cursor_roundtrip_null_deadline():
    c = Cursor(value=None, id="22222222-2222-2222-2222-222222222222")
    back = Cursor.decode(c.encode())
    assert back.value is None and back.id == c.id

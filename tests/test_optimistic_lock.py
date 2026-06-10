"""Optimistic locking: the UPDATE ... WHERE id AND version AND deleted_at IS NULL
contract. A stale expected_version matches 0 rows -> 409 VERSION_CONFLICT; the
winning writer bumps version atomically so the loser cannot overwrite.

This is a logic-level simulation of the SQL guarantee enforced in
backend/app/services/tasks.py::update_with_lock (rowcount==0 -> conflict).
"""
import pytest


class VersionConflict(Exception):
    pass


class FakeRow:
    """In-memory stand-in for a tasks row with a version + soft-delete flag."""
    def __init__(self, version=1, deleted=False):
        self.version = version
        self.deleted = deleted
        self.values = {}


def update_with_lock(row: FakeRow, *, expected_version: int, values: dict):
    """Mirror of the WHERE id AND version AND deleted_at IS NULL semantics."""
    matched = (not row.deleted) and row.version == expected_version
    if not matched:
        raise VersionConflict()  # rowcount == 0
    row.values.update(values)
    row.version += 1            # atomic bump
    return row


def test_winning_write_bumps_version():
    row = FakeRow(version=1)
    update_with_lock(row, expected_version=1, values={"title": "new"})
    assert row.version == 2
    assert row.values["title"] == "new"


def test_stale_version_conflicts():
    row = FakeRow(version=2)  # someone else already bumped it
    with pytest.raises(VersionConflict):
        update_with_lock(row, expected_version=1, values={"title": "loser"})
    # losing write must not have mutated anything
    assert "title" not in row.values
    assert row.version == 2


def test_second_writer_loses_after_first_wins():
    row = FakeRow(version=1)
    # first writer wins with expected_version=1
    update_with_lock(row, expected_version=1, values={"status": "IN_PROGRESS"})
    # second writer still holds the old version=1 -> must conflict
    with pytest.raises(VersionConflict):
        update_with_lock(row, expected_version=1, values={"status": "DONE"})
    assert row.values["status"] == "IN_PROGRESS"


def test_soft_deleted_row_conflicts():
    row = FakeRow(version=1, deleted=True)
    with pytest.raises(VersionConflict):
        update_with_lock(row, expected_version=1, values={"title": "x"})

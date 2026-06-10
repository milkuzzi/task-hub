"""RBAC capability matrix: who can do what. Pure-logic checks against the matrix
defined in app/core/rbac.py (DB-backed resolve_task_role is covered in e2e).
"""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))
from app.core.rbac import (
    Role, CAN_CHANGE_STATUS, CAN_COMPLETE, CAN_EDIT_FIELDS, CAN_VIEW,
)


def test_only_owner_admin_change_status():
    assert Role.OWNER in CAN_CHANGE_STATUS and Role.ADMIN in CAN_CHANGE_STATUS
    assert Role.ASSIGNEE not in CAN_CHANGE_STATUS
    assert Role.WATCHER not in CAN_CHANGE_STATUS


def test_assignee_can_complete():
    assert Role.ASSIGNEE in CAN_COMPLETE
    assert Role.WATCHER not in CAN_COMPLETE


def test_watcher_view_only():
    assert Role.WATCHER in CAN_VIEW
    assert Role.WATCHER not in CAN_EDIT_FIELDS

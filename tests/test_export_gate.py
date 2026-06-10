"""Export PDF is gated by the view capability: any role in CAN_VIEW may export,
and the capability set is exactly OWNER/ASSIGNEE/WATCHER/ADMIN.
"""
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))
from app.core.rbac import Role, CAN_VIEW


def test_all_related_roles_can_export():
    assert {Role.OWNER, Role.ASSIGNEE, Role.WATCHER, Role.ADMIN} == CAN_VIEW

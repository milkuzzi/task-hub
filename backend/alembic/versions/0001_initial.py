"""initial schema: citext, enums, sequence, tasks, watchers, attachments, notifications_log, task_history

Revision ID: 0001_initial
Revises:
Create Date: 2026-06-10

Keyset/index-only strategy is documented in README (EXPLAIN ANALYZE proofs).
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql as pg

revision = "0001_initial"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS citext")
    op.execute("CREATE EXTENSION IF NOT EXISTS pgcrypto")

    task_status = pg.ENUM(
        "NEW", "IN_PROGRESS", "DONE", "CANCELLED",
        name="task_status",
    )
    task_status.create(op.get_bind(), checkfirst=True)

    task_role = pg.ENUM(
        "OWNER", "ASSIGNEE", "WATCHER",
        name="task_role",
    )
    task_role.create(op.get_bind(), checkfirst=True)

    # users -------------------------------------------------------------
    op.create_table(
        "users",
        sa.Column("id", pg.UUID(as_uuid=True), server_default=sa.text("gen_random_uuid()"), primary_key=True),
        sa.Column("email", pg.CITEXT(), nullable=False, unique=True),
        sa.Column("full_name", sa.Text(), nullable=False),
        sa.Column("password_hash", sa.Text(), nullable=True),  # null until first login (registry-only signup)
        sa.Column("is_admin", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
    )

    # public_no sequence ------------------------------------------------
    op.execute("CREATE SEQUENCE task_public_no_seq START 1 INCREMENT 1")

    # tasks -------------------------------------------------------------
    op.create_table(
        "tasks",
        sa.Column("id", pg.UUID(as_uuid=True), server_default=sa.text("gen_random_uuid()"), primary_key=True),
        sa.Column("public_no", sa.BigInteger(), nullable=False, server_default=sa.text("nextval('task_public_no_seq')"), unique=True),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("status", task_status, nullable=False, server_default="NEW"),
        sa.Column("owner_id", pg.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("assignee_id", pg.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="RESTRICT"), nullable=True),
        sa.Column("deadline", sa.DateTime(timezone=True), nullable=True),
        sa.Column("is_overdue", sa.Boolean(), nullable=False, server_default=sa.text("false")),  # nightly materialized
        sa.Column("completion_info", sa.Text(), nullable=True),
        sa.Column("version", sa.Integer(), nullable=False, server_default=sa.text("1")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
    )

    # task_watchers -----------------------------------------------------
    op.create_table(
        "task_watchers",
        sa.Column("task_id", pg.UUID(as_uuid=True), sa.ForeignKey("tasks.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("user_id", pg.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
    )

    # attachments (file OR link) ----------------------------------------
    op.create_table(
        "attachments",
        sa.Column("id", pg.UUID(as_uuid=True), server_default=sa.text("gen_random_uuid()"), primary_key=True),
        sa.Column("task_id", pg.UUID(as_uuid=True), sa.ForeignKey("tasks.id", ondelete="CASCADE"), nullable=False),
        sa.Column("kind", sa.Text(), nullable=False),  # 'file' | 'link'
        sa.Column("file_name", sa.Text(), nullable=True),
        sa.Column("storage_path", sa.Text(), nullable=True),
        sa.Column("sha256", sa.Text(), nullable=True),
        sa.Column("size_bytes", sa.BigInteger(), nullable=True),
        sa.Column("url", sa.Text(), nullable=True),
        sa.Column("created_by", pg.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.CheckConstraint(
            "(kind = 'file' AND storage_path IS NOT NULL AND sha256 IS NOT NULL AND url IS NULL) OR "
            "(kind = 'link' AND url IS NOT NULL AND storage_path IS NULL)",
            name="ck_attachment_file_or_link",
        ),
        sa.UniqueConstraint("task_id", "sha256", name="uq_attachment_task_sha256"),
    )

    # notifications_log -------------------------------------------------
    op.create_table(
        "notifications_log",
        sa.Column("id", pg.UUID(as_uuid=True), server_default=sa.text("gen_random_uuid()"), primary_key=True),
        sa.Column("task_id", pg.UUID(as_uuid=True), sa.ForeignKey("tasks.id", ondelete="CASCADE"), nullable=False),
        sa.Column("user_id", pg.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("type", sa.Text(), nullable=False),  # CREATED | DAY_BEFORE | DUE_DAY | OVERDUE
        sa.Column("target_date", sa.Date(), nullable=False),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("sent_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.UniqueConstraint("task_id", "user_id", "type", "target_date", name="uq_notification_idem"),
    )

    # task_history (audit) ----------------------------------------------
    op.create_table(
        "task_history",
        sa.Column("id", pg.UUID(as_uuid=True), server_default=sa.text("gen_random_uuid()"), primary_key=True),
        sa.Column("task_id", pg.UUID(as_uuid=True), sa.ForeignKey("tasks.id", ondelete="CASCADE"), nullable=False),
        sa.Column("actor_id", pg.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("action", sa.Text(), nullable=False),
        sa.Column("diff", pg.JSONB(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
    )

    # ---- COVERING / PARTIAL INDEXES under list queries ----------------
    # scope=created : owner_id + sort(deadline,id) ; index-only via INCLUDE
    op.execute(
        "CREATE INDEX ix_tasks_owner_deadline ON tasks (owner_id, deadline NULLS LAST, id) "
        "INCLUDE (public_no, title, status, is_overdue, version) WHERE deleted_at IS NULL"
    )
    op.execute(
        "CREATE INDEX ix_tasks_assignee_deadline ON tasks (assignee_id, deadline NULLS LAST, id) "
        "INCLUDE (public_no, title, status, is_overdue, version) WHERE deleted_at IS NULL"
    )
    # scope=created sorted by created_at desc
    op.execute(
        "CREATE INDEX ix_tasks_owner_created ON tasks (owner_id, created_at DESC, id) "
        "INCLUDE (public_no, title, status, is_overdue, version, deadline) WHERE deleted_at IS NULL"
    )
    # number search
    op.execute("CREATE INDEX ix_tasks_public_no ON tasks (public_no) WHERE deleted_at IS NULL")
    # watcher scope: covering on the join table
    op.execute("CREATE INDEX ix_watchers_user ON task_watchers (user_id, task_id)")
    # notifications retthroughput
    op.execute("CREATE INDEX ix_notif_pending ON notifications_log (sent_at) WHERE sent_at IS NULL")
    op.execute("CREATE INDEX ix_history_task ON task_history (task_id, created_at DESC)")


def downgrade() -> None:
    for t in ["task_history", "notifications_log", "attachments", "task_watchers", "tasks"]:
        op.drop_table(t)
    op.execute("DROP SEQUENCE IF EXISTS task_public_no_seq")
    op.drop_table("users")
    op.execute("DROP TYPE IF EXISTS task_role")
    op.execute("DROP TYPE IF EXISTS task_status")

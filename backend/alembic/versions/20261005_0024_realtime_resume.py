"""Track recording activity so interrupted captures can resume or be finalized."""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "20261005_0024"
down_revision: str | None = "20260927_0023"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Existing rows get the migration time, so sessions left in "recording" by an
    # older crash are finalized by the live worker after the resume timeout.
    op.add_column(
        "realtime_sessions",
        sa.Column(
            "last_activity_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    op.create_index(
        "ix_realtime_sessions_status_last_activity",
        "realtime_sessions",
        ["status", "last_activity_at"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_realtime_sessions_status_last_activity", table_name="realtime_sessions")
    op.drop_column("realtime_sessions", "last_activity_at")

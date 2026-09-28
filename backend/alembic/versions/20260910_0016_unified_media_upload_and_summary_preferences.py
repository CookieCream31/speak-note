"""Add unified media upload and summary preferences.

Revision ID: 20260910_0016
Revises: 20260909_0015
Create Date: 2026-09-10
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "20260910_0016"
down_revision: str | None = "20260909_0015"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        op.execute("ALTER TYPE meeting_source_type ADD VALUE IF NOT EXISTS 'media_upload'")

    op.add_column(
        "meetings",
        sa.Column(
            "summary_format",
            sa.String(length=20),
            nullable=False,
            server_default="standard",
        ),
    )
    op.add_column("meetings", sa.Column("meeting_context", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("meetings", "meeting_context")
    op.drop_column("meetings", "summary_format")
    # PostgreSQL enum values cannot be removed safely and are intentionally retained.

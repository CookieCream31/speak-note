"""Add meeting tags.

Revision ID: 20260906_0011
Revises: 20260905_0010
Create Date: 2026-09-06
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "20260906_0011"
down_revision: str | None = "20260905_0010"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "meeting_tags",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(length=50), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("name"),
    )
    op.create_table(
        "meeting_tag_assignments",
        sa.Column("meeting_id", sa.Uuid(), nullable=False),
        sa.Column("tag_id", sa.Uuid(), nullable=False),
        sa.ForeignKeyConstraint(["meeting_id"], ["meetings.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["tag_id"], ["meeting_tags.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("meeting_id", "tag_id"),
    )
    op.create_index(
        "ix_meeting_tag_assignments_tag_id",
        "meeting_tag_assignments",
        ["tag_id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(
        "ix_meeting_tag_assignments_tag_id", table_name="meeting_tag_assignments"
    )
    op.drop_table("meeting_tag_assignments")
    op.drop_table("meeting_tags")

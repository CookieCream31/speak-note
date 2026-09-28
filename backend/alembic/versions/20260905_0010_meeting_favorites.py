"""Add meeting favorites.

Revision ID: 20260905_0010
Revises: 20260904_0009
Create Date: 2026-09-05
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "20260905_0010"
down_revision: str | None = "20260904_0009"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "meetings",
        sa.Column("is_favorite", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.create_index("ix_meetings_is_favorite", "meetings", ["is_favorite"], unique=False)
    op.alter_column("meetings", "is_favorite", server_default=None)


def downgrade() -> None:
    op.drop_index("ix_meetings_is_favorite", table_name="meetings")
    op.drop_column("meetings", "is_favorite")

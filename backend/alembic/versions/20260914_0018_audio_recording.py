"""Add microphone-only audio recording meetings.

Revision ID: 20260914_0018
Revises: 20260911_0017
Create Date: 2026-09-14
"""

from collections.abc import Sequence

from alembic import op

revision: str = "20260914_0018"
down_revision: str | None = "20260911_0017"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        op.execute(
            "ALTER TYPE meeting_source_type "
            "ADD VALUE IF NOT EXISTS 'audio_recording'"
        )


def downgrade() -> None:
    # PostgreSQL enum values cannot be removed safely and are intentionally retained.
    pass

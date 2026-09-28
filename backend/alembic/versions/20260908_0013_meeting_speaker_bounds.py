"""Add optional speaker-count bounds to meetings.

Revision ID: 20260908_0013
Revises: 20260907_0012
Create Date: 2026-09-08
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "20260908_0013"
down_revision: str | None = "20260907_0012"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("meetings", sa.Column("min_speakers", sa.Integer(), nullable=True))
    op.add_column("meetings", sa.Column("max_speakers", sa.Integer(), nullable=True))
    op.create_check_constraint(
        "ck_meeting_min_speakers",
        "meetings",
        "min_speakers IS NULL OR min_speakers >= 1",
    )
    op.create_check_constraint(
        "ck_meeting_max_speakers",
        "meetings",
        "max_speakers IS NULL OR max_speakers >= 1",
    )
    op.create_check_constraint(
        "ck_meeting_speaker_bounds",
        "meetings",
        "min_speakers IS NULL OR max_speakers IS NULL OR min_speakers <= max_speakers",
    )


def downgrade() -> None:
    op.drop_constraint("ck_meeting_speaker_bounds", "meetings", type_="check")
    op.drop_constraint("ck_meeting_max_speakers", "meetings", type_="check")
    op.drop_constraint("ck_meeting_min_speakers", "meetings", type_="check")
    op.drop_column("meetings", "max_speakers")
    op.drop_column("meetings", "min_speakers")

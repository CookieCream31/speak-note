"""Store display names for explicitly selected saved Live transcript segments."""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "20261013_0030"
down_revision: str | None = "20261012_0029"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "transcript_segments", sa.Column("provisional_speaker_name", sa.String(200), nullable=True)
    )


def downgrade() -> None:
    op.drop_column("transcript_segments", "provisional_speaker_name")

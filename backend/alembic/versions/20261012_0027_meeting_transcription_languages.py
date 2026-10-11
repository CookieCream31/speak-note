"""Meeting language preferences and immutable live-session options."""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "20261012_0027"
down_revision: str | None = "20261012_0026"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # NULL preserves the separate historical provider defaults for existing meetings.
    # New meetings explicitly store ["ja"] through the API; [] means automatic detection.
    op.add_column(
        "meetings", sa.Column("transcription_language_hints", postgresql.JSONB(), nullable=True)
    )
    op.add_column(
        "meetings",
        sa.Column(
            "transcription_language_hints_strict",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )
    op.add_column(
        "realtime_sessions", sa.Column("transcription_request", postgresql.JSONB(), nullable=True)
    )


def downgrade() -> None:
    op.drop_column("realtime_sessions", "transcription_request")
    op.drop_column("meetings", "transcription_language_hints_strict")
    op.drop_column("meetings", "transcription_language_hints")

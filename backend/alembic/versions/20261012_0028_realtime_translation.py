"""Per-meeting live translation and separate persisted captions."""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "20261012_0028"
down_revision: str | None = "20261012_0027"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("meetings", sa.Column("realtime_translation", postgresql.JSONB(), nullable=True))
    op.create_table(
        "realtime_translations",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "session_id",
            sa.Uuid(),
            sa.ForeignKey("realtime_sessions.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("result_id", sa.String(200), nullable=False),
        sa.Column("sequence", sa.Integer(), nullable=False),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("source_language", sa.String(3), nullable=False),
        sa.Column("target_language", sa.String(3), nullable=False),
        sa.Column("speaker_label", sa.String(100), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("session_id", "result_id", name="uq_live_translation_result"),
        sa.UniqueConstraint("session_id", "sequence", name="uq_live_translation_sequence"),
    )
    op.create_index("ix_realtime_translations_session_id", "realtime_translations", ["session_id"])


def downgrade() -> None:
    op.drop_index("ix_realtime_translations_session_id", table_name="realtime_translations")
    op.drop_table("realtime_translations")
    op.drop_column("meetings", "realtime_translation")

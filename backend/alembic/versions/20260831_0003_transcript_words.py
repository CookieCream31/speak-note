"""Add word-level transcript timestamps.

Revision ID: 20260831_0003
Revises: 20260830_0002
Create Date: 2026-08-31
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "20260831_0003"
down_revision: str | None = "20260830_0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "transcript_words",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("segment_id", sa.Uuid(), nullable=False),
        sa.Column("start_ms", sa.BigInteger(), nullable=False),
        sa.Column("end_ms", sa.BigInteger(), nullable=False),
        sa.Column("speaker_id", sa.Uuid(), nullable=True),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("confidence", sa.Float(), nullable=True),
        sa.Column("sequence", sa.Integer(), nullable=False),
        sa.CheckConstraint("start_ms >= 0", name="ck_transcript_word_start_ms"),
        sa.CheckConstraint("end_ms >= start_ms", name="ck_transcript_word_end_ms"),
        sa.CheckConstraint("sequence >= 0", name="ck_transcript_word_sequence"),
        sa.ForeignKeyConstraint(["segment_id"], ["transcript_segments.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["speaker_id"], ["speakers.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("segment_id", "sequence", name="uq_transcript_word_segment_sequence"),
    )
    op.create_index(
        "ix_transcript_words_segment_id", "transcript_words", ["segment_id"], unique=False
    )
    op.create_index(
        "ix_transcript_words_speaker_id", "transcript_words", ["speaker_id"], unique=False
    )
    op.create_index(
        "ix_transcript_words_segment_start",
        "transcript_words",
        ["segment_id", "start_ms"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_transcript_words_segment_start", table_name="transcript_words")
    op.drop_index("ix_transcript_words_speaker_id", table_name="transcript_words")
    op.drop_index("ix_transcript_words_segment_id", table_name="transcript_words")
    op.drop_table("transcript_words")

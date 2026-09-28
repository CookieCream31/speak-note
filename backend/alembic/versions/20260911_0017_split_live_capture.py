"""Add split audio and direct video capture for live meetings.

Revision ID: 20260911_0017
Revises: 20260910_0016
Create Date: 2026-09-11
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "20260911_0017"
down_revision: str | None = "20260910_0016"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "realtime_sessions",
        sa.Column("split_capture", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.add_column(
        "realtime_sessions",
        sa.Column("audio_storage_path", sa.String(length=500), nullable=True),
    )
    op.add_column(
        "realtime_sessions",
        sa.Column("audio_mime_type", sa.String(length=200), nullable=True),
    )
    op.add_column(
        "realtime_sessions",
        sa.Column("audio_chunk_count", sa.Integer(), nullable=False, server_default="0"),
    )
    op.add_column(
        "realtime_sessions",
        sa.Column("video_part_count", sa.Integer(), nullable=False, server_default="0"),
    )
    op.create_check_constraint(
        "ck_realtime_session_audio_chunk_count",
        "realtime_sessions",
        "audio_chunk_count >= 0",
    )
    op.create_check_constraint(
        "ck_realtime_session_video_part_count",
        "realtime_sessions",
        "video_part_count >= 0",
    )
    op.create_table(
        "realtime_video_parts",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("session_id", sa.Uuid(), nullable=False),
        sa.Column("sequence", sa.Integer(), nullable=False),
        sa.Column("start_ms", sa.BigInteger(), nullable=False),
        sa.Column("end_ms", sa.BigInteger(), nullable=True),
        sa.Column("mime_type", sa.String(length=200), nullable=False),
        sa.Column("storage_path", sa.String(length=500), nullable=False),
        sa.Column("chunk_count", sa.Integer(), nullable=False),
        sa.Column("size_bytes", sa.BigInteger(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("sequence >= 0", name="ck_realtime_video_part_sequence"),
        sa.CheckConstraint("start_ms >= 0", name="ck_realtime_video_part_start_ms"),
        sa.CheckConstraint(
            "end_ms IS NULL OR end_ms > start_ms",
            name="ck_realtime_video_part_end_ms",
        ),
        sa.CheckConstraint("chunk_count >= 0", name="ck_realtime_video_part_chunk_count"),
        sa.CheckConstraint("size_bytes >= 0", name="ck_realtime_video_part_size_bytes"),
        sa.ForeignKeyConstraint(
            ["session_id"], ["realtime_sessions.id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "session_id", "sequence", name="uq_realtime_video_part_sequence"
        ),
        sa.UniqueConstraint("storage_path", name="uq_realtime_video_part_storage_path"),
    )
    op.create_index(
        "ix_realtime_video_parts_session_id",
        "realtime_video_parts",
        ["session_id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_realtime_video_parts_session_id", table_name="realtime_video_parts")
    op.drop_table("realtime_video_parts")
    op.drop_constraint(
        "ck_realtime_session_video_part_count", "realtime_sessions", type_="check"
    )
    op.drop_constraint(
        "ck_realtime_session_audio_chunk_count", "realtime_sessions", type_="check"
    )
    op.drop_column("realtime_sessions", "video_part_count")
    op.drop_column("realtime_sessions", "audio_chunk_count")
    op.drop_column("realtime_sessions", "audio_mime_type")
    op.drop_column("realtime_sessions", "audio_storage_path")
    op.drop_column("realtime_sessions", "split_capture")

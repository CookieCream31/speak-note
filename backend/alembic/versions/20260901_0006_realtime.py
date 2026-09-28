"""Add Phase 6 realtime capture and live transcript support.

Revision ID: 20260901_0006
Revises: 20260831_0005
Create Date: 2026-09-01
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "20260901_0006"
down_revision: str | None = "20260831_0005"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        op.execute("ALTER TYPE meeting_status ADD VALUE IF NOT EXISTS 'recording'")
        op.execute("ALTER TYPE job_type ADD VALUE IF NOT EXISTS 'transcribe_live'")

    realtime_status = sa.Enum(
        "recording",
        "finalizing",
        "completed",
        "failed",
        name="realtime_session_status",
    )
    op.create_table(
        "realtime_sessions",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("meeting_id", sa.Uuid(), nullable=False),
        sa.Column("media_id", sa.Uuid(), nullable=False),
        sa.Column("transcript_version_id", sa.Uuid(), nullable=False),
        sa.Column("status", realtime_status, nullable=False),
        sa.Column("mime_type", sa.String(length=200), nullable=False),
        sa.Column("has_system_audio", sa.Boolean(), nullable=False),
        sa.Column("chunk_count", sa.Integer(), nullable=False),
        sa.Column("received_bytes", sa.BigInteger(), nullable=False),
        sa.Column("duration_ms", sa.BigInteger(), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("ended_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("chunk_count >= 0", name="ck_realtime_session_chunk_count"),
        sa.CheckConstraint("duration_ms >= 0", name="ck_realtime_session_duration_ms"),
        sa.CheckConstraint("received_bytes >= 0", name="ck_realtime_session_received_bytes"),
        sa.ForeignKeyConstraint(["media_id"], ["media.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["meeting_id"], ["meetings.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["transcript_version_id"], ["transcript_versions.id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("media_id", name="uq_realtime_session_media"),
        sa.UniqueConstraint("transcript_version_id", name="uq_realtime_session_transcript"),
    )
    op.create_index(
        "ix_realtime_sessions_meeting_id", "realtime_sessions", ["meeting_id"], unique=False
    )
    op.create_table(
        "realtime_chunks",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("session_id", sa.Uuid(), nullable=False),
        sa.Column("sequence", sa.Integer(), nullable=False),
        sa.Column("start_ms", sa.BigInteger(), nullable=False),
        sa.Column("end_ms", sa.BigInteger(), nullable=False),
        sa.Column("window_start_ms", sa.BigInteger(), nullable=False),
        sa.Column("size_bytes", sa.BigInteger(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("end_ms >= start_ms", name="ck_realtime_chunk_end_ms"),
        sa.CheckConstraint("sequence >= 0", name="ck_realtime_chunk_sequence"),
        sa.CheckConstraint("size_bytes > 0", name="ck_realtime_chunk_size_bytes"),
        sa.CheckConstraint("start_ms >= 0", name="ck_realtime_chunk_start_ms"),
        sa.CheckConstraint("window_start_ms >= 0", name="ck_realtime_chunk_window_start_ms"),
        sa.ForeignKeyConstraint(["session_id"], ["realtime_sessions.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("session_id", "sequence", name="uq_realtime_chunk_session_sequence"),
    )
    op.create_index(
        "ix_realtime_chunks_session_id", "realtime_chunks", ["session_id"], unique=False
    )
    op.add_column("jobs", sa.Column("realtime_chunk_id", sa.Uuid(), nullable=True))
    op.create_unique_constraint("uq_jobs_realtime_chunk_id", "jobs", ["realtime_chunk_id"])
    op.create_foreign_key(
        "fk_jobs_realtime_chunk_id",
        "jobs",
        "realtime_chunks",
        ["realtime_chunk_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.add_column(
        "transcript_segments",
        sa.Column("provisional_speaker_label", sa.String(length=100), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("transcript_segments", "provisional_speaker_label")
    op.drop_constraint("fk_jobs_realtime_chunk_id", "jobs", type_="foreignkey")
    op.drop_constraint("uq_jobs_realtime_chunk_id", "jobs", type_="unique")
    op.drop_column("jobs", "realtime_chunk_id")
    op.drop_index("ix_realtime_chunks_session_id", table_name="realtime_chunks")
    op.drop_table("realtime_chunks")
    op.drop_index("ix_realtime_sessions_meeting_id", table_name="realtime_sessions")
    op.drop_table("realtime_sessions")

    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        sa.Enum(name="realtime_session_status").drop(bind, checkfirst=True)
    # PostgreSQL enum values are intentionally retained because removing an enum value
    # requires rebuilding every dependent column and can invalidate historical rows.

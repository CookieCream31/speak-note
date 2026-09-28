"""Create Phase 2 media, speaker, and transcript tables.

Revision ID: 20260830_0002
Revises: 20260830_0001
Create Date: 2026-08-30
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "20260830_0002"
down_revision: str | None = "20260830_0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    media_kind = sa.Enum(
        "original_video",
        "original_audio",
        "playback_video",
        "transcription_audio",
        name="media_kind",
    )
    transcript_kind = sa.Enum("live", "final", name="transcript_kind")
    transcript_status = sa.Enum("processing", "completed", "failed", name="transcript_status")

    op.create_table(
        "media",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("meeting_id", sa.Uuid(), nullable=False),
        sa.Column("kind", media_kind, nullable=False),
        sa.Column("storage_path", sa.String(length=500), nullable=False),
        sa.Column("mime_type", sa.String(length=100), nullable=False),
        sa.Column("size_bytes", sa.BigInteger(), nullable=False),
        sa.Column("duration_ms", sa.BigInteger(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("duration_ms IS NULL OR duration_ms >= 0", name="ck_media_duration_ms"),
        sa.CheckConstraint("size_bytes >= 0", name="ck_media_size_bytes"),
        sa.ForeignKeyConstraint(["meeting_id"], ["meetings.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("meeting_id", "kind", name="uq_media_meeting_kind"),
        sa.UniqueConstraint("storage_path"),
    )
    op.create_index("ix_media_meeting_id", "media", ["meeting_id"], unique=False)

    op.create_table(
        "speakers",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("meeting_id", sa.Uuid(), nullable=False),
        sa.Column("internal_name", sa.String(length=100), nullable=False),
        sa.Column("display_name", sa.String(length=200), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["meeting_id"], ["meetings.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("meeting_id", "internal_name", name="uq_speaker_meeting_internal_name"),
    )
    op.create_index("ix_speakers_meeting_id", "speakers", ["meeting_id"], unique=False)

    op.create_table(
        "transcript_versions",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("meeting_id", sa.Uuid(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("kind", transcript_kind, nullable=False),
        sa.Column("status", transcript_status, nullable=False),
        sa.Column("language", sa.String(length=20), nullable=False),
        sa.Column("model", sa.String(length=100), nullable=False),
        sa.Column("diarization_enabled", sa.Boolean(), nullable=False),
        sa.Column(
            "raw_response",
            sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), "postgresql"),
            nullable=True,
        ),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("version >= 1", name="ck_transcript_version_positive"),
        sa.ForeignKeyConstraint(["meeting_id"], ["meetings.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "meeting_id", "kind", "version", name="uq_transcript_version_meeting_kind_version"
        ),
    )
    op.create_index(
        "ix_transcript_versions_meeting_id", "transcript_versions", ["meeting_id"], unique=False
    )

    op.create_table(
        "transcript_segments",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("transcript_version_id", sa.Uuid(), nullable=False),
        sa.Column("start_ms", sa.BigInteger(), nullable=False),
        sa.Column("end_ms", sa.BigInteger(), nullable=False),
        sa.Column("speaker_id", sa.Uuid(), nullable=True),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("confidence", sa.Float(), nullable=True),
        sa.Column("sequence", sa.Integer(), nullable=False),
        sa.CheckConstraint("end_ms >= start_ms", name="ck_transcript_segment_end_ms"),
        sa.CheckConstraint("sequence >= 0", name="ck_transcript_segment_sequence"),
        sa.CheckConstraint("start_ms >= 0", name="ck_transcript_segment_start_ms"),
        sa.ForeignKeyConstraint(["speaker_id"], ["speakers.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(
            ["transcript_version_id"], ["transcript_versions.id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "transcript_version_id", "sequence", name="uq_transcript_segment_version_sequence"
        ),
    )
    op.create_index(
        "ix_transcript_segments_speaker_id", "transcript_segments", ["speaker_id"], unique=False
    )
    op.create_index(
        "ix_transcript_segments_transcript_version_id",
        "transcript_segments",
        ["transcript_version_id"],
        unique=False,
    )
    op.create_index(
        "ix_transcript_segments_version_start",
        "transcript_segments",
        ["transcript_version_id", "start_ms"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_transcript_segments_version_start", table_name="transcript_segments")
    op.drop_index("ix_transcript_segments_transcript_version_id", table_name="transcript_segments")
    op.drop_index("ix_transcript_segments_speaker_id", table_name="transcript_segments")
    op.drop_table("transcript_segments")
    op.drop_index("ix_transcript_versions_meeting_id", table_name="transcript_versions")
    op.drop_table("transcript_versions")
    op.drop_index("ix_speakers_meeting_id", table_name="speakers")
    op.drop_table("speakers")
    op.drop_index("ix_media_meeting_id", table_name="media")
    op.drop_table("media")

    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        for enum_name in ("transcript_status", "transcript_kind", "media_kind"):
            sa.Enum(name=enum_name).drop(bind, checkfirst=True)

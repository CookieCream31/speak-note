"""Create Phase 1 meeting and job tables.

Revision ID: 20260830_0001
Revises:
Create Date: 2026-08-30
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "20260830_0001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    source_type = sa.Enum("live", "video_upload", "audio_upload", name="meeting_source_type")
    meeting_status = sa.Enum(
        "created",
        "uploading",
        "preprocessing",
        "queued",
        "transcribing",
        "analyzing",
        "completed",
        "failed",
        name="meeting_status",
    )
    job_type = sa.Enum(
        "preprocess_media", "transcribe", "analyze", "generate_thumbnails", name="job_type"
    )
    job_status = sa.Enum("queued", "running", "completed", "failed", name="job_status")

    op.create_table(
        "meetings",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("title", sa.String(length=200), nullable=False),
        sa.Column("source_type", source_type, nullable=False),
        sa.Column("status", meeting_status, nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("duration_ms", sa.BigInteger(), nullable=True),
        sa.Column("active_transcript_version_id", sa.Uuid(), nullable=True),
        sa.Column("active_analysis_version_id", sa.Uuid(), nullable=True),
        sa.CheckConstraint(
            "duration_ms IS NULL OR duration_ms >= 0", name="ck_meeting_duration_ms"
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_meetings_created_at", "meetings", ["created_at"], unique=False)

    op.create_table(
        "jobs",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("meeting_id", sa.Uuid(), nullable=False),
        sa.Column("type", job_type, nullable=False),
        sa.Column("status", job_status, nullable=False),
        sa.Column("attempts", sa.Integer(), nullable=False),
        sa.Column("progress", sa.Integer(), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("attempts >= 0", name="ck_job_attempts"),
        sa.CheckConstraint(
            "progress IS NULL OR progress BETWEEN 0 AND 100", name="ck_job_progress"
        ),
        sa.ForeignKeyConstraint(["meeting_id"], ["meetings.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_jobs_meeting_id", "jobs", ["meeting_id"], unique=False)
    op.create_index("ix_jobs_status_created_at", "jobs", ["status", "created_at"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_jobs_status_created_at", table_name="jobs")
    op.drop_index("ix_jobs_meeting_id", table_name="jobs")
    op.drop_table("jobs")
    op.drop_index("ix_meetings_created_at", table_name="meetings")
    op.drop_table("meetings")

    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        for enum_name in ("job_status", "job_type", "meeting_status", "meeting_source_type"):
            sa.Enum(name=enum_name).drop(bind, checkfirst=True)

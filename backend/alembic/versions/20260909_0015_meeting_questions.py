"""Add transcript-grounded meeting questions.

Revision ID: 20260909_0015
Revises: 20260908_0014
Create Date: 2026-09-09
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "20260909_0015"
down_revision: str | None = "20260908_0014"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        op.execute("ALTER TYPE job_type ADD VALUE IF NOT EXISTS 'ask_meeting'")

    question_status = sa.Enum(
        "queued",
        "processing",
        "completed",
        "failed",
        name="meeting_question_status",
    )
    op.create_table(
        "meeting_questions",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("meeting_id", sa.Uuid(), nullable=False),
        sa.Column("transcript_version_id", sa.Uuid(), nullable=False),
        sa.Column("provider_id", sa.Uuid(), nullable=True),
        sa.Column("profile_id", sa.Uuid(), nullable=True),
        sa.Column("job_id", sa.Uuid(), nullable=True),
        sa.Column("question", sa.Text(), nullable=False),
        sa.Column("answer", sa.Text(), nullable=True),
        sa.Column("insufficient_information", sa.Boolean(), nullable=False),
        sa.Column("model", sa.String(length=200), nullable=False),
        sa.Column("status", question_status, nullable=False),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["job_id"], ["jobs.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["meeting_id"], ["meetings.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["profile_id"], ["ai_profiles.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(
            ["provider_id"],
            ["ai_provider_configs.id"],
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["transcript_version_id"],
            ["transcript_versions.id"],
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("job_id"),
    )
    op.create_index(
        "ix_meeting_questions_meeting_created",
        "meeting_questions",
        ["meeting_id", "created_at"],
        unique=False,
    )
    op.create_index(
        "ix_meeting_questions_meeting_id",
        "meeting_questions",
        ["meeting_id"],
        unique=False,
    )
    op.create_index(
        "ix_meeting_questions_transcript_version_id",
        "meeting_questions",
        ["transcript_version_id"],
        unique=False,
    )
    op.create_table(
        "meeting_question_evidence",
        sa.Column("meeting_question_id", sa.Uuid(), nullable=False),
        sa.Column("segment_id", sa.Uuid(), nullable=False),
        sa.ForeignKeyConstraint(
            ["meeting_question_id"],
            ["meeting_questions.id"],
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["segment_id"],
            ["transcript_segments.id"],
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("meeting_question_id", "segment_id"),
    )


def downgrade() -> None:
    op.drop_table("meeting_question_evidence")
    op.drop_index("ix_meeting_questions_transcript_version_id", table_name="meeting_questions")
    op.drop_index("ix_meeting_questions_meeting_id", table_name="meeting_questions")
    op.drop_index("ix_meeting_questions_meeting_created", table_name="meeting_questions")
    op.drop_table("meeting_questions")
    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        sa.Enum(name="meeting_question_status").drop(bind, checkfirst=True)
    # PostgreSQL job_type enum value is intentionally retained on downgrade.

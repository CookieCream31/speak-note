"""Add incremental realtime AI analysis state.

Revision ID: 20260904_0008
Revises: 20260901_0007
Create Date: 2026-09-04
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "20260904_0008"
down_revision: str | None = "20260901_0007"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        op.execute("ALTER TYPE job_type ADD VALUE IF NOT EXISTS 'analyze_realtime'")

    realtime_analysis_status = sa.Enum(
        "queued", "processing", "completed", "failed", name="realtime_analysis_status"
    )
    op.create_table(
        "realtime_analysis_states",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("realtime_session_id", sa.Uuid(), nullable=False),
        sa.Column("meeting_id", sa.Uuid(), nullable=False),
        sa.Column("transcript_version_id", sa.Uuid(), nullable=False),
        sa.Column("provider_id", sa.Uuid(), nullable=True),
        sa.Column("profile_id", sa.Uuid(), nullable=True),
        sa.Column("status", realtime_analysis_status, nullable=False),
        sa.Column("input_revision", sa.Integer(), nullable=False),
        sa.Column("processed_revision", sa.Integer(), nullable=False),
        sa.Column("analyzed_through_ms", sa.BigInteger(), nullable=False),
        sa.Column("model", sa.String(length=200), nullable=True),
        sa.Column(
            "snapshot",
            sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), "postgresql"),
            nullable=True,
        ),
        sa.Column(
            "source_segments",
            sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), "postgresql"),
            nullable=False,
        ),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("analyzed_through_ms >= 0", name="ck_realtime_analysis_through_ms"),
        sa.CheckConstraint("input_revision >= 0", name="ck_realtime_analysis_input_revision"),
        sa.CheckConstraint(
            "processed_revision >= 0",
            name="ck_realtime_analysis_processed_revision",
        ),
        sa.ForeignKeyConstraint(["meeting_id"], ["meetings.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["profile_id"], ["ai_profiles.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["provider_id"], ["ai_provider_configs.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(
            ["realtime_session_id"], ["realtime_sessions.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["transcript_version_id"],
            ["transcript_versions.id"],
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("realtime_session_id", name="uq_realtime_analysis_realtime_session"),
    )
    for column in ("realtime_session_id", "meeting_id", "transcript_version_id"):
        op.create_index(
            f"ix_realtime_analysis_states_{column}",
            "realtime_analysis_states",
            [column],
            unique=False,
        )


def downgrade() -> None:
    for column in ("transcript_version_id", "meeting_id", "realtime_session_id"):
        op.drop_index(
            f"ix_realtime_analysis_states_{column}", table_name="realtime_analysis_states"
        )
    op.drop_table("realtime_analysis_states")
    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        sa.Enum(name="realtime_analysis_status").drop(bind, checkfirst=True)
    # PostgreSQL job_type enum value is intentionally retained on downgrade.

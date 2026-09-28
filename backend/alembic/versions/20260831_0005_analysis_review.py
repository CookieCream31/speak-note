"""Add Phase 5 analysis, evidence, and bookmarks.

Revision ID: 20260831_0005
Revises: 20260831_0004
Create Date: 2026-08-31
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "20260831_0005"
down_revision: str | None = "20260831_0004"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    analysis_status = sa.Enum("processing", "completed", "failed", name="analysis_status")
    analysis_item_kind = sa.Enum(
        "summary",
        "decision",
        "action_item",
        "open_question",
        "important_point",
        "chapter",
        "suggested_question",
        "highlight",
        name="analysis_item_kind",
    )
    analysis_item_state = sa.Enum("generated", "confirmed", "edited", name="analysis_item_state")

    op.create_table(
        "analysis_versions",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("meeting_id", sa.Uuid(), nullable=False),
        sa.Column("transcript_version_id", sa.Uuid(), nullable=False),
        sa.Column("provider_id", sa.Uuid(), nullable=True),
        sa.Column("profile_id", sa.Uuid(), nullable=True),
        sa.Column("job_id", sa.Uuid(), nullable=True),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("model", sa.String(length=200), nullable=False),
        sa.Column("temperature", sa.Float(), nullable=False),
        sa.Column("prompt_version", sa.String(length=50), nullable=False),
        sa.Column("status", analysis_status, nullable=False),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("version >= 1", name="ck_analysis_version_positive"),
        sa.ForeignKeyConstraint(["job_id"], ["jobs.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["meeting_id"], ["meetings.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["profile_id"], ["ai_profiles.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["provider_id"], ["ai_provider_configs.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(
            ["transcript_version_id"],
            ["transcript_versions.id"],
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("job_id"),
        sa.UniqueConstraint("meeting_id", "version", name="uq_analysis_meeting_version"),
    )
    op.create_index(
        "ix_analysis_versions_meeting_id", "analysis_versions", ["meeting_id"], unique=False
    )
    op.create_index(
        "ix_analysis_versions_transcript_version_id",
        "analysis_versions",
        ["transcript_version_id"],
        unique=False,
    )

    op.create_table(
        "analysis_items",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("analysis_version_id", sa.Uuid(), nullable=False),
        sa.Column("kind", analysis_item_kind, nullable=False),
        sa.Column("state", analysis_item_state, nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("assignee", sa.String(length=200), nullable=True),
        sa.Column("deadline", sa.Date(), nullable=True),
        sa.Column("start_ms", sa.BigInteger(), nullable=True),
        sa.Column("end_ms", sa.BigInteger(), nullable=True),
        sa.Column("sequence", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("sequence >= 0", name="ck_analysis_item_sequence"),
        sa.CheckConstraint("start_ms IS NULL OR start_ms >= 0", name="ck_analysis_item_start_ms"),
        sa.CheckConstraint(
            "end_ms IS NULL OR (start_ms IS NOT NULL AND end_ms >= start_ms)",
            name="ck_analysis_item_end_ms",
        ),
        sa.ForeignKeyConstraint(
            ["analysis_version_id"], ["analysis_versions.id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "analysis_version_id", "sequence", name="uq_analysis_item_version_sequence"
        ),
    )
    op.create_index(
        "ix_analysis_items_analysis_version_id",
        "analysis_items",
        ["analysis_version_id"],
        unique=False,
    )
    op.create_index(
        "ix_analysis_items_version_kind",
        "analysis_items",
        ["analysis_version_id", "kind"],
        unique=False,
    )

    op.create_table(
        "analysis_evidence",
        sa.Column("item_id", sa.Uuid(), nullable=False),
        sa.Column("segment_id", sa.Uuid(), nullable=False),
        sa.ForeignKeyConstraint(["item_id"], ["analysis_items.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["segment_id"], ["transcript_segments.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("item_id", "segment_id"),
    )

    op.create_table(
        "bookmarks",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("meeting_id", sa.Uuid(), nullable=False),
        sa.Column("timestamp_ms", sa.BigInteger(), nullable=False),
        sa.Column("title", sa.String(length=200), nullable=False),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("timestamp_ms >= 0", name="ck_bookmark_timestamp_ms"),
        sa.ForeignKeyConstraint(["meeting_id"], ["meetings.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_bookmarks_meeting_id", "bookmarks", ["meeting_id"], unique=False)
    op.create_index(
        "ix_bookmarks_meeting_timestamp",
        "bookmarks",
        ["meeting_id", "timestamp_ms"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_bookmarks_meeting_timestamp", table_name="bookmarks")
    op.drop_index("ix_bookmarks_meeting_id", table_name="bookmarks")
    op.drop_table("bookmarks")
    op.drop_table("analysis_evidence")
    op.drop_index("ix_analysis_items_version_kind", table_name="analysis_items")
    op.drop_index("ix_analysis_items_analysis_version_id", table_name="analysis_items")
    op.drop_table("analysis_items")
    op.drop_index("ix_analysis_versions_transcript_version_id", table_name="analysis_versions")
    op.drop_index("ix_analysis_versions_meeting_id", table_name="analysis_versions")
    op.drop_table("analysis_versions")

    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        for enum_name in ("analysis_item_state", "analysis_item_kind", "analysis_status"):
            sa.Enum(name=enum_name).drop(bind, checkfirst=True)

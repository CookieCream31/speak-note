"""Add opt-in live answer assistance with frozen AI and knowledge settings."""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "20260927_0022"
down_revision: str | None = "20260925_0021"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.get_context().autocommit_block():
        op.execute("ALTER TYPE job_type ADD VALUE IF NOT EXISTS 'answer_live'")
    op.create_table(
        "answer_assist_sessions",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "meeting_id",
            sa.Uuid(),
            sa.ForeignKey("meetings.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "capture_id",
            sa.Uuid(),
            sa.ForeignKey("realtime_sessions.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "provider_id", sa.Uuid(), sa.ForeignKey("ai_provider_configs.id", ondelete="SET NULL")
        ),
        sa.Column("profile_id", sa.Uuid(), sa.ForeignKey("ai_profiles.id", ondelete="SET NULL")),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        sa.Column("configuration", postgresql.JSONB(), nullable=False),
        sa.Column("knowledge_snapshot", postgresql.JSONB(), nullable=False),
        sa.Column("consented_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index(
        "ix_answer_assist_sessions_meeting_id", "answer_assist_sessions", ["meeting_id"]
    )
    op.create_table(
        "live_answers",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "meeting_id",
            sa.Uuid(),
            sa.ForeignKey("meetings.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "session_id",
            sa.Uuid(),
            sa.ForeignKey("answer_assist_sessions.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("job_id", sa.Uuid(), sa.ForeignKey("jobs.id", ondelete="SET NULL"), unique=True),
        sa.Column("request_id", sa.Uuid(), nullable=False, unique=True),
        sa.Column("sequence", sa.Integer(), nullable=False),
        sa.Column("question", sa.Text(), nullable=False),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("short_answer", sa.Text()),
        sa.Column("detailed_answer", sa.Text()),
        sa.Column("insufficient_information", sa.Boolean(), nullable=False),
        sa.Column("source_ids", postgresql.JSONB(), nullable=False),
        sa.Column("input_snapshot", postgresql.JSONB(), nullable=False),
        sa.Column("error_message", sa.Text()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("completed_at", sa.DateTime(timezone=True)),
    )
    op.create_index("ix_live_answers_meeting_id", "live_answers", ["meeting_id"])
    op.create_index("ix_live_answers_session_id", "live_answers", ["session_id"])


def downgrade() -> None:
    op.drop_table("live_answers")
    op.drop_table("answer_assist_sessions")
    # PostgreSQL enum values cannot safely be removed while other jobs exist.

"""Add resumable media upload sessions.

Revision ID: 20260907_0012
Revises: 20260906_0011
Create Date: 2026-09-07
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "20260907_0012"
down_revision: str | None = "20260906_0011"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    upload_status = sa.Enum("uploading", "completed", name="media_upload_status")
    op.create_table(
        "media_upload_sessions",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("meeting_id", sa.Uuid(), nullable=False),
        sa.Column("media_id", sa.Uuid(), nullable=False),
        sa.Column("job_id", sa.Uuid(), nullable=False),
        sa.Column("filename_suffix", sa.String(length=16), nullable=False),
        sa.Column("mime_type", sa.String(length=100), nullable=False),
        sa.Column("size_bytes", sa.BigInteger(), nullable=False),
        sa.Column("chunk_size_bytes", sa.BigInteger(), nullable=False),
        sa.Column("chunk_count", sa.Integer(), nullable=False),
        sa.Column("status", upload_status, nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("chunk_count > 0", name="ck_media_upload_chunk_count"),
        sa.CheckConstraint(
            "chunk_size_bytes > 0", name="ck_media_upload_chunk_size_bytes"
        ),
        sa.CheckConstraint("size_bytes > 0", name="ck_media_upload_size_bytes"),
        sa.ForeignKeyConstraint(["meeting_id"], ["meetings.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("job_id"),
        sa.UniqueConstraint("media_id"),
    )
    op.create_index(
        "ix_media_upload_sessions_meeting_id",
        "media_upload_sessions",
        ["meeting_id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(
        "ix_media_upload_sessions_meeting_id",
        table_name="media_upload_sessions",
    )
    op.drop_table("media_upload_sessions")
    sa.Enum(name="media_upload_status").drop(op.get_bind(), checkfirst=True)

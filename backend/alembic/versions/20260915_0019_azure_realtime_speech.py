"""Add Azure Speech settings for realtime transcription.

Revision ID: 20260915_0019
Revises: 20260914_0018
Create Date: 2026-09-15
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260915_0019"
down_revision: str | None = "20260914_0018"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "realtime_transcription_settings",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column(
            "provider", sa.String(length=20), server_default="whisperx", nullable=False
        ),
        sa.Column("azure_region", sa.String(length=100), nullable=True),
        sa.Column(
            "azure_language", sa.String(length=20), server_default="ja-JP", nullable=False
        ),
        sa.Column("encrypted_api_key", sa.Text(), nullable=True),
        sa.Column("api_key_hint", sa.String(length=20), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "id = 1", name="ck_realtime_transcription_settings_singleton"
        ),
        sa.CheckConstraint(
            "provider IN (\047whisperx\047, \047azure_speech\047)",
            name="ck_realtime_transcription_settings_provider",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.execute(
        "INSERT INTO realtime_transcription_settings "
        "(id, provider, azure_language, updated_at) "
        "VALUES (1, \047whisperx\047, \047ja-JP\047, CURRENT_TIMESTAMP)"
    )
    op.add_column(
        "realtime_sessions",
        sa.Column(
            "transcription_provider",
            sa.String(length=20),
            server_default="whisperx",
            nullable=False,
        ),
    )
    op.add_column(
        "realtime_sessions",
        sa.Column("transcription_region", sa.String(length=100), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("realtime_sessions", "transcription_region")
    op.drop_column("realtime_sessions", "transcription_provider")
    op.drop_table("realtime_transcription_settings")

"""Independent Soniox live and asynchronous transcription settings/checkpoints."""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "20261012_0026"
down_revision: str | None = "20261010_0025"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_constraint(
        "ck_realtime_transcription_settings_provider",
        "realtime_transcription_settings",
        type_="check",
    )
    op.create_check_constraint(
        "ck_realtime_transcription_settings_provider",
        "realtime_transcription_settings",
        "provider IN ('whisperx', 'azure_speech', 'soniox')",
    )
    op.add_column(
        "realtime_transcription_settings",
        sa.Column("soniox_model", sa.String(32), nullable=False, server_default="stt-rt-v5"),
    )
    op.add_column(
        "realtime_transcription_settings",
        sa.Column("soniox_language", sa.String(20), nullable=False, server_default="ja"),
    )
    op.add_column(
        "realtime_transcription_settings",
        sa.Column("soniox_encrypted_api_key", sa.Text(), nullable=True),
    )
    op.add_column(
        "realtime_transcription_settings",
        sa.Column("soniox_api_key_hint", sa.String(20), nullable=True),
    )
    op.create_table(
        "async_transcription_settings",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("provider", sa.String(20), nullable=False, server_default="whisperx"),
        sa.Column("soniox_model", sa.String(32), nullable=False, server_default="stt-async-v5"),
        sa.Column("soniox_language", sa.String(20), nullable=False, server_default="ja"),
        sa.Column("soniox_encrypted_api_key", sa.Text(), nullable=True),
        sa.Column("soniox_api_key_hint", sa.String(20), nullable=True),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.CheckConstraint("id = 1", name="ck_async_transcription_settings_singleton"),
        sa.CheckConstraint(
            "provider IN ('whisperx', 'soniox')", name="ck_async_transcription_settings_provider"
        ),
    )
    op.add_column("jobs", sa.Column("transcription_request", postgresql.JSONB(), nullable=True))


def downgrade() -> None:
    op.drop_column("jobs", "transcription_request")
    op.drop_table("async_transcription_settings")
    op.execute(
        "UPDATE realtime_transcription_settings SET provider = 'whisperx' WHERE provider = 'soniox'"
    )
    for name in (
        "soniox_api_key_hint",
        "soniox_encrypted_api_key",
        "soniox_language",
        "soniox_model",
    ):
        op.drop_column("realtime_transcription_settings", name)
    op.drop_constraint(
        "ck_realtime_transcription_settings_provider",
        "realtime_transcription_settings",
        type_="check",
    )
    op.create_check_constraint(
        "ck_realtime_transcription_settings_provider",
        "realtime_transcription_settings",
        "provider IN ('whisperx', 'azure_speech')",
    )

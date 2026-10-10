"""Add shared-screen audio recording without saved video."""

from collections.abc import Sequence

from alembic import op

revision: str = "20261010_0025"
down_revision: str | None = "20261005_0024"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    if op.get_bind().dialect.name == "postgresql":
        op.execute("ALTER TYPE meeting_source_type ADD VALUE IF NOT EXISTS 'shared_audio'")


def downgrade() -> None:
    # Removing an enum value would require rewriting existing meeting records.
    # Retain it, like the audio_recording migration, to protect saved recordings.
    pass

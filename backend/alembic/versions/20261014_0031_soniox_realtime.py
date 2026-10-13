"""Use Soniox for new realtime captures while retaining old credentials and histories."""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "20261014_0031"
down_revision: str | None = "20261013_0030"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(sa.text("UPDATE realtime_transcription_settings SET provider = 'soniox'"))


def downgrade() -> None:
    # Earlier versions already support Soniox; a rollback must not guess an old preference.
    pass

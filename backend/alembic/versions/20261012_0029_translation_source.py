"""Keep the original display block for realtime translations."""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "20261012_0029"
down_revision: str | None = "20261012_0028"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "realtime_translations", sa.Column("source_result_id", sa.String(200), nullable=True)
    )


def downgrade() -> None:
    op.drop_column("realtime_translations", "source_result_id")

"""Keep freely edited post-meeting notes separate from generated analysis items."""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "20261016_0032"
down_revision: str | None = "20261014_0031"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("analysis_versions", sa.Column("document_content", sa.Text(), nullable=True))
    op.add_column(
        "analysis_versions",
        sa.Column("document_revision", sa.Integer(), nullable=False, server_default="0"),
    )
    op.add_column(
        "analysis_versions",
        sa.Column("document_updated_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("analysis_versions", "document_updated_at")
    op.drop_column("analysis_versions", "document_revision")
    op.drop_column("analysis_versions", "document_content")

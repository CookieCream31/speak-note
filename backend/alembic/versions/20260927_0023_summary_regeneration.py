"""Freeze summary regeneration settings across transcription and retries."""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "20260927_0023"
down_revision: str | None = "20260927_0022"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("jobs", sa.Column("analysis_request", postgresql.JSONB(), nullable=True))
    op.add_column("jobs", sa.Column("request_id", sa.Uuid(), nullable=True))
    op.create_unique_constraint("uq_jobs_request_id", "jobs", ["request_id"])


def downgrade() -> None:
    op.drop_constraint("uq_jobs_request_id", "jobs", type_="unique")
    op.drop_column("jobs", "request_id")
    op.drop_column("jobs", "analysis_request")

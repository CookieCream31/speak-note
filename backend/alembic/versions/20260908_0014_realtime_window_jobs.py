"""Split delayed realtime chunks into independent window jobs.

Revision ID: 20260908_0014
Revises: 20260908_0013
Create Date: 2026-09-08
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "20260908_0014"
down_revision: str | None = "20260908_0013"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "jobs", sa.Column("realtime_window_start_ms", sa.BigInteger(), nullable=True)
    )
    op.add_column(
        "jobs", sa.Column("realtime_window_end_ms", sa.BigInteger(), nullable=True)
    )
    op.add_column(
        "jobs", sa.Column("realtime_commit_start_ms", sa.BigInteger(), nullable=True)
    )
    op.drop_constraint("uq_jobs_realtime_chunk_id", "jobs", type_="unique")
    op.create_index("ix_jobs_realtime_chunk_id", "jobs", ["realtime_chunk_id"], unique=False)
    op.create_unique_constraint(
        "uq_job_realtime_chunk_window",
        "jobs",
        ["realtime_chunk_id", "realtime_window_start_ms", "realtime_window_end_ms"],
    )
    op.create_check_constraint(
        "ck_job_realtime_window_complete",
        "jobs",
        "(realtime_window_start_ms IS NULL "
        "AND realtime_window_end_ms IS NULL "
        "AND realtime_commit_start_ms IS NULL) "
        "OR (realtime_window_start_ms IS NOT NULL "
        "AND realtime_window_end_ms IS NOT NULL "
        "AND realtime_commit_start_ms IS NOT NULL)",
    )
    op.create_check_constraint(
        "ck_job_realtime_window_bounds",
        "jobs",
        "realtime_window_start_ms IS NULL OR "
        "(realtime_window_start_ms >= 0 "
        "AND realtime_window_end_ms > realtime_window_start_ms "
        "AND realtime_commit_start_ms >= realtime_window_start_ms "
        "AND realtime_commit_start_ms < realtime_window_end_ms)",
    )


def downgrade() -> None:
    op.drop_constraint("ck_job_realtime_window_bounds", "jobs", type_="check")
    op.drop_constraint("ck_job_realtime_window_complete", "jobs", type_="check")
    op.drop_constraint("uq_job_realtime_chunk_window", "jobs", type_="unique")
    op.drop_index("ix_jobs_realtime_chunk_id", table_name="jobs")
    op.execute(
        """
        DELETE FROM jobs
        WHERE id IN (
            SELECT id
            FROM (
                SELECT
                    id,
                    ROW_NUMBER() OVER (
                        PARTITION BY realtime_chunk_id
                        ORDER BY realtime_commit_start_ms, created_at, id
                    ) AS duplicate_number
                FROM jobs
                WHERE realtime_chunk_id IS NOT NULL
            ) AS realtime_job_duplicates
            WHERE duplicate_number > 1
        )
        """
    )
    op.create_unique_constraint("uq_jobs_realtime_chunk_id", "jobs", ["realtime_chunk_id"])
    op.drop_column("jobs", "realtime_commit_start_ms")
    op.drop_column("jobs", "realtime_window_end_ms")
    op.drop_column("jobs", "realtime_window_start_ms")

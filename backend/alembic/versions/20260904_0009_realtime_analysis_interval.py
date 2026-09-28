"""Track the realtime AI scheduling position.

Revision ID: 20260904_0009
Revises: 20260904_0008
Create Date: 2026-09-04
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "20260904_0009"
down_revision: str | None = "20260904_0008"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "realtime_analysis_states",
        sa.Column(
            "scheduled_through_ms",
            sa.BigInteger(),
            nullable=False,
            server_default="0",
        ),
    )
    op.create_check_constraint(
        "ck_realtime_analysis_scheduled_ms",
        "realtime_analysis_states",
        "scheduled_through_ms >= 0",
    )
    op.alter_column(
        "realtime_analysis_states",
        "scheduled_through_ms",
        server_default=None,
    )


def downgrade() -> None:
    op.drop_constraint(
        "ck_realtime_analysis_scheduled_ms",
        "realtime_analysis_states",
        type_="check",
    )
    op.drop_column("realtime_analysis_states", "scheduled_through_ms")

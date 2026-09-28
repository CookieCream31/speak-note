"""Separate provider connectivity from profile generation settings.

Revision ID: 20260901_0007
Revises: 20260901_0006
Create Date: 2026-09-01
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "20260901_0007"
down_revision: str | None = "20260901_0006"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("ai_provider_configs") as batch_op:
        batch_op.drop_constraint("ck_ai_provider_temp", type_="check")
        batch_op.drop_column("temperature")
        batch_op.drop_column("model")


def downgrade() -> None:
    with op.batch_alter_table("ai_provider_configs") as batch_op:
        batch_op.add_column(
            sa.Column("model", sa.String(length=200), server_default="", nullable=False)
        )
        batch_op.add_column(
            sa.Column("temperature", sa.Float(), server_default="0.2", nullable=False)
        )
        batch_op.create_check_constraint(
            "ck_ai_provider_temp", "temperature >= 0 AND temperature <= 2"
        )

"""Add Phase 4 AI provider, profile, and usage settings.

Revision ID: 20260831_0004
Revises: 20260831_0003
Create Date: 2026-08-31
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "20260831_0004"
down_revision: str | None = "20260831_0003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    provider_type = sa.Enum("ollama", "gemini", name="ai_provider_type")
    usage_type = sa.Enum(
        "realtime_analysis",
        "final_minutes",
        "suggested_questions",
        "chapters",
        name="ai_usage",
    )
    op.create_table(
        "ai_provider_configs",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("provider_type", provider_type, nullable=False),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("base_url", sa.String(length=500), nullable=True),
        sa.Column("model", sa.String(length=200), nullable=False),
        sa.Column("temperature", sa.Float(), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        sa.Column("encrypted_api_key", sa.Text(), nullable=True),
        sa.Column("api_key_hint", sa.String(length=20), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "temperature >= 0 AND temperature <= 2",
            name="ck_ai_provider_temp",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("name"),
    )
    op.create_index(
        "ix_ai_provider_configs_provider_type",
        "ai_provider_configs",
        ["provider_type"],
        unique=False,
    )

    op.create_table(
        "ai_profiles",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("provider_id", sa.Uuid(), nullable=False),
        sa.Column("model", sa.String(length=200), nullable=False),
        sa.Column("temperature", sa.Float(), nullable=False),
        sa.Column("is_default", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "temperature >= 0 AND temperature <= 2",
            name="ck_ai_profile_temp",
        ),
        sa.ForeignKeyConstraint(
            ["provider_id"],
            ["ai_provider_configs.id"],
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("name"),
    )
    op.create_index("ix_ai_profiles_provider_id", "ai_profiles", ["provider_id"], unique=False)
    op.create_index(
        "uq_ai_profiles_single_default",
        "ai_profiles",
        ["is_default"],
        unique=True,
        postgresql_where=sa.text("is_default"),
    )

    op.create_table(
        "ai_usage_settings",
        sa.Column("usage", usage_type, nullable=False),
        sa.Column("profile_id", sa.Uuid(), nullable=True),
        sa.Column("disabled", sa.Boolean(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["profile_id"], ["ai_profiles.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("usage"),
    )

    op.add_column(
        "meetings",
        sa.Column("ai_profile_id", sa.Uuid(), nullable=True),
    )
    op.add_column(
        "meetings",
        sa.Column("ai_disabled", sa.Boolean(), server_default=sa.false(), nullable=False),
    )
    op.create_foreign_key(
        "fk_meetings_ai_profile_id",
        "meetings",
        "ai_profiles",
        ["ai_profile_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index("ix_meetings_ai_profile_id", "meetings", ["ai_profile_id"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_meetings_ai_profile_id", table_name="meetings")
    op.drop_constraint("fk_meetings_ai_profile_id", "meetings", type_="foreignkey")
    op.drop_column("meetings", "ai_disabled")
    op.drop_column("meetings", "ai_profile_id")
    op.drop_table("ai_usage_settings")
    op.drop_index("uq_ai_profiles_single_default", table_name="ai_profiles")
    op.drop_index("ix_ai_profiles_provider_id", table_name="ai_profiles")
    op.drop_table("ai_profiles")
    op.drop_index("ix_ai_provider_configs_provider_type", table_name="ai_provider_configs")
    op.drop_table("ai_provider_configs")

    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        for enum_name in ("ai_usage", "ai_provider_type"):
            sa.Enum(name=enum_name).drop(bind, checkfirst=True)

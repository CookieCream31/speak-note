"""Add project knowledge and reusable profiles.

Revision ID: 20260925_0021
Revises: 20260924_0020
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260925_0021"
down_revision: str | None = "20260924_0020"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _timestamps() -> list[sa.Column]:
    return [
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    ]


def upgrade() -> None:
    op.create_table(
        "personal_profiles",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        *_timestamps(),
    )
    op.create_table(
        "projects",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("parent_id", sa.Uuid(), sa.ForeignKey("projects.id", ondelete="RESTRICT")),
        sa.Column(
            "profile_id", sa.Uuid(), sa.ForeignKey("personal_profiles.id", ondelete="SET NULL")
        ),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("notes", sa.Text(), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        *_timestamps(),
    )
    op.create_index("ix_projects_parent_id", "projects", ["parent_id"])
    op.create_table(
        "project_documents",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "project_id", sa.Uuid(), sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("included", sa.Boolean(), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        *_timestamps(),
    )
    op.create_index("ix_project_documents_project_id", "project_documents", ["project_id"])
    op.add_column("meetings", sa.Column("project_id", sa.Uuid(), nullable=True))
    op.create_foreign_key(
        "fk_meetings_project_id", "meetings", "projects", ["project_id"], ["id"],
        ondelete="SET NULL",
    )
    op.create_index("ix_meetings_project_id", "meetings", ["project_id"])


def downgrade() -> None:
    op.drop_index("ix_meetings_project_id", table_name="meetings")
    op.drop_constraint("fk_meetings_project_id", "meetings", type_="foreignkey")
    op.drop_column("meetings", "project_id")
    op.drop_index("ix_project_documents_project_id", table_name="project_documents")
    op.drop_table("project_documents")
    op.drop_index("ix_projects_parent_id", table_name="projects")
    op.drop_table("projects")
    op.drop_table("personal_profiles")

"""Add versioned meeting templates and immutable meeting snapshots.

Revision ID: 20260924_0020
Revises: 20260915_0019
Create Date: 2026-09-24
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "20260924_0020"
down_revision: str | None = "20260915_0019"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "meeting_templates",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(length=100), nullable=False),
        sa.Column("definition", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("is_default", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("name"),
    )
    op.create_index("ix_meeting_templates_is_default", "meeting_templates", ["is_default"])
    op.add_column("meetings", sa.Column("template_id", sa.Uuid(), nullable=True))
    op.add_column(
        "meetings",
        sa.Column("template_snapshot", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    )
    op.create_foreign_key(
        "fk_meetings_template_id_meeting_templates",
        "meetings", "meeting_templates", ["template_id"], ["id"], ondelete="SET NULL",
    )
    op.create_index("ix_meetings_template_id", "meetings", ["template_id"])
    op.add_column(
        "analysis_versions",
        sa.Column("template_snapshot", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    )
    op.add_column(
        "analysis_versions",
        sa.Column(
            "template_values",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default="[]",
        ),
    )
    op.execute(
        sa.text(
            "INSERT INTO meeting_templates "
            "(id, name, definition, revision, is_default, created_at, updated_at) "
            "VALUES (CAST(:id AS UUID), :name, CAST(:definition AS JSONB), "
            "1, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"
        ).bindparams(
            id="20260924-0020-4000-8000-000000000001",
            name="標準",
            definition=(
                '{"realtime":['
                '{"id":"realtime_summary","title":"ここまでの要点",'
                '"visible":true,"show_when_empty":true,"core_kind":"summary","fields":[]},'
                '{"id":"realtime_decisions","title":"決定事項",'
                '"visible":true,"show_when_empty":true,"core_kind":"decision","fields":[]},'
                '{"id":"realtime_actions","title":"次のアクション",'
                '"visible":true,"show_when_empty":true,"core_kind":"action_item","fields":[]},'
                '{"id":"realtime_attention","title":"確認ポイント",'
                '"visible":true,"show_when_empty":true,"core_kind":"open_question","fields":[]},'
                '{"id":"realtime_key_facts","title":"重要情報",'
                '"visible":true,"show_when_empty":true,"core_kind":"important_point","fields":[]}],'
                '"final":['
                '{"id":"final_summary","title":"全体要約",'
                '"visible":true,"show_when_empty":true,"core_kind":"summary","fields":[]},'
                '{"id":"decisions","title":"決定事項",'
                '"visible":true,"show_when_empty":true,"core_kind":"decision","fields":[]},'
                '{"id":"actions","title":"次のアクション",'
                '"visible":true,"show_when_empty":true,"core_kind":"action_item","fields":[]},'
                '{"id":"open_questions","title":"未解決事項",'
                '"visible":true,"show_when_empty":true,"core_kind":"open_question","fields":[]},'
                '{"id":"important_points","title":"重要ポイント",'
                '"visible":true,"show_when_empty":true,"core_kind":"important_point","fields":[]},'
                '{"id":"suggested_questions","title":"質問候補","visible":true,'
                '"core_kind":"suggested_question","fields":[]},'
                '{"id":"chapters","title":"チャプター","visible":true,'
                '"core_kind":"chapter","fields":[]}]} '
            ),
        )
    )


def downgrade() -> None:
    op.drop_column("analysis_versions", "template_values")
    op.drop_column("analysis_versions", "template_snapshot")
    op.drop_index("ix_meetings_template_id", table_name="meetings")
    op.drop_constraint("fk_meetings_template_id_meeting_templates", "meetings", type_="foreignkey")
    op.drop_column("meetings", "template_snapshot")
    op.drop_column("meetings", "template_id")
    op.drop_index("ix_meeting_templates_is_default", table_name="meeting_templates")
    op.drop_table("meeting_templates")


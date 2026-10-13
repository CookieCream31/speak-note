import importlib.util
from pathlib import Path

from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine, inspect, text


def test_live_speaker_name_migration_preserves_existing_transcripts() -> None:
    path = Path(__file__).parents[1] / "alembic/versions/20261013_0030_live_speaker_names.py"
    spec = importlib.util.spec_from_file_location("live_speaker_names_migration", path)
    assert spec is not None and spec.loader is not None
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    assert migration.down_revision == "20261012_0029"
    engine = create_engine("sqlite://")
    with engine.begin() as connection:
        connection.execute(
            text(
                "CREATE TABLE transcript_segments "
                "(id TEXT PRIMARY KEY, provisional_speaker_label TEXT)"
            )
        )
        connection.execute(text("INSERT INTO transcript_segments VALUES ('s1', '話者 1')"))
        with Operations.context(MigrationContext.configure(connection)):
            migration.upgrade()
            row = connection.execute(text("SELECT * FROM transcript_segments")).mappings().one()
            assert row["provisional_speaker_label"] == "話者 1"
            assert row["provisional_speaker_name"] is None
            connection.execute(
                text("UPDATE transcript_segments SET provisional_speaker_name = 'エージェント'")
            )
            migration.downgrade()
        assert [
            column["name"] for column in inspect(connection).get_columns("transcript_segments")
        ] == [
            "id",
            "provisional_speaker_label",
        ]
        assert (
            connection.execute(
                text("SELECT provisional_speaker_label FROM transcript_segments")
            ).scalar_one()
            == "話者 1"
        )
    engine.dispose()

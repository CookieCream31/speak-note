import importlib.util
from pathlib import Path

import pytest
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine, text


@pytest.mark.parametrize("old_provider", ["whisperx", "azure_speech", "soniox"])
def test_soniox_realtime_migration_preserves_keys_async_settings_and_legacy_sessions(
    old_provider: str,
) -> None:
    path = Path(__file__).parents[1] / "alembic/versions/20261014_0031_soniox_realtime.py"
    spec = importlib.util.spec_from_file_location("soniox_realtime_migration", path)
    assert spec and spec.loader
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    assert migration.down_revision == "20261013_0030"
    engine = create_engine("sqlite://")
    with engine.begin() as connection:
        connection.execute(
            text(
                "CREATE TABLE realtime_transcription_settings "
                "(id INTEGER, provider TEXT, encrypted_api_key TEXT, soniox_encrypted_api_key TEXT)"
            )
        )
        connection.execute(
            text(
                "INSERT INTO realtime_transcription_settings "
                "VALUES (1, :provider, 'old-key', 'rt-key')"
            ),
            {"provider": old_provider},
        )
        for table in ["async_transcription_settings", "realtime_sessions"]:
            connection.execute(text(f"CREATE TABLE {table} (provider TEXT)"))
            connection.execute(text(f"INSERT INTO {table} VALUES ('whisperx')"))
        with Operations.context(MigrationContext.configure(connection)):
            migration.upgrade()
            row = (
                connection.execute(text("SELECT * FROM realtime_transcription_settings"))
                .mappings()
                .one()
            )
            assert row["provider"] == "soniox"
            assert (
                row["encrypted_api_key"] == "old-key"
                and row["soniox_encrypted_api_key"] == "rt-key"
            )
            migration.downgrade()
        assert (
            connection.execute(
                text("SELECT provider FROM realtime_transcription_settings")
            ).scalar_one()
            == "soniox"
        )
        for table in ["async_transcription_settings", "realtime_sessions"]:
            assert (
                connection.execute(text(f"SELECT provider FROM {table}")).scalar_one() == "whisperx"
            )
    engine.dispose()

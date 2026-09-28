from types import SimpleNamespace

from cryptography.fernet import Fernet
from fastapi.testclient import TestClient
from pydantic import SecretStr
from sqlalchemy.orm import Session, sessionmaker

from app.api.routes import transcription_settings
from app.models.transcription import RealtimeTranscriptionSettings


def app_settings(key: str) -> SimpleNamespace:
    return SimpleNamespace(
        master_encryption_key=SecretStr(key),
        azure_speech_timeout_seconds=10.0,
    )


def test_azure_speech_settings_encrypt_key_and_never_return_it(
    client: TestClient,
    session_factory: sessionmaker[Session],
    monkeypatch,
) -> None:
    encryption_key = Fernet.generate_key().decode("ascii")
    monkeypatch.setattr(
        transcription_settings,
        "get_app_settings",
        lambda: app_settings(encryption_key),
    )
    secret = "azure-speech-secret-key"

    response = client.put(
        "/api/v1/transcription/realtime-settings",
        json={
            "provider": "azure_speech",
            "azure_region": "JapanEast",
            "azure_language": "ja-JP",
            "api_key": secret,
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["provider"] == "azure_speech"
    assert body["azure_region"] == "japaneast"
    assert body["has_api_key"] is True
    assert secret not in response.text

    with session_factory() as session:
        settings = session.get(RealtimeTranscriptionSettings, 1)
        assert settings is not None
        assert settings.encrypted_api_key is not None
        assert secret not in settings.encrypted_api_key


def test_azure_speech_settings_require_region_and_key(
    client: TestClient,
) -> None:
    response = client.put(
        "/api/v1/transcription/realtime-settings",
        json={"provider": "azure_speech", "azure_language": "ja-JP"},
    )

    assert response.status_code == 422
    assert "リージョン" in response.json()["detail"]


def test_azure_speech_connection_uses_saved_secret(
    client: TestClient,
    monkeypatch,
) -> None:
    encryption_key = Fernet.generate_key().decode("ascii")
    monkeypatch.setattr(
        transcription_settings,
        "get_app_settings",
        lambda: app_settings(encryption_key),
    )
    tested_keys: list[str] = []
    monkeypatch.setattr(
        transcription_settings.AzureSpeechClient,
        "test_connection",
        lambda self: tested_keys.append(self.api_key),
    )
    saved = client.put(
        "/api/v1/transcription/realtime-settings",
        json={
            "provider": "azure_speech",
            "azure_region": "japaneast",
            "azure_language": "ja-JP",
            "api_key": "saved-secret",
        },
    )
    assert saved.status_code == 200

    response = client.post("/api/v1/transcription/realtime-settings/test")

    assert response.status_code == 200
    assert tested_keys == ["saved-secret"]
    assert "saved-secret" not in response.text

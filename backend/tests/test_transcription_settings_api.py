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


def test_soniox_realtime_settings_encrypt_key_and_never_return_it(
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
    secret = "soniox-realtime-secret-key"

    response = client.put(
        "/api/v1/transcription/realtime-settings",
        json={
            "provider": "soniox",
            "soniox_model": "stt-rt-v5",
            "soniox_api_key": secret,
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["provider"] == "soniox"
    assert body["soniox_model"] == "stt-rt-v5"
    assert body["has_soniox_api_key"] is True
    assert secret not in response.text

    with session_factory() as session:
        settings = session.get(RealtimeTranscriptionSettings, 1)
        assert settings is not None
        assert settings.soniox_encrypted_api_key is not None
        assert secret not in settings.soniox_encrypted_api_key


def test_realtime_settings_reject_retired_providers_and_require_soniox_key(
    client: TestClient,
) -> None:
    for provider in ["azure_speech", "whisperx"]:
        response = client.put(
            "/api/v1/transcription/realtime-settings",
            json={"provider": provider},
        )
        assert response.status_code == 422
        assert response.json()["detail"][0]["loc"] == ["body", "provider"]
    response = client.put("/api/v1/transcription/realtime-settings", json={"provider": "soniox"})
    assert response.status_code == 422 and "Key" in response.json()["detail"]


def test_soniox_realtime_connection_uses_saved_secret(
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
        transcription_settings.SonioxClient,
        "test_connection",
        lambda self: tested_keys.append(self.api_key),
    )
    temporary_keys: list[str] = []
    monkeypatch.setattr(
        transcription_settings.SonioxClient,
        "temporary_key",
        lambda self, _id: temporary_keys.append(self.api_key) or {"api_key": "temporary"},
    )
    saved = client.put(
        "/api/v1/transcription/realtime-settings",
        json={
            "provider": "soniox",
            "soniox_api_key": "saved-secret",
        },
    )
    assert saved.status_code == 200

    response = client.post("/api/v1/transcription/realtime-settings/test")

    assert response.status_code == 200
    assert tested_keys == ["saved-secret"]
    assert temporary_keys == ["saved-secret"]
    assert "saved-secret" not in response.text

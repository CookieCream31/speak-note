from types import SimpleNamespace

from cryptography.fernet import Fernet
from fastapi.testclient import TestClient
from pydantic import SecretStr
from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from app.api.routes import ai_settings
from app.models.ai import AIProviderConfig


def settings_with_key(key: str) -> SimpleNamespace:
    return SimpleNamespace(
        master_encryption_key=SecretStr(key),
        ollama_allowed_host_list=["host.docker.internal", "localhost", "127.0.0.1"],
    )


def test_gemini_secret_is_encrypted_and_never_returned(
    client: TestClient,
    session_factory: sessionmaker[Session],
    monkeypatch,
) -> None:
    key = Fernet.generate_key().decode("ascii")
    monkeypatch.setattr(ai_settings, "get_settings", lambda: settings_with_key(key))
    secret = "AIza-secret-value-XYZ"

    response = client.post(
        "/api/v1/ai/providers",
        json={
            "provider_type": "gemini",
            "name": "Gemini high accuracy",
            "enabled": True,
            "api_key": secret,
        },
    )

    assert response.status_code == 201
    body = response.json()
    assert body["has_api_key"] is True
    assert body["api_key_masked"] == "AIza••••••••XYZ"
    assert "model" not in body
    assert "temperature" not in body
    assert "api_key" not in body
    assert secret not in response.text

    with session_factory() as session:
        provider = session.scalar(select(AIProviderConfig))
        assert provider is not None
        assert provider.encrypted_api_key is not None
        assert secret not in provider.encrypted_api_key

    listed = client.get("/api/v1/ai/providers")
    assert listed.status_code == 200
    assert secret not in listed.text


def test_ollama_profile_usage_and_meeting_selection(
    client: TestClient,
    monkeypatch,
) -> None:
    key = Fernet.generate_key().decode("ascii")
    monkeypatch.setattr(ai_settings, "get_settings", lambda: settings_with_key(key))
    provider_response = client.post(
        "/api/v1/ai/providers",
        json={
            "provider_type": "ollama",
            "name": "Local Ollama",
            "base_url": "http://host.docker.internal:11434/",
            "enabled": True,
        },
    )
    assert provider_response.status_code == 201
    provider = provider_response.json()
    assert provider["base_url"] == "http://host.docker.internal:11434"

    profile_response = client.post(
        "/api/v1/ai/profiles",
        json={
            "name": "Local",
            "provider_id": provider["id"],
            "model": "qwen3:8b",
            "temperature": 0.2,
            "is_default": True,
        },
    )
    assert profile_response.status_code == 201
    profile = profile_response.json()

    usage_response = client.put(
        "/api/v1/ai/usage/final_minutes",
        json={"profile_id": profile["id"], "disabled": False},
    )
    assert usage_response.status_code == 200
    assert usage_response.json()["profile_id"] == profile["id"]

    meeting_response = client.post(
        "/api/v1/meetings",
        json={"title": "AI meeting", "source_type": "audio_upload"},
    )
    meeting_id = meeting_response.json()["id"]
    selection = client.patch(
        f"/api/v1/meetings/{meeting_id}/ai-profile",
        json={"mode": "profile", "profile_id": profile["id"]},
    )
    assert selection.status_code == 200
    assert selection.json()["ai_profile_id"] == profile["id"]
    assert selection.json()["ai_disabled"] is False

    disabled = client.patch(
        f"/api/v1/meetings/{meeting_id}/ai-profile",
        json={"mode": "none", "profile_id": None},
    )
    assert disabled.status_code == 200
    assert disabled.json()["ai_profile_id"] is None
    assert disabled.json()["ai_disabled"] is True


def test_ollama_private_url_requires_allowlist(client: TestClient, monkeypatch) -> None:
    key = Fernet.generate_key().decode("ascii")
    monkeypatch.setattr(
        ai_settings,
        "get_settings",
        lambda: SimpleNamespace(
            master_encryption_key=SecretStr(key),
            ollama_allowed_host_list=[],
        ),
    )
    response = client.post(
        "/api/v1/ai/providers",
        json={
            "provider_type": "ollama",
            "name": "Blocked",
            "base_url": "http://127.0.0.1:11434",
        },
    )
    assert response.status_code == 422
    assert "OLLAMA_ALLOWED_HOSTS" in response.json()["detail"]

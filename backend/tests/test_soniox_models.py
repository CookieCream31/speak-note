import json

import httpx
import pytest
from cryptography.fernet import Fernet
from pydantic import SecretStr

from app.api.routes import transcription_settings
from app.core.config import Settings
from app.models.transcription import AsyncTranscriptionSettings, RealtimeTranscriptionSettings
from app.schemas.transcription_settings import SonioxModelListRequest
from app.services.llm import SecretCipher
from app.services.transcription.soniox import SonioxClient, SonioxError

MODELS = [
    {"id": "stt-rt-v5", "name": "Realtime v5", "transcription_mode": "real_time"},
    {"id": "stt-async-v5", "name": "Async v5", "transcription_mode": "async"},
    {"id": "stt-rt-v6", "name": "Realtime v6", "transcription_mode": "real_time"},
]


@pytest.fixture
def model_api(monkeypatch):
    encryption_key = Fernet.generate_key().decode()
    cipher = SecretCipher(encryption_key)
    settings = Settings(master_encryption_key=SecretStr(encryption_key), _env_file=None)
    monkeypatch.setattr(transcription_settings, "get_app_settings", lambda: settings)
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(200, json={"models": MODELS})

    monkeypatch.setattr(
        transcription_settings,
        "SonioxClient",
        lambda key: SonioxClient(
            key, transport=httpx.MockTransport(handler), poll_interval_seconds=0
        ),
    )
    return calls, cipher


@pytest.mark.parametrize("purpose", ["realtime", "async"])
def test_draft_key_lists_only_matching_models_without_saving(client, model_api, purpose):
    calls, _ = model_api
    before = [
        client.get(f"/api/v1/transcription/{kind}-settings").json()
        for kind in ("realtime", "async")
    ]
    response = client.post(
        "/api/v1/transcription/soniox-models",
        json={"purpose": purpose, "soniox_api_key": " draft-private-key "},
    )
    assert response.status_code == 200
    expected = [
        {"id": model["id"], "name": model["name"]}
        for model in MODELS
        if model["transcription_mode"] == ("real_time" if purpose == "realtime" else "async")
    ]
    assert response.json() == {"models": expected}
    assert response.headers["cache-control"] == "no-store"
    assert len(calls) == 1 and calls[0].method == "GET"
    assert str(calls[0].url) == "https://api.soniox.com/v1/models"
    assert calls[0].headers["authorization"] == "Bearer draft-private-key"
    assert "draft-private-key" not in response.text
    assert [
        client.get(f"/api/v1/transcription/{kind}-settings").json()
        for kind in ("realtime", "async")
    ] == before
    assert "draft-private-key" not in repr(
        SonioxModelListRequest(purpose=purpose, soniox_api_key="draft-private-key")
    )


@pytest.mark.parametrize("purpose", ["realtime", "async"])
def test_saved_key_is_selected_by_purpose_and_draft_does_not_replace_it(
    client, session_factory, model_api, purpose
):
    calls, cipher = model_api
    for kind in ("realtime", "async"):
        assert (
            client.put(
                f"/api/v1/transcription/{kind}-settings",
                json={"provider": "soniox", "soniox_api_key": f"{kind}-saved-key"},
            ).status_code
            == 200
        )
    assert (
        client.post("/api/v1/transcription/soniox-models", json={"purpose": purpose}).status_code
        == 200
    )
    assert calls[-1].headers["authorization"] == f"Bearer {purpose}-saved-key"
    assert (
        client.post(
            "/api/v1/transcription/soniox-models",
            json={"purpose": purpose, "soniox_api_key": "replacement-draft"},
        ).status_code
        == 200
    )
    assert calls[-1].headers["authorization"] == "Bearer replacement-draft"
    with session_factory() as db:
        for model, kind in (
            (RealtimeTranscriptionSettings, "realtime"),
            (AsyncTranscriptionSettings, "async"),
        ):
            assert cipher.decrypt(db.get(model, 1).soniox_encrypted_api_key) == f"{kind}-saved-key"


@pytest.mark.parametrize("purpose", ["realtime", "async"])
def test_missing_key_does_not_use_the_other_purpose_key(client, model_api, purpose):
    calls, _ = model_api
    other = "async" if purpose == "realtime" else "realtime"
    client.put(
        f"/api/v1/transcription/{other}-settings",
        json={"provider": "soniox", "soniox_api_key": "other-purpose-key"},
    )
    response = client.post("/api/v1/transcription/soniox-models", json={"purpose": purpose})
    assert response.status_code == 422 and not calls


@pytest.mark.parametrize("status", [401, 403, 503])
def test_model_api_failure_keeps_settings_and_redacts_provider_body(
    client, monkeypatch, model_api, status
):
    before = client.get("/api/v1/transcription/async-settings").json()
    monkeypatch.setattr(
        transcription_settings,
        "SonioxClient",
        lambda key: SonioxClient(
            key,
            transport=httpx.MockTransport(
                lambda request: httpx.Response(
                    status, json={"message": "sensitive-key-provider-body"}
                )
            ),
            poll_interval_seconds=0,
        ),
    )
    response = client.post(
        "/api/v1/transcription/soniox-models",
        json={"purpose": "async", "soniox_api_key": "sensitive-key"},
    )
    assert response.status_code == 502
    assert str(status) in response.json()["detail"]
    assert "sensitive-key" not in response.text
    assert client.get("/api/v1/transcription/async-settings").json() == before


@pytest.mark.parametrize(
    "payload",
    [
        {"models": None},
        {"models": [None]},
        {"models": [{"transcription_mode": "async", "id": "stt-rt-v5"}]},
        {"models": [{"transcription_mode": "async", "id": "stt-async-v5", "name": []}]},
    ],
)
def test_model_metadata_is_validated_without_leaking_raw_response(payload):
    runtime = SonioxClient(
        "test-key", transport=httpx.MockTransport(lambda request: httpx.Response(200, json=payload))
    )
    with pytest.raises(SonioxError, match="一覧の形式が不正"):
        runtime.list_models(realtime=False)


def test_empty_model_list_and_invalid_request_do_not_change_settings(
    client, model_api, monkeypatch
):
    before = client.get("/api/v1/transcription/async-settings").json()
    monkeypatch.setattr(
        transcription_settings,
        "SonioxClient",
        lambda key: SonioxClient(
            key,
            transport=httpx.MockTransport(lambda request: httpx.Response(200, json={"models": []})),
        ),
    )
    assert (
        client.post(
            "/api/v1/transcription/soniox-models",
            json={"purpose": "unknown", "soniox_api_key": "test-key"},
        ).status_code
        == 422
    )
    response = client.post(
        "/api/v1/transcription/soniox-models",
        json={"purpose": "async", "soniox_api_key": "test-key"},
    )
    assert response.status_code == 200 and json.loads(response.content) == {"models": []}
    assert client.get("/api/v1/transcription/async-settings").json() == before

import uuid

import httpx
import pytest
from sqlalchemy import func, select
from test_meeting_transcription_languages import configured as configured

from app.models import Job, Meeting, RealtimeSession, TranscriptSegment
from app.models.translation import RealtimeTranslation
from app.schemas.translation import StreamingTranslation
from app.services.realtime.capture import RealtimeCaptureError
from app.services.realtime.translation import append_translation
from app.services.transcription.settings import snapshot_async_transcription
from app.services.transcription.soniox import SonioxClient, SonioxError

ONE = {"type": "one_way", "target_language": "ja"}
TWO = {"type": "two_way", "language_a": "en", "language_b": "ja"}


def create(client, config=ONE, source="audio_recording"):
    return client.post(
        "/api/v1/meetings",
        json={"title": "翻訳の会議", "source_type": source, "realtime_translation": config},
    )


@pytest.mark.parametrize("config", [None, ONE, TWO])
def test_settings_are_per_meeting_and_async_engine_is_independent(
    client, configured, session_factory, config
):
    assert (
        client.put(
            "/api/v1/transcription/async-settings", json={"provider": "whisperx"}
        ).status_code
        == 200
    )
    response = create(client, config)
    assert response.status_code == 201
    assert response.json()["realtime_translation"] == config
    options = client.get("/api/v1/transcription/language-options").json()
    assert options["supports_translation"] is True and options["supports_auto"] is False
    assert (
        client.get("/api/v1/transcription/language-options?include_realtime=false").json()[
            "supports_translation"
        ]
        is False
    )
    other = create(client, None).json()
    assert other["realtime_translation"] is None
    with session_factory() as db:
        meeting = db.get(Meeting, uuid.UUID(response.json()["id"]))
        assert "translation" not in snapshot_async_transcription(db, meeting)


@pytest.mark.parametrize(
    "config",
    [
        {"type": "invalid", "target_language": "ja"},
        {"type": "one_way"},
        {"type": "one_way", "target_language": "zz"},
        {"type": "one_way", "target_language": "ja", "api_key": "ignored"},
        {"type": "two_way", "language_a": "ja", "language_b": "ja"},
    ],
)
def test_invalid_settings_do_not_create_meetings(client, configured, session_factory, config):
    assert create(client, config).status_code == 422
    with session_factory() as db:
        assert db.scalar(select(func.count()).select_from(Meeting)) == 0
        assert db.scalar(select(func.count()).select_from(Job)) == 0


def test_uploads_and_non_soniox_cannot_enable_translation(client, configured):
    assert create(client, ONE, "media_upload").status_code == 422
    assert (
        client.put(
            "/api/v1/transcription/realtime-settings", json={"provider": "whisperx"}
        ).status_code
        == 200
    )
    assert create(client).status_code == 422
    assert create(client, None).status_code == 201


def test_snapshot_tokens_and_separate_translation_history_survive_reconnect(
    client, configured, session_factory, monkeypatch
):
    monkeypatch.setattr(SonioxClient, "validate_language_options", lambda *args, **kwargs: None)
    monkeypatch.setattr(
        SonioxClient,
        "temporary_key",
        lambda *args: {"api_key": "temporary", "expires_at": "2026-10-12T01:00:00Z"},
    )
    meeting = create(client).json()
    url = f"/api/v1/meetings/{meeting['id']}"
    base = f"{url}/live"
    payload = {
        "type": "soniox_translation",
        "result_id": "connection:translation:0",
        "text": "こんにちは",
        "source_language": "en",
        "target_language": "ja",
        "speaker_label": "話者 1",
    }
    with client.websocket_connect(f"{base}/ws") as ws:
        ws.send_json({"type": "start", "mime_type": "audio/webm", "has_system_audio": False})
        assert ws.receive_json()["type"] == "started"
        assert client.patch(url, json={"realtime_translation": TWO}).status_code == 409
        with session_factory() as db:
            db.get(Meeting, uuid.UUID(meeting["id"])).realtime_translation = TWO
            db.commit()
        for _ in range(2):
            assert client.post(f"{base}/soniox-token").json()["translation"] == ONE
        ws.send_json(payload)
        saved = ws.receive_json()
        assert saved["type"] == "soniox_translation_saved"
        ws.send_json(payload)
        assert ws.receive_json()["translation_id"] == saved["translation_id"]
        ws.send_json(
            {
                "type": "soniox_result",
                "result_id": "original:0",
                "text": "Hello",
                "start_ms": 100,
                "end_ms": 500,
                "speaker_label": "話者 1",
            }
        )
        assert ws.receive_json()["type"] == "soniox_result_saved"
        ws.send_json({"type": "chunk", "sequence": 0, "start_ms": 0, "end_ms": 1500})
        ws.send_bytes(b"audio")
        assert ws.receive_json()["type"] == "chunk_saved"
    live = client.get(base).json()
    assert [row["text"] for row in live["segments"]] == ["Hello"]
    assert [row["text"] for row in live["translations"]] == ["こんにちは"]
    assert "start_ms" not in live["translations"][0]
    assert live["translation"] == ONE
    assert client.patch(url, json={"realtime_translation": None}).status_code == 409
    with session_factory() as db:
        assert db.scalar(select(func.count()).select_from(RealtimeTranslation)) == 1
        assert db.scalar(select(func.count()).select_from(TranscriptSegment)) == 1
        recording = db.scalar(select(RealtimeSession))
        replay = StreamingTranslation.model_validate(
            {key: value for key, value in payload.items() if key != "type"}
        )
        assert str(append_translation(db, recording.id, replay).id) == saved["translation_id"]
        with pytest.raises(RealtimeCaptureError, match="異なる結果"):
            append_translation(db, recording.id, replay.model_copy(update={"text": "書き換え"}))
        with pytest.raises(RealtimeCaptureError, match="録音終了後"):
            append_translation(db, recording.id, replay.model_copy(update={"result_id": "new"}))
        assert db.get(RealtimeTranslation, uuid.UUID(saved["translation_id"])).text == "こんにちは"


@pytest.mark.parametrize(
    "source,target,valid", [("en", "ja", True), ("ja", "en", True), ("fr", "ja", False)]
)
def test_two_way_only_accepts_the_saved_pair(
    client, configured, session_factory, source, target, valid
):
    meeting = create(client, TWO).json()
    with client.websocket_connect(f"/api/v1/meetings/{meeting['id']}/live/ws") as ws:
        ws.send_json({"type": "start", "mime_type": "audio/webm", "has_system_audio": False})
        assert ws.receive_json()["type"] == "started"
        ws.send_json(
            {
                "type": "soniox_translation",
                "result_id": "translation:1",
                "text": "翻訳",
                "source_language": source,
                "target_language": target,
            }
        )
        result = ws.receive_json()
        assert result["type"] == (
            "soniox_translation_saved" if valid else "soniox_translation_error"
        )
        ws.send_json({"type": "ping"})
        assert ws.receive_json()["type"] == "pong"
        ws.send_json({"type": "chunk", "sequence": 0, "start_ms": 0, "end_ms": 1500})
        ws.send_bytes(b"audio")
        assert ws.receive_json()["type"] == "chunk_saved"
    with session_factory() as db:
        assert db.scalar(select(func.count()).select_from(RealtimeTranslation)) == int(valid)
        assert db.scalar(select(func.count()).select_from(TranscriptSegment)) == 0


@pytest.mark.parametrize(
    "support,codes,error",
    [
        ("all_languages", ["ja", "en"], None),
        ("none", ["ja", "en"], "翻訳対応"),
        ("all_languages", ["en"], "翻訳言語"),
    ],
)
@pytest.mark.parametrize("config", [ONE, TWO])
def test_translation_capabilities_are_checked_before_key_or_audio(support, codes, error, config):
    calls = []

    def respond(request):
        calls.append((request.method, request.url.path))
        return httpx.Response(
            200,
            json={
                "models": [
                    {
                        "id": "stt-rt-v5",
                        "transcription_mode": "real_time",
                        "languages": [{"code": code} for code in codes],
                        "one_way_translation": support,
                        "two_way_translation": support,
                    }
                ]
            },
        )

    client = SonioxClient(
        "secret",
        model="stt-rt-v5",
        language_hints=[],
        translation=config,
        transport=httpx.MockTransport(respond),
    )
    if error:
        with pytest.raises(SonioxError, match=error):
            client.validate_language_options(realtime=True)
    else:
        client.validate_language_options(realtime=True)
    assert calls == [("GET", "/v1/models")]

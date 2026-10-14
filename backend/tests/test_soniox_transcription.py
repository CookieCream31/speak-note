import json
import uuid

import httpx
import pytest
from cryptography.fernet import Fernet
from pydantic import SecretStr
from sqlalchemy import func, select
from test_summary_regeneration import seed

from app.api.dependencies import get_storage
from app.api.routes import realtime, transcription_settings
from app.core.config import Settings
from app.main import app
from app.models import (
    AnalysisVersion,
    AsyncTranscriptionSettings,
    Job,
    JobType,
    Meeting,
    MeetingSourceType,
    RealtimeTranscriptionSettings,
    TranscriptKind,
    TranscriptSegment,
    TranscriptVersion,
)
from app.services.media import MediaStorage
from app.services.transcription.processor import process_transcription_job
from app.services.transcription.settings import build_final_transcription_client
from app.services.transcription.soniox import SonioxClient, SonioxError, normalize_soniox_transcript

FILE_ID = "e9f019b9-909d-4273-9657-451578854001"
TRANSCRIPTION_ID = "e9f019b9-909d-4273-9657-451578854002"
SECRET = "test-soniox-permanent-secret"
TOKENS = [
    {"text": "Hel", "start_ms": 125, "end_ms": 200, "speaker": "1", "confidence": 0.9},
    {"text": "lo", "start_ms": 200, "end_ms": 325, "speaker": "1", "confidence": 0.95},
    {"text": " world.", "start_ms": 325, "end_ms": 1100, "speaker": "1"},
    {"text": "はい。", "start_ms": 1200, "end_ms": 2000, "speaker": "2"},
]


@pytest.fixture
def soniox_settings(client, monkeypatch):
    key = Fernet.generate_key().decode()
    settings = Settings(master_encryption_key=SecretStr(key), _env_file=None)
    monkeypatch.setattr(transcription_settings, "get_app_settings", lambda: settings)
    monkeypatch.setattr(realtime, "get_settings", lambda: settings)
    for name in ("realtime", "async"):
        response = client.put(
            f"/api/v1/transcription/{name}-settings",
            json={
                "provider": "soniox",
                "soniox_api_key": SECRET,
                "soniox_model": "stt-rt-v5" if name == "realtime" else "stt-async-v5",
                "soniox_language": "ja",
            },
        )
        assert response.status_code == 200
    return settings


def remote_handler(request):
    assert request.headers["authorization"] == f"Bearer {SECRET}"
    if request.method == "DELETE":
        return httpx.Response(204)
    if request.url.path == "/v1/files":
        return httpx.Response(201, json={"id": FILE_ID})
    if request.url.path == "/v1/transcriptions":
        body = json.loads(request.content)
        assert body["model"] == "stt-async-v5"
        assert body["file_id"] == FILE_ID and body["language_hints"] == ["ja"]
        assert body["enable_speaker_diarization"] is True
        assert "min_speakers" not in body and "audio_url" not in body
        return httpx.Response(201, json={"id": TRANSCRIPTION_ID, "status": "queued"})
    if request.url.path.endswith("/transcript"):
        return httpx.Response(
            200, json={"id": TRANSCRIPTION_ID, "text": "Hello world.はい。", "tokens": TOKENS}
        )
    return httpx.Response(200, json={"status": "completed"})


def test_async_upload_poll_normalize_and_delete_after_copy(tmp_path):
    audio = tmp_path / "private-name.wav"
    audio.write_bytes(b"RIFF")
    requests = []

    def handle(request):
        requests.append((request.method, request.url.path))
        return remote_handler(request)

    checkpoints = []
    client = SonioxClient(
        SECRET, transport=httpx.MockTransport(handle), checkpoint=checkpoints.append
    )
    result = client.transcribe(audio, "audio/wav", min_speakers=2, max_speakers=4)
    assert result.segments[0].text == "Hello world."
    assert result.segments[1].speaker == "SONIOX_SPEAKER_2"
    assert result.segments[0].words[0].start == 0.125
    assert result.raw_response["tokens"] == TOKENS
    assert not any(method == "DELETE" for method, _ in requests)
    assert checkpoints[-1]["transcription_id"] == TRANSCRIPTION_ID
    assert SECRET not in repr(checkpoints)
    client.cleanup()
    assert requests[-2:] == [
        ("DELETE", f"/v1/transcriptions/{TRANSCRIPTION_ID}"),
        ("DELETE", f"/v1/files/{FILE_ID}"),
    ]


def test_async_timeout_retry_reuses_remote_id_without_post(tmp_path):
    audio = tmp_path / "audio.wav"
    audio.write_bytes(b"RIFF")
    states = []
    client = SonioxClient(
        SECRET,
        transport=httpx.MockTransport(remote_handler),
        timeout_seconds=0,
        checkpoint=states.append,
    )
    with pytest.raises(SonioxError, match="タイムアウト"):
        client.transcribe(audio, "audio/wav")
    requests = []

    def resumed(request):
        requests.append(request.method)
        return remote_handler(request)

    result = SonioxClient(
        SECRET, state=states[-1], transport=httpx.MockTransport(resumed)
    ).transcribe(audio, "audio/wav")
    assert result.segments and requests == ["GET", "GET"]


def test_temporary_key_is_single_use_bounded_and_bound_to_session():
    session_id = uuid.uuid4()

    def handler(request):
        assert request.url.path == "/v1/auth/temporary-api-key"
        assert request.headers["authorization"] == f"Bearer {SECRET}"
        assert json.loads(request.content) == {
            "usage_type": "transcribe_websocket",
            "expires_in_seconds": 60,
            "single_use": True,
            "max_session_duration_seconds": 18000,
            "client_reference_id": str(session_id),
        }
        return httpx.Response(
            201, json={"api_key": "short-key", "expires_at": "2026-10-12T01:00:00Z"}
        )

    token = SonioxClient(SECRET, transport=httpx.MockTransport(handler)).temporary_key(session_id)
    assert token["api_key"] == "short-key"


def test_async_polling_waits_for_completion_and_read_errors_retry(tmp_path):
    calls = []

    def handler(request):
        calls.append(request.method)
        if len(calls) == 1:
            return httpx.Response(503)
        if len(calls) == 2:
            return httpx.Response(200, json={"status": "processing"})
        return remote_handler(request)

    client = SonioxClient(
        SECRET,
        state={"file_id": FILE_ID, "transcription_id": TRANSCRIPTION_ID},
        transport=httpx.MockTransport(handler),
        poll_interval_seconds=0,
    )
    assert client.transcribe(tmp_path / "already-uploaded.wav", "audio/wav").segments
    assert calls == ["GET", "GET", "GET", "GET"]


def test_switching_to_soniox_preserves_azure_configuration(
    client, session_factory, soniox_settings
):
    with session_factory() as db:
        settings = db.get(RealtimeTranscriptionSettings, 1)
        settings.azure_region, settings.azure_language = "japaneast", "en-US"
        settings.encrypted_api_key = "existing-encrypted-azure-key"
        db.commit()
    changed = client.put("/api/v1/transcription/realtime-settings", json={"provider": "soniox"})
    assert changed.status_code == 200
    assert (
        changed.json()["azure_region"] == "japaneast"
        and changed.json()["azure_language"] == "en-US"
    )
    with session_factory() as db:
        assert (
            db.get(RealtimeTranscriptionSettings, 1).encrypted_api_key
            == "existing-encrypted-azure-key"
        )


def test_upload_job_snapshots_async_provider_and_legacy_jobs_stay_whisperx(
    client, session_factory, tmp_path, soniox_settings
):
    app.dependency_overrides[get_storage] = lambda: MediaStorage(tmp_path, 1)
    meeting_id = client.post(
        "/api/v1/meetings", json={"title": "Upload Soniox", "source_type": "audio_upload"}
    ).json()["id"]
    uploaded = client.post(
        f"/api/v1/meetings/{meeting_id}/audio",
        files={"file": ("audio.mp3", b"ID3-audio", "audio/mpeg")},
    )
    assert uploaded.status_code == 202
    with session_factory() as db:
        job = db.get(Job, uuid.UUID(uploaded.json()["job"]["id"]))
        assert job.transcription_request == {
            "provider": "soniox",
            "model": "stt-async-v5",
            "language": "ja",
            "language_hints": ["ja"],
            "language_hints_strict": False,
        }
        assert (
            build_final_transcription_client(
                db, Job(meeting_id=uuid.UUID(meeting_id), type=JobType.TRANSCRIBE), soniox_settings
            ).model
            == "large-v3"
        )
    app.dependency_overrides.pop(get_storage, None)


def test_ambiguous_submission_recovers_id_and_never_resends(tmp_path):
    reference = str(uuid.uuid4())

    def handler(request):
        assert request.method != "POST"
        if request.url.path == "/v1/transcriptions":
            return httpx.Response(
                200,
                json={
                    "transcriptions": [{"id": TRANSCRIPTION_ID, "client_reference_id": reference}],
                    "next_page_cursor": None,
                },
            )
        return remote_handler(request)

    client = SonioxClient(
        SECRET,
        state={
            "reference_id": reference,
            "file_id": FILE_ID,
            "submission_pending": "transcriptions",
        },
        transport=httpx.MockTransport(handler),
    )
    assert client.transcribe(tmp_path / "not-read.wav", "audio/wav").segments


def test_ambiguous_submission_without_match_stops_instead_of_duplicate(tmp_path):
    requests = []

    def handler(request):
        requests.append(request.method)
        return httpx.Response(200, json={"files": [], "next_page_cursor": None})

    client = SonioxClient(
        SECRET,
        state={"reference_id": "unique-job", "submission_pending": "files"},
        transport=httpx.MockTransport(handler),
    )
    with pytest.raises(SonioxError, match="二重送信"):
        client.transcribe(tmp_path / "missing.wav", "audio/wav")
    assert requests == ["GET"]


@pytest.mark.parametrize("status", [401, 402, 429, 500])
def test_provider_errors_do_not_leak_body_or_retry_post(tmp_path, status):
    audio = tmp_path / "audio.wav"
    audio.write_bytes(b"RIFF")
    requests = []

    def handler(request):
        requests.append(request)
        return httpx.Response(status, json={"message": SECRET})

    client = SonioxClient(SECRET, transport=httpx.MockTransport(handler))
    with pytest.raises(SonioxError) as caught:
        client.transcribe(audio, "audio/wav")
    assert SECRET not in str(caught.value)
    assert len(requests) == 1


@pytest.mark.parametrize(
    "tokens", [[{"text": "時刻なし"}], [{"text": "bad", "start_ms": 20, "end_ms": 10}], []]
)
def test_invalid_soniox_output_is_rejected(tokens):
    with pytest.raises(SonioxError):
        normalize_soniox_transcript({"tokens": tokens})


def test_independent_settings_encrypt_keys_and_invalid_update_preserves_saved(
    client, session_factory, soniox_settings
):
    changed = client.put("/api/v1/transcription/async-settings", json={"provider": "whisperx"})
    assert changed.status_code == 200
    assert client.get("/api/v1/transcription/realtime-settings").json()["provider"] == "soniox"
    invalid = client.put(
        "/api/v1/transcription/async-settings",
        json={"provider": "soniox", "soniox_model": "stt-rt-v5"},
    )
    assert invalid.status_code == 422
    assert client.get("/api/v1/transcription/async-settings").json()["provider"] == "whisperx"
    for path in ("realtime", "async"):
        assert SECRET not in client.get(f"/api/v1/transcription/{path}-settings").text
    with session_factory() as db:
        for model in (AsyncTranscriptionSettings, RealtimeTranscriptionSettings):
            row = db.get(model, 1)
            assert row.soniox_encrypted_api_key and SECRET not in row.soniox_encrypted_api_key


def test_first_final_uses_frozen_soniox_and_ai_template_then_reuses_final(
    client, session_factory, tmp_path, soniox_settings
):
    with session_factory() as db:
        meeting, live, _, profile, template, media = seed(db, final=False)
        meeting.ai_disabled = True
        meeting_id, profile_id, template_id = meeting.id, profile.id, template.id
        audio_path = tmp_path / media.storage_path
        audio_path.write_bytes(b"audio")
        db.commit()
    path = f"/api/v1/meetings/{meeting_id}/analyses"
    payload = {
        "profile_id": str(profile_id),
        "template_id": str(template_id),
        "request_id": str(uuid.uuid4()),
    }
    started = client.post(path, json=payload)
    assert started.status_code == 202
    assert client.post(path, json=payload).json()["job_id"] == started.json()["job_id"]
    assert client.post(path, json={**payload, "request_id": str(uuid.uuid4())}).status_code == 409
    client.put(
        "/api/v1/transcription/async-settings",
        json={"provider": "whisperx", "soniox_model": "stt-async-v4", "soniox_language": "en"},
    )
    with session_factory() as db:
        job = db.get(Job, uuid.UUID(started.json()["job_id"]))
        runtime = build_final_transcription_client(db, job, soniox_settings)
        assert (
            isinstance(runtime, SonioxClient)
            and runtime.model == "stt-async-v5"
            and runtime.language == "ja"
        )
        runtime.transport = httpx.MockTransport(remote_handler)
        process_transcription_job(db, job, runtime, MediaStorage(tmp_path, 1))
        final = db.get(TranscriptVersion, db.get(Meeting, meeting_id).active_transcript_version_id)
        assert final.kind == TranscriptKind.FINAL and final.model == "stt-async-v5"
        assert final.segments[0].start_ms == 125 and final.segments[0].text == "Hello world."
        assert [(word.text, word.start_ms, word.end_ms) for word in final.segments[0].words] == [
            ("Hel", 125, 200),
            ("lo", 200, 325),
            (" world.", 325, 1100),
        ]
        assert final.segments[0].speaker.display_name == "話者 1"
        assert db.get(TranscriptVersion, live.id) is not None
        analysis = db.scalar(select(AnalysisVersion))
        assert analysis.profile_id == profile_id and analysis.template_snapshot["revision"] == 2
        assert analysis.transcript_version_id == final.id
        assert (
            db.scalar(select(func.count()).select_from(Job).where(Job.type == JobType.TRANSCRIBE))
            == 1
        )
        # The completed transcription job cannot submit audio again on continuation retry.
        runtime.transport = httpx.MockTransport(lambda _: pytest.fail("must reuse Final"))
        process_transcription_job(db, job, runtime, MediaStorage(tmp_path, 1))
        # A worker restart after Final must not require a provider key to continue AI.
        process_transcription_job(
            db,
            job,
            lambda: pytest.fail("must not build a provider client"),
            MediaStorage(tmp_path, 1),
        )
    saved = client.get(f"/api/v1/meetings/{meeting_id}/transcript?kind=final")
    assert saved.status_code == 200
    assert [
        (word["text"], word["start_ms"], word["end_ms"])
        for word in saved.json()["segments"][0]["words"]
    ] == [("Hel", 125, 200), ("lo", 200, 325), (" world.", 325, 1100)]


def test_cleanup_failure_preserves_final_and_original(
    client, session_factory, tmp_path, soniox_settings
):
    with session_factory() as db:
        meeting, _, _, _, _, media = seed(db, final=False)
        meeting.ai_disabled = True
        audio = tmp_path / media.storage_path
        audio.write_bytes(b"audio")
        job = Job(
            meeting_id=meeting.id,
            type=JobType.TRANSCRIBE,
            transcription_request={"provider": "soniox", "model": "stt-async-v5", "language": "ja"},
        )
        db.add(job)
        db.commit()
        runtime = build_final_transcription_client(db, job, soniox_settings)

        def handler(request):
            if request.method == "DELETE":
                return httpx.Response(401, json={"message": SECRET})
            return remote_handler(request)

        runtime.transport = httpx.MockTransport(handler)
        process_transcription_job(db, job, runtime, MediaStorage(tmp_path, 1))
        assert job.transcription_request["cleanup_pending"] is True
        assert db.get(Meeting, meeting.id).active_transcript_version_id
        assert audio.read_bytes() == b"audio"


def test_soniox_live_results_are_idempotent_and_not_chunk_jobs(
    client, session_factory, tmp_path, soniox_settings, monkeypatch
):
    app.dependency_overrides[get_storage] = lambda: MediaStorage(tmp_path, 1)
    with session_factory() as db:
        meeting = Meeting(
            title="Soniox Live", source_type=MeetingSourceType.AUDIO_RECORDING, ai_disabled=True
        )
        db.add(meeting)
        db.commit()
        meeting_id = meeting.id
    issued = []

    def temporary(self, session_id):
        issued.append((self.api_key, session_id))
        return {"api_key": "one-use-temporary-key", "expires_at": "2026-10-12T00:00:00Z"}

    monkeypatch.setattr(SonioxClient, "temporary_key", temporary)
    base = f"/api/v1/meetings/{meeting_id}/live"
    assert client.post(f"{base}/soniox-token").status_code == 409
    with client.websocket_connect(f"{base}/ws") as ws:
        # Live settings, including the model, are captured when the session starts.
        ws.send_json(
            {
                "type": "start",
                "capture_mode": "audio",
                "mime_type": "audio/webm",
                "has_system_audio": False,
            }
        )
        started = ws.receive_json()
        assert started["type"] == "started", started
        assert started["transcription_provider"] == "soniox"
        key = client.post(f"{base}/soniox-token")
        assert key.status_code == 200 and SECRET not in key.text
        assert key.headers["cache-control"] == "no-store"
        assert key.json()["model"] == "stt-rt-v5" and issued[0][0] == SECRET
        payload = {
            "type": "soniox_result",
            "result_id": "snx-1",
            "text": "会議の発言",
            "start_ms": 100,
            "end_ms": 1000,
            "speaker_label": "SONIOX_1",
            "confidence": 0.9,
        }
        for _ in range(2):
            ws.send_json(payload)
            ack = ws.receive_json()
            assert ack["type"] == "soniox_result_saved"
        ws.send_json({"type": "chunk", "sequence": 0, "start_ms": 0, "end_ms": 15000})
        ws.send_bytes(b"audio")
        assert ws.receive_json()["type"] == "chunk_saved"
        with session_factory() as db:
            assert db.scalar(select(func.count()).select_from(TranscriptSegment)) == 1
            assert (
                db.scalar(
                    select(func.count()).select_from(Job).where(Job.type == JobType.TRANSCRIBE_LIVE)
                )
                == 0
            )
        ws.send_json({"type": "stop"})
        assert ws.receive_json()["type"] == "finalized"
    assert client.post(f"{base}/soniox-token").status_code == 409
    app.dependency_overrides.pop(get_storage, None)

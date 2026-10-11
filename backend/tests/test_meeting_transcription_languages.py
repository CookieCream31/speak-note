import json
import uuid
from copy import deepcopy

import httpx
import pytest
from cryptography.fernet import Fernet
from pydantic import SecretStr
from sqlalchemy import func, select
from test_summary_regeneration import seed
from test_video_processor import FakeMediaService

from app.api.dependencies import get_storage
from app.api.routes import realtime, transcription_settings
from app.core.config import Settings
from app.main import app
from app.models import (
    AsyncTranscriptionSettings,
    Job,
    JobStatus,
    JobType,
    Meeting,
    MeetingSourceType,
    RealtimeSession,
    RealtimeTranscriptionSettings,
    TranscriptKind,
    TranscriptVersion,
)
from app.models.media import Media, MediaKind
from app.models.realtime import RealtimeSessionStatus
from app.services.jobs import fail_job
from app.services.media import MediaStorage
from app.services.media.processor import process_video_job
from app.services.transcription.languages import AZURE_LOCALES, LANGUAGES
from app.services.transcription.processor import process_transcription_job
from app.services.transcription.settings import (
    build_final_transcription_client,
    build_realtime_transcription_client,
    resolve_realtime_transcription,
    snapshot_async_transcription,
)
from app.services.transcription.soniox import SonioxClient, SonioxError


@pytest.fixture
def configured(client, monkeypatch, tmp_path):
    settings = Settings(
        master_encryption_key=SecretStr(Fernet.generate_key().decode()), _env_file=None
    )
    monkeypatch.setattr(transcription_settings, "get_app_settings", lambda: settings)
    monkeypatch.setattr(realtime, "get_settings", lambda: settings)
    for purpose in ("realtime", "async"):
        assert (
            client.put(
                f"/api/v1/transcription/{purpose}-settings",
                json={
                    "provider": "soniox",
                    "soniox_api_key": "test-secret",
                    "soniox_language": "de",  # New meetings override both historical defaults.
                },
            ).status_code
            == 200
        )
    app.dependency_overrides[get_storage] = lambda: MediaStorage(tmp_path, 1)
    yield settings
    app.dependency_overrides.pop(get_storage, None)


def create(client, hints=None, strict=False, source="audio_recording"):
    payload = {"title": "言語の会議", "source_type": source}
    if hints is not None:
        payload.update(
            transcription_language_hints=hints, transcription_language_hints_strict=strict
        )
    return client.post("/api/v1/meetings", json=payload)


def test_defaults_and_meeting_preferences_do_not_change_global_settings(
    client, session_factory, configured
):
    japanese = create(client).json()
    assert japanese["transcription_language_hints"] == ["ja"]
    assert japanese["transcription_language_hints_strict"] is False
    english = create(client, ["en"], True).json()
    with session_factory() as db:
        meeting = db.get(Meeting, uuid.UUID(english["id"]))
        request = snapshot_async_transcription(db, meeting)
        assert request["language_hints"] == ["en"] and request["language_hints_strict"] is True
        assert resolve_realtime_transcription(db, configured, meeting)[2] == "en"
        for model in (AsyncTranscriptionSettings, RealtimeTranscriptionSettings):
            assert db.get(model, 1).soniox_language == "de"


@pytest.mark.parametrize("hints,strict", [([], False), (["ja", "en"], False), (["fr"], True)])
def test_soniox_auto_multiple_and_strict_are_persisted(client, configured, hints, strict):
    response = create(client, hints, strict)
    assert response.status_code == 201
    saved = client.get(f"/api/v1/meetings/{response.json()['id']}").json()
    assert saved["transcription_language_hints"] == hints
    assert saved["transcription_language_hints_strict"] == strict


@pytest.mark.parametrize(
    "values",
    [
        {"transcription_language_hints": None},
        {"transcription_language_hints": ["JA"]},
        {"transcription_language_hints": ["ja-JP"]},
        {"transcription_language_hints": ["xx"]},
        {"transcription_language_hints": ["ja", "ja"]},
        {"transcription_language_hints": ["ja"] * 65},
        {"transcription_language_hints": [], "transcription_language_hints_strict": True},
        {"transcription_language_hints_strict": None},
    ],
)
def test_invalid_language_choices_do_not_create_meetings(
    client, session_factory, configured, values
):
    assert (
        client.post(
            "/api/v1/meetings",
            json={"title": "invalid", "source_type": "audio_recording", **values},
        ).status_code
        == 422
    )
    with session_factory() as db:
        assert db.scalar(select(func.count()).select_from(Meeting)) == 0


def test_language_options_are_read_only_and_respect_capture_method(
    client, session_factory, configured
):
    with session_factory() as db:
        db.get(RealtimeTranscriptionSettings, 1).provider = "whisperx"
        db.commit()
    upload = client.get("/api/v1/transcription/language-options?include_realtime=false").json()
    assert upload["supports_auto"] and upload["supports_multiple"] and upload["supports_strict"]
    capture = client.get("/api/v1/transcription/language-options").json()
    assert (
        not capture["supports_auto"]
        and not capture["supports_multiple"]
        and capture["supports_strict"]
    )
    assert create(client, ["ja", "en"]).status_code == 422
    assert create(client, ["ja", "en"], source="media_upload").status_code == 201
    assert create(client, ["ja"], True).status_code == 201
    assert len(LANGUAGES) == len(set(LANGUAGES))
    assert AZURE_LOCALES["ja"] == "ja-JP" and AZURE_LOCALES["en"] == "en-US"


@pytest.mark.parametrize(
    "status", ["recording", "uploading", "queued", "preprocessing", "transcribing", "analyzing"]
)
def test_processing_status_blocks_language_edits(client, session_factory, configured, status):
    meeting = create(client).json()
    with session_factory() as db:
        db.get(Meeting, uuid.UUID(meeting["id"])).status = status
        db.commit()
    response = client.patch(
        f"/api/v1/meetings/{meeting['id']}", json={"transcription_language_hints": ["en"]}
    )
    assert response.status_code == 409
    assert client.get(f"/api/v1/meetings/{meeting['id']}").json()[
        "transcription_language_hints"
    ] == ["ja"]


@pytest.mark.parametrize("status", [JobStatus.QUEUED, JobStatus.RUNNING])
def test_active_job_blocks_language_edits_even_with_stale_meeting_status(
    client, session_factory, configured, status
):
    meeting = create(client).json()
    with session_factory() as db:
        db.add(Job(meeting_id=uuid.UUID(meeting["id"]), type=JobType.TRANSCRIBE, status=status))
        db.commit()
    assert (
        client.patch(
            f"/api/v1/meetings/{meeting['id']}", json={"transcription_language_hints": ["en"]}
        ).status_code
        == 409
    )


def test_patch_validates_effective_strict_and_auto_and_preserves_existing_title(client, configured):
    meeting = create(client, ["en"], True).json()
    path = f"/api/v1/meetings/{meeting['id']}"
    for payload in (
        {"transcription_language_hints": []},
        {"transcription_language_hints": None},
        {"transcription_language_hints_strict": None},
    ):
        assert client.patch(path, json={"title": "must not change", **payload}).status_code == 422
        assert client.get(path).json()["title"] == meeting["title"]
    assert (
        client.patch(
            path,
            json={"transcription_language_hints": [], "transcription_language_hints_strict": False},
        ).status_code
        == 200
    )


def test_live_language_snapshot_survives_global_changes_and_token_renewal(
    client, session_factory, configured, monkeypatch
):
    seen = []
    monkeypatch.setattr(
        SonioxClient,
        "validate_language_options",
        lambda self, **kwargs: seen.append(
            (self.model, self.language_hints, self.language_hints_strict)
        ),
    )
    monkeypatch.setattr(
        SonioxClient,
        "temporary_key",
        lambda *args: {"api_key": "temporary", "expires_at": "2026-10-12T01:00:00Z"},
    )
    meeting = create(client, ["ja", "en"], True).json()
    base = f"/api/v1/meetings/{meeting['id']}/live"
    with client.websocket_connect(f"{base}/ws") as ws:
        ws.send_json({"type": "start", "mime_type": "audio/webm", "has_system_audio": False})
        assert ws.receive_json()["type"] == "started"
        assert (
            client.patch(
                f"/api/v1/meetings/{meeting['id']}", json={"transcription_language_hints": ["fr"]}
            ).status_code
            == 409
        )
        with session_factory() as db:
            stored = db.get(RealtimeTranscriptionSettings, 1)
            stored.soniox_model, stored.soniox_language = "stt-rt-v6", "fr"
            db.get(Meeting, uuid.UUID(meeting["id"])).transcription_language_hints = ["fr"]
            db.commit()
        for _ in range(2):
            token = client.post(f"{base}/soniox-token")
            assert token.status_code == 200
            assert token.json()["language_hints"] == ["ja", "en"]
            assert token.json()["language_hints_strict"] is True
            assert token.json()["model"] == "stt-rt-v5"
        assert seen == [("stt-rt-v5", ["ja", "en"], True)] * 2
        ws.send_json({"type": "chunk", "sequence": 0, "start_ms": 0, "end_ms": 15000})
        ws.send_bytes(b"audio")
        assert ws.receive_json()["type"] == "chunk_saved"
    with session_factory() as db:
        live = db.scalar(select(RealtimeSession))
        assert live.transcription_request["language_hints"] == ["ja", "en"]
        assert live.status == RealtimeSessionStatus.COMPLETED
        # A finalizing session must also block changes when meeting.status is stale.
        live.status = RealtimeSessionStatus.FINALIZING
        db.commit()
    assert (
        client.patch(
            f"/api/v1/meetings/{meeting['id']}", json={"transcription_language_hints": ["en"]}
        ).status_code
        == 409
    )


def test_whisperx_live_and_azure_use_the_meeting_single_language(
    client, session_factory, tmp_path, configured
):
    from app.services.realtime import start_realtime_session

    with session_factory() as db:
        meeting = Meeting(
            title="English",
            source_type=MeetingSourceType.AUDIO_RECORDING,
            transcription_language_hints=["en"],
        )
        db.add(meeting)
        db.commit()
        stored = db.get(RealtimeTranscriptionSettings, 1)
        stored.provider = "whisperx"
        db.commit()
        assert resolve_realtime_transcription(db, configured, meeting)[2] == "en"
        live = start_realtime_session(
            db,
            meeting,
            MediaStorage(tmp_path, 1),
            mime_type="audio/webm",
            has_system_audio=False,
            model="frozen-model",
            language="en",
        )
        client_instance = build_realtime_transcription_client(db, live, configured)
        assert client_instance.language == "en" and client_instance.model == "frozen-model"
        stored.provider, stored.azure_region, stored.encrypted_api_key = (
            "azure_speech",
            "japaneast",
            "fake-encrypted",
        )
        db.commit()
        assert resolve_realtime_transcription(db, configured, meeting)[2] == "en-US"


def test_first_final_uses_frozen_language_and_passes_selected_ai_and_template(
    client, session_factory, tmp_path, configured
):
    with session_factory() as db:
        meeting, live, _, profile, template, _ = seed(db, final=False)
        meeting.transcription_language_hints, meeting.transcription_language_hints_strict = (
            ["en"],
            True,
        )
        db.commit()
        meeting_id = meeting.id
        payload = {
            "profile_id": str(profile.id),
            "template_id": str(template.id),
            "request_id": str(uuid.uuid4()),
        }
    response = client.post(f"/api/v1/meetings/{meeting_id}/analyses", json=payload)
    assert response.status_code == 202
    assert (
        client.post(f"/api/v1/meetings/{meeting_id}/analyses", json=payload).json()["job_id"]
        == response.json()["job_id"]
    )
    (tmp_path / "test.webm").write_bytes(b"audio")
    posts = []
    file_id, transcript_id = str(uuid.uuid4()), str(uuid.uuid4())

    def remote(request):
        if request.method == "DELETE":
            return httpx.Response(204)
        if request.url.path == "/v1/models":
            return httpx.Response(
                200,
                json={
                    "models": [
                        {
                            "id": "stt-async-v5",
                            "transcription_mode": "async",
                            "languages": [{"code": "en"}],
                            "supports_language_hints_strict": True,
                        }
                    ]
                },
            )
        if request.method == "POST":
            posts.append(request.url.path)
            if request.url.path.endswith("/files"):
                return httpx.Response(201, json={"id": file_id})
            body = json.loads(request.content)
            assert body["language_hints"] == ["en"] and body["language_hints_strict"] is True
            assert body["model"] == "stt-async-v5"
            return httpx.Response(201, json={"id": transcript_id})
        if request.url.path.endswith("/transcript"):
            return httpx.Response(
                200,
                json={
                    "tokens": [
                        {
                            "text": "Saved English audio.",
                            "start_ms": 0,
                            "end_ms": 1000,
                            "speaker": "1",
                        }
                    ]
                },
            )
        return httpx.Response(200, json={"status": "completed"})

    with session_factory() as db:
        job = db.get(Job, uuid.UUID(response.json()["job_id"]))
        snapshot = deepcopy(job.transcription_request)
        meeting = db.get(Meeting, meeting_id)
        meeting.transcription_language_hints = [
            "ja"
        ]  # Simulate later data changes; never read by Worker.
        db.get(AsyncTranscriptionSettings, 1).soniox_model = "stt-async-v6"
        db.commit()
        speech = build_final_transcription_client(db, job, configured)
        speech.transport = httpx.MockTransport(remote)
        process_transcription_job(db, job, speech, MediaStorage(tmp_path, 1))
        assert snapshot["language_hints"] == ["en"]
        assert posts == ["/v1/files", "/v1/transcriptions"]
        final = db.scalar(
            select(TranscriptVersion).where(TranscriptVersion.kind == TranscriptKind.FINAL)
        )
        assert final.language == "en" and final.model == "stt-async-v5"
        assert final.segments[0].text == "Saved English audio."
        assert db.get(TranscriptVersion, live.id).kind == TranscriptKind.LIVE
        analysis_job = db.scalar(select(Job).where(Job.type == JobType.ANALYZE))
        assert analysis_job.analysis_request["profile_id"] == str(profile.id)
        assert analysis_job.analysis_request["template_snapshot"]["template_id"] == str(template.id)


def test_saved_final_blocks_language_edits_and_summary_reuses_it(
    client, session_factory, configured
):
    with session_factory() as db:
        meeting, final, _, profile, template, _ = seed(db)
        meeting_id, final_id = meeting.id, final.id
        payload = {
            "profile_id": str(profile.id),
            "template_id": str(template.id),
            "request_id": str(uuid.uuid4()),
        }
    assert (
        client.patch(
            f"/api/v1/meetings/{meeting_id}", json={"transcription_language_hints": ["en"]}
        ).status_code
        == 409
    )
    assert client.post(f"/api/v1/meetings/{meeting_id}/analyses", json=payload).status_code == 202
    with session_factory() as db:
        assert (
            db.scalar(select(func.count()).select_from(Job).where(Job.type == JobType.TRANSCRIBE))
            == 0
        )
        assert db.get(TranscriptVersion, final_id).segments


@pytest.mark.parametrize(
    "hints,strict,supported",
    [([], False, True), (["ja", "en"], True, True), (["ja"], True, False), (["fr"], False, True)],
)
def test_soniox_validates_capabilities_before_upload_and_omits_auto_hints(
    tmp_path, hints, strict, supported
):
    audio = tmp_path / "audio.wav"
    audio.write_bytes(b"audio")
    requests = []

    def remote(request):
        requests.append(request)
        if request.url.path == "/v1/models":
            return httpx.Response(
                200,
                json={
                    "models": [
                        {
                            "id": "stt-async-v5",
                            "transcription_mode": "async",
                            "languages": [{"code": "ja"}, {"code": "en"}],
                            "supports_language_hints_strict": supported,
                        }
                    ]
                },
            )
        if request.url.path == "/v1/files":
            return httpx.Response(201, json={"id": str(uuid.uuid4())})
        if request.url.path == "/v1/transcriptions":
            body = json.loads(request.content)
            assert body.get("language_hints") == (hints or None)
            assert body["language_hints_strict"] == strict
            return httpx.Response(503)
        raise AssertionError(request.url)

    speech = SonioxClient(
        "test-secret",
        language_hints=hints,
        language_hints_strict=strict,
        transport=httpx.MockTransport(remote),
        poll_interval_seconds=0,
    )
    with pytest.raises(SonioxError):
        speech.transcribe(audio, "audio/wav")
    if (strict and not supported) or hints == ["fr"]:
        assert [item.method for item in requests] == ["GET"]
    else:
        assert [item.method for item in requests] == ["GET", "POST", "POST"]


def test_failure_retains_live_result_and_retry_language_snapshot(
    client, session_factory, configured
):
    with session_factory() as db:
        meeting, live, _, profile, template, _ = seed(db, final=False)
        meeting.transcription_language_hints = ["en"]
        db.commit()
        meeting_id, live_id = meeting.id, live.id
    response = client.post(
        f"/api/v1/meetings/{meeting_id}/analyses",
        json={
            "profile_id": str(profile.id),
            "template_id": str(template.id),
            "request_id": str(uuid.uuid4()),
        },
    )
    with session_factory() as db:
        job = db.get(Job, uuid.UUID(response.json()["job_id"]))
        job.status = JobStatus.RUNNING
        snapshot = deepcopy(job.transcription_request)
        fail_job(db, job, "provider unavailable")
    assert client.post(f"/api/v1/jobs/{job.id}/retry").status_code == 200
    with session_factory() as db:
        assert db.get(Job, job.id).transcription_request == snapshot
        assert db.get(TranscriptVersion, live_id).segments


def test_existing_meetings_and_null_jobs_keep_historical_defaults(session_factory, configured):
    with session_factory() as db:
        legacy = Meeting(title="Legacy", source_type=MeetingSourceType.AUDIO_RECORDING)
        db.add(legacy)
        db.commit()
        assert legacy.transcription_language_hints is None
        assert resolve_realtime_transcription(db, configured, legacy)[2] == "de"
        assert snapshot_async_transcription(db, legacy)["language"] == "de"
        assert "language_hints" not in snapshot_async_transcription(db, legacy)
        job = Job(meeting_id=legacy.id, type=JobType.TRANSCRIBE)
        speech = build_final_transcription_client(db, job, configured)
        assert speech.language == configured.whisperx_language


@pytest.mark.parametrize(
    "options",
    [
        None,
        {
            "provider": "soniox",
            "model": "stt-async-v5",
            "language": "en",
            "language_hints": ["en"],
            "language_hints_strict": True,
        },
    ],
)
def test_video_conversion_preserves_frozen_options_and_legacy_null(
    session_factory,
    configured,
    tmp_path,
    options,
):
    storage = MediaStorage(tmp_path, 1, 1)
    with session_factory() as db:
        meeting = Meeting(
            title="Video",
            source_type=MeetingSourceType.VIDEO_UPLOAD,
            transcription_language_hints=["ja"],
        )
        db.add(meeting)
        db.flush()
        job = Job(
            meeting_id=meeting.id, type=JobType.PREPROCESS_MEDIA, transcription_request=options
        )
        original = Media(
            meeting_id=meeting.id,
            kind=MediaKind.ORIGINAL_VIDEO,
            storage_path="video.mp4",
            mime_type="video/mp4",
            size_bytes=1,
        )
        db.add_all([job, original])
        db.get(AsyncTranscriptionSettings, 1).soniox_model = "stt-async-v6"
        db.commit()
        process_video_job(db, job, FakeMediaService(), storage)
        child = db.scalar(select(Job).where(Job.type == JobType.TRANSCRIBE))
        assert child.transcription_request == options
        speech = build_final_transcription_client(db, child, configured)
        assert speech.model == ("stt-async-v5" if options else configured.whisperx_model)
        assert speech.language == ("en" if options else configured.whisperx_language)

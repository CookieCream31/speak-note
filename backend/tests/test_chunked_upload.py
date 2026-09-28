import uuid
from pathlib import Path
from types import SimpleNamespace

from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from app.api.dependencies import get_storage
from app.api.routes import meetings as meeting_routes
from app.main import app
from app.models.job import Job, JobStatus, JobType
from app.models.media import Media, MediaKind
from app.models.upload import MediaUploadSession, MediaUploadStatus
from app.services.media import MediaStorage


def create_media_meeting(client: TestClient) -> str:
    response = client.post(
        "/api/v1/meetings",
        json={"title": "Chunked media", "source_type": "media_upload"},
    )
    assert response.status_code == 201
    return str(response.json()["id"])


def test_chunked_video_upload_resumes_and_enqueues_job(
    client: TestClient,
    session_factory: sessionmaker[Session],
    tmp_path: Path,
    monkeypatch,
) -> None:
    storage = MediaStorage(tmp_path, max_audio_upload_mb=2, max_video_upload_mb=2)
    app.dependency_overrides[get_storage] = lambda: storage
    monkeypatch.setattr(
        meeting_routes,
        "get_settings",
        lambda: SimpleNamespace(upload_chunk_mb=1),
    )
    meeting_id = create_media_meeting(client)
    content = b"v" * (1024 * 1024) + b"tail"

    initialized = client.post(
        f"/api/v1/meetings/{meeting_id}/uploads",
        json={
            "filename": "../private-recording.mp4",
            "mime_type": "video/mp4",
            "size_bytes": len(content),
        },
    )
    assert initialized.status_code == 201
    upload = initialized.json()
    parsed_meeting_id = uuid.UUID(meeting_id)
    parsed_upload_id = uuid.UUID(upload["id"])
    assert upload["chunk_count"] == 2
    assert upload["received_chunks"] == []
    assert (
        client.get(f"/api/v1/meetings/{meeting_id}").json()["source_type"] == "media_upload"
    )

    first = client.put(
        f"/api/v1/meetings/{meeting_id}/uploads/{upload['id']}/chunks/0",
        files={"file": ("chunk-0.part", content[: 1024 * 1024])},
    )
    assert first.status_code == 200
    assert first.json()["received_chunks"] == 1

    resumed = client.get(
        f"/api/v1/meetings/{meeting_id}/uploads/{upload['id']}"
    )
    assert resumed.status_code == 200
    assert resumed.json()["received_chunks"] == [0]

    incomplete = client.post(
        f"/api/v1/meetings/{meeting_id}/uploads/{upload['id']}/complete"
    )
    assert incomplete.status_code == 409

    second = client.put(
        f"/api/v1/meetings/{meeting_id}/uploads/{upload['id']}/chunks/1",
        files={"file": ("chunk-1.part", content[1024 * 1024 :])},
    )
    assert second.status_code == 200

    completed = client.post(
        f"/api/v1/meetings/{meeting_id}/uploads/{upload['id']}/complete"
    )
    assert completed.status_code == 202
    body = completed.json()
    assert body["media"]["kind"] == "original_video"
    assert body["job"]["type"] == "preprocess_media"
    assert (
        client.get(f"/api/v1/meetings/{meeting_id}").json()["source_type"] == "video_upload"
    )

    with session_factory() as session:
        media = session.scalar(
            select(Media).where(Media.meeting_id == parsed_meeting_id)
        )
        job = session.scalar(select(Job).where(Job.meeting_id == parsed_meeting_id))
        upload_model = session.get(MediaUploadSession, parsed_upload_id)
        assert media is not None
        assert media.kind == MediaKind.ORIGINAL_VIDEO
        assert "private-recording" not in media.storage_path
        assert storage.absolute_path(media.storage_path).read_bytes() == content
        assert job is not None
        assert job.type == JobType.PREPROCESS_MEDIA
        assert job.status == JobStatus.QUEUED
        assert upload_model is not None
        assert upload_model.status == MediaUploadStatus.COMPLETED
    assert not (
        tmp_path / "meetings" / meeting_id / "uploads" / upload["id"]
    ).exists()


def test_chunked_media_upload_detects_audio_and_enqueues_transcription(
    client: TestClient,
    tmp_path: Path,
    monkeypatch,
) -> None:
    storage = MediaStorage(tmp_path, max_audio_upload_mb=2, max_video_upload_mb=2)
    app.dependency_overrides[get_storage] = lambda: storage
    monkeypatch.setattr(
        meeting_routes,
        "get_settings",
        lambda: SimpleNamespace(upload_chunk_mb=1),
    )
    meeting_id = create_media_meeting(client)
    content = b"audio-data"

    initialized = client.post(
        f"/api/v1/meetings/{meeting_id}/uploads",
        json={
            "filename": "interview.mp3",
            "mime_type": "audio/mpeg",
            "size_bytes": len(content),
        },
    )
    assert initialized.status_code == 201
    upload_id = initialized.json()["id"]
    assert (
        client.get(f"/api/v1/meetings/{meeting_id}").json()["source_type"] == "media_upload"
    )

    chunk = client.put(
        f"/api/v1/meetings/{meeting_id}/uploads/{upload_id}/chunks/0",
        files={"file": ("chunk-0.part", content)},
    )
    assert chunk.status_code == 200

    completed = client.post(
        f"/api/v1/meetings/{meeting_id}/uploads/{upload_id}/complete"
    )
    assert completed.status_code == 202
    assert completed.json()["media"]["kind"] == "original_audio"
    assert completed.json()["job"]["type"] == "transcribe"
    assert (
        client.get(f"/api/v1/meetings/{meeting_id}").json()["source_type"] == "audio_upload"
    )


def test_chunked_upload_rejects_wrong_chunk_size(
    client: TestClient,
    tmp_path: Path,
    monkeypatch,
) -> None:
    storage = MediaStorage(tmp_path, max_audio_upload_mb=2, max_video_upload_mb=2)
    app.dependency_overrides[get_storage] = lambda: storage
    monkeypatch.setattr(
        meeting_routes,
        "get_settings",
        lambda: SimpleNamespace(upload_chunk_mb=1),
    )
    meeting_id = create_media_meeting(client)
    initialized = client.post(
        f"/api/v1/meetings/{meeting_id}/uploads",
        json={
            "filename": "recording.mp4",
            "mime_type": "video/mp4",
            "size_bytes": 1024 * 1024 + 1,
        },
    )
    upload_id = initialized.json()["id"]

    response = client.put(
        f"/api/v1/meetings/{meeting_id}/uploads/{upload_id}/chunks/0",
        files={"file": ("chunk-0.part", b"too-short")},
    )

    assert response.status_code == 422
    assert list(tmp_path.rglob("*.part")) == []

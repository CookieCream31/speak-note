import uuid
from pathlib import Path

from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from app.api.dependencies import get_storage
from app.main import app
from app.models.job import Job, JobStatus, JobType
from app.models.media import Media, MediaKind
from app.services.media import MediaStorage


def create_audio_meeting(client: TestClient) -> str:
    response = client.post(
        "/api/v1/meetings",
        json={"title": "Phase 2 audio", "source_type": "audio_upload"},
    )
    assert response.status_code == 201
    return str(response.json()["id"])


def test_audio_upload_stores_generated_path_and_enqueues_job(
    client: TestClient,
    session_factory: sessionmaker[Session],
    tmp_path: Path,
) -> None:
    storage = MediaStorage(tmp_path, max_audio_upload_mb=1)
    app.dependency_overrides[get_storage] = lambda: storage
    meeting_id = create_audio_meeting(client)

    response = client.post(
        f"/api/v1/meetings/{meeting_id}/audio",
        files={"file": ("../private-name.mp3", b"ID3-safe-audio", "audio/mpeg")},
    )

    assert response.status_code == 202
    body = response.json()
    assert body["media"]["kind"] == "original_audio"
    assert body["media"]["size_bytes"] == len(b"ID3-safe-audio")
    assert body["job"]["type"] == "transcribe"
    assert body["job"]["status"] == "queued"

    parsed_meeting_id = uuid.UUID(body["media"]["meeting_id"])
    with session_factory() as session:
        media = session.scalar(select(Media).where(Media.meeting_id == parsed_meeting_id))
        job = session.scalar(select(Job).where(Job.meeting_id == parsed_meeting_id))
        assert media is not None
        assert media.kind == MediaKind.ORIGINAL_AUDIO
        assert "private-name" not in media.storage_path
        assert storage.absolute_path(media.storage_path).read_bytes() == b"ID3-safe-audio"
        assert job is not None
        assert job.type == JobType.TRANSCRIBE
        assert job.status == JobStatus.QUEUED

    duplicate = client.post(
        f"/api/v1/meetings/{meeting_id}/audio",
        files={"file": ("second.mp3", b"second", "audio/mpeg")},
    )
    assert duplicate.status_code == 409

    delete_response = client.delete(f"/api/v1/meetings/{meeting_id}")
    assert delete_response.status_code == 204
    assert not (tmp_path / "meetings" / meeting_id).exists()


def test_audio_upload_rejects_extension_mime_mismatch(
    client: TestClient,
    tmp_path: Path,
) -> None:
    app.dependency_overrides[get_storage] = lambda: MediaStorage(tmp_path, 1)
    meeting_id = create_audio_meeting(client)

    response = client.post(
        f"/api/v1/meetings/{meeting_id}/audio",
        files={"file": ("not-audio.mp3", b"content", "text/plain")},
    )

    assert response.status_code == 422
    assert list(tmp_path.rglob("*")) == []

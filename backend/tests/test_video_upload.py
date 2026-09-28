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


def create_video_meeting(client: TestClient) -> str:
    response = client.post(
        "/api/v1/meetings",
        json={"title": "Phase 3 video", "source_type": "video_upload"},
    )
    assert response.status_code == 201
    return str(response.json()["id"])


def test_video_upload_stores_generated_path_and_enqueues_preprocess_job(
    client: TestClient,
    session_factory: sessionmaker[Session],
    tmp_path: Path,
) -> None:
    storage = MediaStorage(tmp_path, max_audio_upload_mb=1, max_video_upload_mb=1)
    app.dependency_overrides[get_storage] = lambda: storage
    meeting_id = create_video_meeting(client)

    response = client.post(
        f"/api/v1/meetings/{meeting_id}/video",
        files={"file": ("../private-recording.mp4", b"safe-video", "video/mp4")},
    )

    assert response.status_code == 202
    body = response.json()
    assert body["media"]["kind"] == "original_video"
    assert body["job"]["type"] == "preprocess_media"
    assert body["job"]["status"] == "queued"

    parsed_meeting_id = uuid.UUID(meeting_id)
    with session_factory() as session:
        media = session.scalar(select(Media).where(Media.meeting_id == parsed_meeting_id))
        job = session.scalar(select(Job).where(Job.meeting_id == parsed_meeting_id))
        assert media is not None
        assert media.kind == MediaKind.ORIGINAL_VIDEO
        assert "private-recording" not in media.storage_path
        assert storage.absolute_path(media.storage_path).read_bytes() == b"safe-video"
        assert job is not None
        assert job.type == JobType.PREPROCESS_MEDIA
        assert job.status == JobStatus.QUEUED

    duplicate = client.post(
        f"/api/v1/meetings/{meeting_id}/video",
        files={"file": ("second.mp4", b"second", "video/mp4")},
    )
    assert duplicate.status_code == 409


def test_video_upload_rejects_extension_mime_mismatch(
    client: TestClient,
    tmp_path: Path,
) -> None:
    app.dependency_overrides[get_storage] = lambda: MediaStorage(tmp_path, 1, 1)
    meeting_id = create_video_meeting(client)

    response = client.post(
        f"/api/v1/meetings/{meeting_id}/video",
        files={"file": ("not-video.mp4", b"content", "text/plain")},
    )

    assert response.status_code == 422
    assert list(tmp_path.rglob("*")) == []

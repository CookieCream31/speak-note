from pathlib import Path

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session, sessionmaker

from app.api.dependencies import get_storage
from app.main import app
from app.models.media import Media, MediaKind
from app.models.meeting import Meeting, MeetingSourceType
from app.services.media import MediaStorage


def test_media_content_supports_http_range(
    client: TestClient,
    session_factory: sessionmaker[Session],
    tmp_path: Path,
) -> None:
    storage = MediaStorage(tmp_path, 1)
    app.dependency_overrides[get_storage] = lambda: storage
    content = b"0123456789"

    with session_factory() as session:
        meeting = Meeting(title="Playback", source_type=MeetingSourceType.AUDIO_UPLOAD)
        session.add(meeting)
        session.flush()
        media = Media(
            meeting_id=meeting.id,
            kind=MediaKind.ORIGINAL_AUDIO,
            storage_path=f"meetings/{meeting.id}/original/audio.mp3",
            mime_type="audio/mpeg",
            size_bytes=len(content),
        )
        session.add(media)
        session.commit()
        path = storage.absolute_path(media.storage_path)
        path.parent.mkdir(parents=True)
        path.write_bytes(content)
        meeting_id = meeting.id
        media_id = media.id

    response = client.get(
        f"/api/v1/meetings/{meeting_id}/media/{media_id}/content",
        headers={"Range": "bytes=2-5"},
    )

    assert response.status_code == 206
    assert response.content == b"2345"
    assert response.headers["accept-ranges"] == "bytes"
    assert response.headers["content-range"] == "bytes 2-5/10"
    assert response.headers["content-type"] == "audio/mpeg"
    assert response.headers["content-disposition"] == "inline"


def test_media_content_rejects_media_from_another_meeting(
    client: TestClient,
    session_factory: sessionmaker[Session],
    tmp_path: Path,
) -> None:
    app.dependency_overrides[get_storage] = lambda: MediaStorage(tmp_path, 1)
    with session_factory() as session:
        first = Meeting(title="First", source_type=MeetingSourceType.AUDIO_UPLOAD)
        second = Meeting(title="Second", source_type=MeetingSourceType.AUDIO_UPLOAD)
        session.add_all([first, second])
        session.flush()
        media = Media(
            meeting_id=first.id,
            kind=MediaKind.ORIGINAL_AUDIO,
            storage_path=f"meetings/{first.id}/original/audio.mp3",
            mime_type="audio/mpeg",
            size_bytes=1,
        )
        session.add(media)
        session.commit()
        second_id = second.id
        media_id = media.id

    response = client.get(f"/api/v1/meetings/{second_id}/media/{media_id}/content")
    assert response.status_code == 404


def test_media_download_returns_an_attachment(
    client: TestClient,
    session_factory: sessionmaker[Session],
    tmp_path: Path,
) -> None:
    storage = MediaStorage(tmp_path, 1)
    app.dependency_overrides[get_storage] = lambda: storage
    content = b"downloadable audio"

    with session_factory() as session:
        meeting = Meeting(
            title="Weekly-meeting",
            source_type=MeetingSourceType.AUDIO_UPLOAD,
        )
        session.add(meeting)
        session.flush()
        media = Media(
            meeting_id=meeting.id,
            kind=MediaKind.ORIGINAL_AUDIO,
            storage_path=f"meetings/{meeting.id}/original/audio.mp3",
            mime_type="audio/mpeg",
            size_bytes=len(content),
        )
        session.add(media)
        session.commit()
        path = storage.absolute_path(media.storage_path)
        path.parent.mkdir(parents=True)
        path.write_bytes(content)
        meeting_id = meeting.id
        media_id = media.id

    response = client.get(f"/api/v1/meetings/{meeting_id}/media/{media_id}/download")

    assert response.status_code == 200
    assert response.content == content
    assert response.headers["content-type"] == "audio/mpeg"
    assert response.headers["cache-control"] == "private, no-store"
    assert response.headers["content-disposition"] == (
        'attachment; filename="Weekly-meeting.mp3"'
    )

from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from app.api.dependencies import get_storage
from app.main import app
from app.models.job import Job, JobType
from app.models.media import Media, MediaKind
from app.models.meeting import Meeting, MeetingSourceType
from app.models.realtime import RealtimeVideoPart
from app.services.media import MediaStorage
from app.services.realtime.capture import (
    RealtimeCaptureError,
    append_realtime_chunk,
    start_realtime_session,
)


@pytest.mark.parametrize(
    ("mime_type", "has_system_audio", "split_capture"),
    [("video/webm", True, False), ("audio/webm", True, True), ("audio/webm", False, False)],
)
def test_shared_audio_rejects_video_or_missing_shared_sound_before_creating_media(
    session_factory: sessionmaker[Session],
    tmp_path: Path,
    mime_type: str,
    has_system_audio: bool,
    split_capture: bool,
) -> None:
    with session_factory() as db:
        meeting = Meeting(title="Shared sound", source_type=MeetingSourceType.SHARED_AUDIO)
        db.add(meeting)
        db.commit()
        with pytest.raises(RealtimeCaptureError):
            start_realtime_session(
                db,
                meeting,
                MediaStorage(tmp_path, max_audio_upload_mb=1, max_video_upload_mb=10),
                mime_type=mime_type,
                has_system_audio=has_system_audio,
                split_capture=split_capture,
                model="large-v3",
                language="ja",
            )
        assert list(db.scalars(select(Media))) == []
        assert list(tmp_path.rglob("*.webm")) == []


def test_shared_audio_api_saves_only_sound_and_allows_manual_final_after_stopping(
    client: TestClient,
    session_factory: sessionmaker[Session],
    tmp_path: Path,
) -> None:
    storage = MediaStorage(tmp_path, max_audio_upload_mb=1, max_video_upload_mb=10)
    app.dependency_overrides[get_storage] = lambda: storage
    try:
        created = client.post(
            "/api/v1/meetings",
            json={
                "title": "共有音声のみ",
                "source_type": "shared_audio",
            },
        )
        assert created.status_code == 201
        meeting_id = created.json()["id"]
        final_url = f"/api/v1/meetings/{meeting_id}/transcript"
        with client.websocket_connect(f"/api/v1/meetings/{meeting_id}/live/ws") as ws:
            ws.send_json(
                {
                    "type": "start",
                    "capture_mode": "audio",
                    "mime_type": "audio/webm",
                    "has_system_audio": True,
                }
            )
            assert ws.receive_json()["type"] == "started"
            assert client.post(final_url).status_code == 409
            ws.send_json({"type": "chunk", "sequence": 0, "start_ms": 0, "end_ms": 15000})
            ws.send_bytes(b"shared-and-microphone-audio")
            assert ws.receive_json()["type"] == "chunk_saved"
            ws.send_json({"type": "stop"})
            assert ws.receive_json()["job_id"] is None

        with session_factory() as db:
            media = list(db.scalars(select(Media)))
            assert len(media) == 1 and media[0].kind == MediaKind.ORIGINAL_AUDIO
            assert (
                storage.absolute_path(media[0].storage_path).read_bytes()
                == b"shared-and-microphone-audio"
            )
            assert list(db.scalars(select(RealtimeVideoPart))) == []
            assert list(db.scalars(select(Job).where(Job.type != JobType.TRANSCRIBE_LIVE))) == []
        assert client.get(f"/api/v1/meetings/{meeting_id}/transcript?kind=live").status_code == 200
        response = client.post(final_url)
        assert response.status_code == 202 and response.json()["type"] == "transcribe"
        assert client.post(final_url).status_code == 409
    finally:
        app.dependency_overrides.pop(get_storage, None)


def test_shared_audio_uses_audio_size_limit_without_losing_received_sound(
    session_factory: sessionmaker[Session],
    tmp_path: Path,
) -> None:
    storage = MediaStorage(tmp_path, max_audio_upload_mb=1, max_video_upload_mb=10)
    with session_factory() as db:
        meeting = Meeting(title="Audio size", source_type=MeetingSourceType.SHARED_AUDIO)
        db.add(meeting)
        db.commit()
        capture = start_realtime_session(
            db,
            meeting,
            storage,
            mime_type="audio/webm",
            has_system_audio=True,
            model="large-v3",
            language="ja",
        )
        append_realtime_chunk(
            db,
            capture,
            storage,
            sequence=0,
            start_ms=0,
            end_ms=15000,
            content=b"saved",
            window_ms=30000,
            step_ms=15000,
            max_chunk_bytes=2 * 1024 * 1024,
        )
        with pytest.raises(RealtimeCaptureError, match="録音は1MB以下"):
            append_realtime_chunk(
                db,
                capture,
                storage,
                sequence=1,
                start_ms=15000,
                end_ms=30000,
                content=b"a" * 1024 * 1024,
                window_ms=30000,
                step_ms=15000,
                max_chunk_bytes=2 * 1024 * 1024,
            )
        media = db.get(Media, capture.media_id)
        assert media is not None
        assert storage.absolute_path(media.storage_path).read_bytes() == b"saved"
        assert capture.chunk_count == 1 and media.size_bytes == 5

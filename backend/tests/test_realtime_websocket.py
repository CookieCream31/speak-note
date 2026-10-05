import asyncio
import uuid
from collections.abc import Generator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from app.api.dependencies import get_storage
from app.api.routes import realtime as realtime_routes
from app.main import app
from app.models.job import Job, JobType
from app.models.media import Media
from app.models.meeting import Meeting, MeetingSourceType, MeetingStatus
from app.services.media import MediaStorage


@pytest.fixture
def storage(tmp_path: Path) -> Generator[MediaStorage, None, None]:
    media_storage = MediaStorage(tmp_path, 10)
    app.dependency_overrides[get_storage] = lambda: media_storage
    yield media_storage
    app.dependency_overrides.pop(get_storage, None)


def _create_meeting(session_factory: sessionmaker[Session]) -> uuid.UUID:
    with session_factory() as session:
        meeting = Meeting(title="WebSocket", source_type=MeetingSourceType.AUDIO_RECORDING)
        session.add(meeting)
        session.commit()
        return meeting.id


def _start(websocket: Any) -> dict[str, Any]:
    websocket.send_json(
        {
            "type": "start",
            "capture_mode": "audio",
            "mime_type": "audio/webm;codecs=opus",
            "has_system_audio": False,
        }
    )
    return websocket.receive_json()


def test_websocket_records_chunks_and_finalizes(
    client: TestClient,
    session_factory: sessionmaker[Session],
    storage: MediaStorage,
) -> None:
    meeting_id = _create_meeting(session_factory)

    with client.websocket_connect(f"/api/v1/meetings/{meeting_id}/live/ws") as websocket:
        started = _start(websocket)
        assert started["type"] == "started"
        assert started["transcription_provider"] == "whisperx"
        assert started["transcription_language"] == "ja"
        for sequence, content in enumerate([b"first", b"second"]):
            websocket.send_json(
                {
                    "type": "chunk",
                    "sequence": sequence,
                    "start_ms": sequence * 15000,
                    "end_ms": (sequence + 1) * 15000,
                }
            )
            websocket.send_bytes(content)
            assert websocket.receive_json() == {
                "type": "chunk_saved",
                "sequence": sequence,
                "end_ms": (sequence + 1) * 15000,
            }
        websocket.send_json({"type": "stop"})
        finalized = websocket.receive_json()

    assert finalized["type"] == "finalized"
    assert finalized["duration_ms"] == 30000
    with session_factory() as session:
        meeting = session.get(Meeting, meeting_id)
        assert meeting is not None
        assert meeting.status == MeetingStatus.COMPLETED
        media = session.scalar(select(Media).where(Media.meeting_id == meeting.id))
        assert media is not None
        assert storage.absolute_path(media.storage_path).read_bytes() == b"firstsecond"
        live_jobs = session.scalars(select(Job).where(Job.type == JobType.TRANSCRIBE_LIVE))
        assert len(list(live_jobs)) == 2


def test_websocket_runs_blocking_storage_work_off_the_event_loop(
    client: TestClient,
    session_factory: sessionmaker[Session],
    storage: MediaStorage,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    meeting_id = _create_meeting(session_factory)
    called_on_event_loop: list[bool] = []
    original_append = realtime_routes.append_realtime_chunk

    def recording_append(*args: Any, **kwargs: Any) -> Any:
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            called_on_event_loop.append(False)
        else:
            called_on_event_loop.append(True)
        return original_append(*args, **kwargs)

    monkeypatch.setattr(realtime_routes, "append_realtime_chunk", recording_append)

    with client.websocket_connect(f"/api/v1/meetings/{meeting_id}/live/ws") as websocket:
        assert _start(websocket)["type"] == "started"
        websocket.send_json({"type": "chunk", "sequence": 0, "start_ms": 0, "end_ms": 15000})
        websocket.send_bytes(b"audio")
        assert websocket.receive_json()["type"] == "chunk_saved"
        websocket.send_json({"type": "stop"})
        assert websocket.receive_json()["type"] == "finalized"

    # File writes and DB commits must not block other requests on the event loop.
    assert called_on_event_loop == [False]


def test_websocket_disconnect_finalizes_received_audio(
    client: TestClient,
    session_factory: sessionmaker[Session],
    storage: MediaStorage,
) -> None:
    meeting_id = _create_meeting(session_factory)

    with client.websocket_connect(f"/api/v1/meetings/{meeting_id}/live/ws") as websocket:
        assert _start(websocket)["type"] == "started"
        websocket.send_json({"type": "chunk", "sequence": 0, "start_ms": 0, "end_ms": 15000})
        websocket.send_bytes(b"audio")
        assert websocket.receive_json()["type"] == "chunk_saved"

    with session_factory() as session:
        meeting = session.get(Meeting, meeting_id)
        assert meeting is not None
        assert meeting.status == MeetingStatus.COMPLETED
        assert meeting.duration_ms == 15000

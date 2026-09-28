import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session, sessionmaker

from app.models.media import Media, MediaKind
from app.models.meeting import Meeting, MeetingSourceType
from app.models.realtime import RealtimeSession, RealtimeSessionStatus
from app.models.transcript import (
    TranscriptKind,
    TranscriptSegment,
    TranscriptStatus,
    TranscriptVersion,
)


@pytest.mark.parametrize("source", [MeetingSourceType.LIVE, MeetingSourceType.AUDIO_RECORDING])
def test_stopped_live_transcript_remains_available_beside_final(
    client: TestClient,
    session_factory: sessionmaker[Session],
    source: MeetingSourceType,
) -> None:
    with session_factory() as db:
        meeting = Meeting(title="Archived", source_type=source)
        db.add(meeting)
        db.flush()
        media = Media(
            meeting_id=meeting.id,
            kind=MediaKind.ORIGINAL_AUDIO,
            storage_path="test.webm",
            mime_type="audio/webm",
            size_bytes=1,
        )
        live = TranscriptVersion(
            meeting_id=meeting.id,
            version=1,
            kind=TranscriptKind.LIVE,
            status=TranscriptStatus.COMPLETED,
            language="ja",
            model="azure",
            diarization_enabled=True,
        )
        live.segments.append(
            TranscriptSegment(
                start_ms=0,
                end_ms=1000,
                text="リアルタイム本文",
                sequence=0,
                provisional_speaker_label="SPEAKER_02",
            )
        )
        db.add_all([media, live])
        db.flush()
        capture = RealtimeSession(
            meeting_id=meeting.id,
            media_id=media.id,
            transcript_version_id=live.id,
            status=RealtimeSessionStatus.COMPLETED,
            mime_type="audio/webm",
        )
        db.add(capture)
        db.commit()
        meeting_id, live_id = meeting.id, live.id
    base = f"/api/v1/meetings/{meeting_id}/transcript"
    result = client.get(base)
    assert result.status_code == 200
    assert result.json()["id"] == str(live_id)
    assert result.json()["kind"] == "live"
    download = client.get(base + "/download?kind=live")
    assert download.status_code == 200
    assert "SPEAKER_02" in download.text
    assert "リアルタイム本文" in download.text
    assert client.get(base + "?kind=final").status_code == 404
    with session_factory() as db:
        meeting = db.get(Meeting, meeting_id)
        assert meeting is not None
        final = TranscriptVersion(
            meeting_id=meeting.id,
            version=2,
            kind=TranscriptKind.FINAL,
            status=TranscriptStatus.COMPLETED,
            language="ja",
            model="whisperx",
            diarization_enabled=True,
        )
        db.add(final)
        db.flush()
        meeting.active_transcript_version_id = final.id
        db.commit()
        final_id = final.id
    assert client.get(base).json()["id"] == str(final_id)
    assert client.get(base + "?kind=live").json()["id"] == str(live_id)
    assert client.get(base + "?kind=final").json()["id"] == str(final_id)
    with session_factory() as db:
        capture = db.get(RealtimeSession, capture.id)
        assert capture is not None
        capture.status = RealtimeSessionStatus.RECORDING
        db.commit()
    assert client.get(base + "?kind=live").status_code == 404
    assert client.post(base).status_code == 409

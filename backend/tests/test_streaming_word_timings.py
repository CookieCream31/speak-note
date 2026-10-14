import copy
import uuid

import pytest
from sqlalchemy import func, select
from test_soniox_transcription import soniox_settings  # noqa: F401

from app.api.dependencies import get_storage
from app.main import app
from app.models import Job, Meeting, MeetingSourceType, TranscriptSegment, TranscriptWord
from app.models.realtime import RealtimeSession
from app.services.media import MediaStorage
from app.services.realtime.capture import RealtimeCaptureError, append_streaming_transcript_segment

pytestmark = pytest.mark.usefixtures("soniox_settings")

WORDS = [
    {"text": "Hel", "start_ms": 100, "end_ms": 250, "confidence": 0.9},
    {"text": "lo", "start_ms": 300, "end_ms": 450, "confidence": 0.95},
    {"text": "  world.", "start_ms": 2000, "end_ms": 2200, "confidence": None},
    {"text": "はい", "start_ms": 2800, "end_ms": 3000, "confidence": 0.8},
]
PAYLOAD = {
    "type": "soniox_result",
    "result_id": "snx-timed:0",
    "text": "Hello  world.はい",
    "start_ms": 100,
    "end_ms": 3000,
    "speaker_label": "話者 1",
    "confidence": 0.9,
    "words": WORDS,
}


def start_capture(client, session_factory, tmp_path):
    app.dependency_overrides[get_storage] = lambda: MediaStorage(tmp_path, 1)
    with session_factory() as db:
        meeting = Meeting(
            title="Timed Soniox", source_type=MeetingSourceType.AUDIO_RECORDING, ai_disabled=True
        )
        db.add(meeting)
        db.commit()
        meeting_id = meeting.id
    return meeting_id, client.websocket_connect(f"/api/v1/meetings/{meeting_id}/live/ws")


def begin(ws):
    ws.send_json(
        {
            "type": "start",
            "capture_mode": "audio",
            "mime_type": "audio/webm",
            "has_system_audio": False,
        }
    )
    started = ws.receive_json()
    assert started["type"] == "started"
    assert started["transcription_provider"] == "soniox"
    return uuid.UUID(started["session_id"])


def test_live_word_timings_survive_duplicate_ack_stop_and_reload(client, session_factory, tmp_path):
    meeting_id, connection = start_capture(client, session_factory, tmp_path)
    with connection as ws:
        begin(ws)
        ws.send_json(PAYLOAD)
        first = ws.receive_json()
        ws.send_json(PAYLOAD)
        assert ws.receive_json() == first
        assert first["type"] == "soniox_result_saved"
        ws.send_json({"type": "chunk", "sequence": 0, "start_ms": 0, "end_ms": 4000})
        ws.send_bytes(b"saved audio")
        assert ws.receive_json()["type"] == "chunk_saved"
        ws.send_json({"type": "stop"})
        assert ws.receive_json()["type"] == "finalized"
    for suffix in ["/live", "/transcript?kind=live"]:
        response = client.get(f"/api/v1/meetings/{meeting_id}{suffix}")
        assert response.status_code == 200
        segment = response.json()["segments"][0]
        assert segment["text"] == PAYLOAD["text"]
        assert [{key: word[key] for key in WORDS[0]} for word in segment["words"]] == WORDS
        assert [word["sequence"] for word in segment["words"]] == list(range(4))
        assert all(word["speaker_id"] is None for word in segment["words"])
    with session_factory() as db:
        assert db.scalar(select(func.count()).select_from(TranscriptSegment)) == 1
        assert db.scalar(select(func.count()).select_from(TranscriptWord)) == 4
        assert db.scalar(select(func.count()).select_from(Job)) == 0


@pytest.mark.parametrize(
    "invalid",
    [
        "not a list",
        [{"text": "Hello", "start_ms": "100", "end_ms": 3000}],
        [{"text": "Hello", "start_ms": True, "end_ms": 3000}],
        [{"text": "Hello", "start_ms": -1, "end_ms": 3000}],
        [{"text": "Hello", "start_ms": 99, "end_ms": 3000}],
        [{"text": "Hello", "start_ms": 100, "end_ms": 3001}],
        [{"text": "Hello", "start_ms": 300, "end_ms": 100}],
        [{"text": "Hello", "start_ms": 100, "end_ms": 3000, "confidence": float("nan")}],
        [{"text": "Hello", "start_ms": 100, "end_ms": 3000, "confidence": 1.1}],
        [{"text": "Hello", "start_ms": 100, "end_ms": 3000, "is_final": False}],
        [{"text": "wrong body", "start_ms": 100, "end_ms": 3000}],
        [{"text": "Hello", "start_ms": 100}],
        [{"text": "", "start_ms": 100, "end_ms": 3000}],
        [WORDS[1], WORDS[0], *WORDS[2:]],
        [WORDS[0]] * 5001,
    ],
)
def test_invalid_word_timings_do_not_mutate_history(client, session_factory, tmp_path, invalid):
    _, connection = start_capture(client, session_factory, tmp_path)
    with connection as ws:
        session_id = begin(ws)
        ws.send_json(PAYLOAD)
        assert ws.receive_json()["type"] == "soniox_result_saved"
        with session_factory() as db:
            capture = db.get(RealtimeSession, session_id)
            old = db.scalar(select(TranscriptSegment))
            ids = [word.id for word in old.words]
            with pytest.raises(RealtimeCaptureError):
                append_streaming_transcript_segment(
                    db,
                    capture,
                    result_id="bad",
                    start_ms=100,
                    end_ms=3000,
                    text=PAYLOAD["text"],
                    words=invalid,
                )
            assert db.scalar(select(func.count()).select_from(TranscriptSegment)) == 1
            assert db.scalar(select(func.count()).select_from(TranscriptWord)) == 4
            assert [word.id for word in old.words] == ids
            assert [(word.text, word.start_ms) for word in old.words] == [
                (word["text"], word["start_ms"]) for word in WORDS
            ]


def test_conflicting_word_replay_is_rejected_without_overwriting_saved_timings(
    client, session_factory, tmp_path
):
    _, connection = start_capture(client, session_factory, tmp_path)
    with connection as ws:
        session_id = begin(ws)
        ws.send_json(PAYLOAD)
        assert ws.receive_json()["type"] == "soniox_result_saved"
        with session_factory() as db:
            capture = db.get(RealtimeSession, session_id)
            changed = copy.deepcopy(WORDS)
            changed[2]["start_ms"] = 1800
            with pytest.raises(RealtimeCaptureError, match="保存済み"):
                append_streaming_transcript_segment(
                    db,
                    capture,
                    result_id=PAYLOAD["result_id"],
                    start_ms=100,
                    end_ms=3000,
                    text=PAYLOAD["text"],
                    speaker_label="話者 1",
                    confidence=0.9,
                    words=changed,
                )
            assert db.scalar(select(func.count()).select_from(TranscriptWord)) == 4
            assert (
                db.scalar(select(TranscriptWord).where(TranscriptWord.sequence == 2)).start_ms
                == 2000
            )


def test_websocket_rejects_invalid_words_and_keeps_saved_audio_and_transcript(
    client, session_factory, tmp_path
):
    _, connection = start_capture(client, session_factory, tmp_path)
    with connection as ws:
        begin(ws)
        ws.send_json(PAYLOAD)
        assert ws.receive_json()["type"] == "soniox_result_saved"
        ws.send_json({"type": "chunk", "sequence": 0, "start_ms": 0, "end_ms": 4000})
        ws.send_bytes(b"saved audio")
        assert ws.receive_json()["type"] == "chunk_saved"
        ws.send_json(
            {
                **PAYLOAD,
                "result_id": "bad",
                "words": [{"text": "PRIVATE", "start_ms": -1, "end_ms": 5}],
            }
        )
        error = ws.receive_json()
        assert error["type"] == "error"
        assert "PRIVATE" not in str(error)
    with session_factory() as db:
        assert db.scalar(select(func.count()).select_from(TranscriptWord)) == 4
        assert db.scalar(select(func.count()).select_from(TranscriptSegment)) == 1
    assert any(path.read_bytes() == b"saved audio" for path in tmp_path.rglob("*.webm"))

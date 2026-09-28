from pathlib import Path

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from app.models.job import Job, JobType
from app.models.media import Media, MediaKind
from app.models.meeting import Meeting, MeetingSourceType, MeetingStatus
from app.models.speaker import Speaker
from app.models.transcript import TranscriptSegment, TranscriptVersion, TranscriptWord
from app.services.media import MediaStorage
from app.services.transcription.processor import process_transcription_job, seconds_to_ms
from app.services.transcription.schemas import WhisperXResult


class FakeWhisperXClient:
    model = "large-v3"
    language = "ja"

    def transcribe(
        self,
        _audio_path: Path,
        _mime_type: str,
        *,
        min_speakers: int | None = None,
        max_speakers: int | None = None,
    ) -> WhisperXResult:
        assert min_speakers == 2
        assert max_speakers == 4
        return WhisperXResult.model_validate(
            {
                "language": "ja",
                "segments": {
                    "segments": [
                        {
                            "start": 0.0005,
                            "end": 1.5,
                            "text": "こんにちははい",
                            "speaker": "SPEAKER_00",
                            "words": [
                                {
                                    "start": 0.0005,
                                    "end": 0.5,
                                    "word": "こんにちは",
                                    "speaker": "SPEAKER_00",
                                    "score": 0.9,
                                },
                                {
                                    "start": 1.0,
                                    "end": 1.5,
                                    "word": "はい",
                                    "speaker": "SPEAKER_01",
                                    "score": 0.8,
                                },
                            ],
                        },
                        {
                            "start": 1.5,
                            "end": 2.0,
                            "text": "次の発言",
                            "speaker": "SPEAKER_01",
                        },
                    ],
                    "word_segments": [],
                },
            }
        )


def test_transcription_processor_preserves_word_timestamps_and_speaker_changes(
    session_factory: sessionmaker[Session],
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    storage = MediaStorage(tmp_path, 1)
    analysis_meeting_ids: list[str] = []
    monkeypatch.setattr(
        "app.services.transcription.processor.create_analysis_job",
        lambda _session, meeting: analysis_meeting_ids.append(str(meeting.id)),
    )
    with session_factory() as session:
        meeting = Meeting(
            title="Processor",
            source_type=MeetingSourceType.AUDIO_UPLOAD,
            min_speakers=2,
            max_speakers=4,
        )
        session.add(meeting)
        session.flush()
        relative_path = f"meetings/{meeting.id}/original/audio.mp3"
        audio_path = storage.absolute_path(relative_path)
        audio_path.parent.mkdir(parents=True)
        audio_path.write_bytes(b"ID3")
        session.add(
            Media(
                meeting_id=meeting.id,
                kind=MediaKind.ORIGINAL_AUDIO,
                storage_path=relative_path,
                mime_type="audio/mpeg",
                size_bytes=3,
            )
        )
        job = Job(meeting_id=meeting.id, type=JobType.TRANSCRIBE)
        session.add(job)
        session.commit()

        process_transcription_job(
            session,
            job,
            FakeWhisperXClient(),  # type: ignore[arg-type]
            storage,
        )

        session.refresh(meeting)
        transcript = session.scalar(select(TranscriptVersion))
        segments = list(
            session.scalars(select(TranscriptSegment).order_by(TranscriptSegment.sequence))
        )
        words = list(session.scalars(select(TranscriptWord).order_by(TranscriptWord.start_ms)))
        speakers = list(session.scalars(select(Speaker).order_by(Speaker.internal_name)))

        assert meeting.status == MeetingStatus.COMPLETED
        assert meeting.duration_ms == 2000
        assert transcript is not None
        assert meeting.active_transcript_version_id == transcript.id
        assert transcript.raw_response is not None
        assert [segment.start_ms for segment in segments] == [1, 1000, 1500]
        assert [segment.end_ms for segment in segments] == [500, 1500, 2000]
        assert [segment.text for segment in segments] == ["こんにちは", "はい", "次の発言"]
        assert [segment.speaker.internal_name for segment in segments] == [
            "SPEAKER_00",
            "SPEAKER_01",
            "SPEAKER_01",
        ]
        assert [word.start_ms for word in words] == [1, 1000]
        assert [word.end_ms for word in words] == [500, 1500]
        assert [word.text for word in words] == ["こんにちは", "はい"]
        assert [word.confidence for word in words] == [0.9, 0.8]
        assert [word.speaker.internal_name for word in words] == ["SPEAKER_00", "SPEAKER_01"]
        assert [speaker.internal_name for speaker in speakers] == ["SPEAKER_00", "SPEAKER_01"]
        assert analysis_meeting_ids == [str(meeting.id)]


def test_seconds_to_ms_uses_half_up_rounding() -> None:
    assert seconds_to_ms(0.0005) == 1
    assert seconds_to_ms(1.2345) == 1235

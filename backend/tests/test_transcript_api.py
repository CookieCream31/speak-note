from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.orm import Session, sessionmaker

from app.models.job import Job, JobStatus, JobType
from app.models.media import Media, MediaKind
from app.models.meeting import Meeting, MeetingSourceType, MeetingStatus
from app.models.speaker import Speaker
from app.models.transcript import (
    TranscriptKind,
    TranscriptSegment,
    TranscriptStatus,
    TranscriptVersion,
    TranscriptWord,
)


def test_transcript_text_and_speaker_name_can_be_edited(
    client: TestClient,
    session_factory: sessionmaker[Session],
) -> None:
    with session_factory() as session:
        meeting = Meeting(title="Editable", source_type=MeetingSourceType.AUDIO_UPLOAD)
        session.add(meeting)
        session.flush()
        speaker = Speaker(meeting_id=meeting.id, internal_name="SPEAKER_00")
        transcript = TranscriptVersion(
            meeting_id=meeting.id,
            version=1,
            kind=TranscriptKind.FINAL,
            status=TranscriptStatus.COMPLETED,
            language="ja",
            model="large-v3",
            diarization_enabled=True,
        )
        segment = TranscriptSegment(
            start_ms=100, end_ms=900, text="original", sequence=0, speaker=speaker
        )
        segment.words.append(
            TranscriptWord(
                start_ms=100,
                end_ms=900,
                text="original",
                confidence=0.9,
                sequence=0,
                speaker=speaker,
            )
        )
        transcript.segments.append(segment)
        session.add_all([speaker, transcript])
        session.flush()
        meeting.active_transcript_version_id = transcript.id
        session.commit()
        meeting_id = meeting.id
        speaker_id = speaker.id
        segment_id = segment.id

    speaker_response = client.patch(
        f"/api/v1/meetings/{meeting_id}/speakers/{speaker_id}",
        json={"display_name": "田中"},
    )
    assert speaker_response.status_code == 200
    assert speaker_response.json()["display_name"] == "田中"

    segment_response = client.patch(
        f"/api/v1/meetings/{meeting_id}/transcript/segments/{segment_id}",
        json={"text": "修正した発言"},
    )
    assert segment_response.status_code == 200
    assert segment_response.json()["text"] == "修正した発言"
    assert segment_response.json()["words"] == []

    transcript_response = client.get(f"/api/v1/meetings/{meeting_id}/transcript")
    assert transcript_response.status_code == 200
    assert transcript_response.json()["segments"][0]["speaker"]["display_name"] == "田中"
    assert transcript_response.json()["segments"][0]["text"] == "修正した発言"
    assert transcript_response.json()["segments"][0]["words"] == []

    download_response = client.get(f"/api/v1/meetings/{meeting_id}/transcript/download")
    assert download_response.status_code == 200
    assert download_response.headers["content-type"].startswith("text/plain")
    assert "attachment;" in download_response.headers["content-disposition"]
    assert "Editable-transcript.txt" in download_response.headers["content-disposition"]
    assert download_response.text == "Editable\n\n[00:00:00] 田中\n修正した発言\n"

    with session_factory() as session:
        assert session.scalar(select(func.count()).select_from(TranscriptWord)) == 0


def test_live_final_transcription_is_started_manually(
    client: TestClient,
    session_factory: sessionmaker[Session],
) -> None:
    with session_factory() as session:
        meeting = Meeting(
            title="Manual final",
            source_type=MeetingSourceType.LIVE,
            status=MeetingStatus.COMPLETED,
        )
        session.add(meeting)
        session.flush()
        session.add(
            Media(
                meeting_id=meeting.id,
                kind=MediaKind.TRANSCRIPTION_AUDIO,
                storage_path=f"meetings/{meeting.id}/derived/transcription.wav",
                mime_type="audio/wav",
                size_bytes=1024,
            )
        )
        session.commit()
        meeting_id = meeting.id

    response = client.post(f"/api/v1/meetings/{meeting_id}/transcript")

    assert response.status_code == 202
    assert response.json()["type"] == JobType.TRANSCRIBE
    assert response.json()["status"] == JobStatus.QUEUED
    with session_factory() as session:
        meeting = session.get(Meeting, meeting_id)
        jobs = list(session.scalars(select(Job).where(Job.meeting_id == meeting_id)))
        assert meeting is not None
        assert meeting.status == MeetingStatus.QUEUED
        assert len(jobs) == 1
        assert jobs[0].type == JobType.TRANSCRIBE


def test_live_final_transcription_requires_completed_video_conversion(
    client: TestClient,
    session_factory: sessionmaker[Session],
) -> None:
    with session_factory() as session:
        meeting = Meeting(title="Not converted", source_type=MeetingSourceType.LIVE)
        session.add(meeting)
        session.commit()
        meeting_id = meeting.id

    response = client.post(f"/api/v1/meetings/{meeting_id}/transcript")

    assert response.status_code == 409
    assert response.json()["detail"] == "動画変換が完了してから確定版を開始してください"


def test_transcript_can_be_rebuilt_from_raw_word_speakers(
    client: TestClient,
    session_factory: sessionmaker[Session],
) -> None:
    raw_response = {
        "language": "ja",
        "segments": {
            "segments": [
                {
                    "start": 0.0,
                    "end": 1.2,
                    "text": "質問回答",
                    "speaker": "SPEAKER_00",
                    "words": [
                        {
                            "start": 0.0,
                            "end": 0.6,
                            "word": "質問",
                            "speaker": "SPEAKER_00",
                        },
                        {
                            "start": 0.7,
                            "end": 1.2,
                            "word": "回答",
                            "speaker": "SPEAKER_01",
                        },
                    ],
                }
            ],
            "word_segments": [],
        },
    }
    with session_factory() as session:
        meeting = Meeting(title="Rebuild", source_type=MeetingSourceType.AUDIO_UPLOAD)
        session.add(meeting)
        session.flush()
        speaker = Speaker(
            meeting_id=meeting.id,
            internal_name="SPEAKER_00",
            display_name="面接官",
        )
        transcript = TranscriptVersion(
            meeting_id=meeting.id,
            version=1,
            kind=TranscriptKind.FINAL,
            status=TranscriptStatus.COMPLETED,
            language="ja",
            model="large-v3",
            diarization_enabled=True,
            raw_response=raw_response,
        )
        transcript.segments.append(
            TranscriptSegment(
                start_ms=0,
                end_ms=1200,
                text="質問回答",
                sequence=0,
                speaker=speaker,
            )
        )
        session.add_all([speaker, transcript])
        session.flush()
        meeting.active_transcript_version_id = transcript.id
        session.commit()
        meeting_id = meeting.id

    response = client.post(f"/api/v1/meetings/{meeting_id}/transcript/rebuild-speaker-turns")

    assert response.status_code == 200
    body = response.json()
    assert body["version"] == 2
    assert [segment["text"] for segment in body["segments"]] == ["質問", "回答"]
    assert [segment["speaker"]["internal_name"] for segment in body["segments"]] == [
        "SPEAKER_00",
        "SPEAKER_01",
    ]
    assert body["segments"][0]["speaker"]["display_name"] == "面接官"
    assert [segment["words"][0]["text"] for segment in body["segments"]] == ["質問", "回答"]
    assert [segment["words"][0]["start_ms"] for segment in body["segments"]] == [0, 700]

    with session_factory() as session:
        meeting = session.scalar(select(Meeting).where(Meeting.id == meeting_id))
        versions = list(
            session.scalars(select(TranscriptVersion).order_by(TranscriptVersion.version))
        )
        assert meeting is not None
        assert meeting.active_transcript_version_id == versions[1].id
        assert [version.version for version in versions] == [1, 2]

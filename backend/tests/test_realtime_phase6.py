import subprocess
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, select
from sqlalchemy.orm import Session, sessionmaker

from app.models.job import Job, JobStatus, JobType
from app.models.media import Media, MediaKind
from app.models.meeting import Meeting, MeetingSourceType, MeetingStatus
from app.models.realtime import RealtimeSessionStatus, RealtimeVideoPart
from app.models.transcript import TranscriptKind, TranscriptSegment, TranscriptVersion
from app.services.media import MediaStorage
from app.services.media.realtime import RealtimeWindowMediaService
from app.services.realtime import (
    append_realtime_chunk,
    append_realtime_video_chunk,
    append_streaming_transcript_segment,
    finalize_realtime_session,
    finish_realtime_video_part,
    process_live_transcription_job,
    start_realtime_session,
    start_realtime_video_part,
)
from app.services.realtime.processor import build_realtime_transcription_windows
from app.services.transcription.client import WhisperXEmptyAudioError
from app.services.transcription.schemas import WhisperXResult


class FakeRealtimeMediaService:
    def extract_audio_window(
        self,
        _source_path: Path,
        output_path: Path,
        *,
        start_ms: int,
        end_ms: int,
    ) -> None:
        assert start_ms == 15000
        assert end_ms == 45000
        output_path.write_bytes(b"RIFF-fake")


class FakeWhisperXClient:
    model = "large-v3"
    language = "ja"

    def transcribe(
        self,
        audio_path: Path,
        mime_type: str,
        *,
        min_speakers: int | None = None,
        max_speakers: int | None = None,
    ) -> WhisperXResult:
        assert audio_path.read_bytes() == b"RIFF-fake"
        assert mime_type == "audio/wav"
        assert min_speakers == 2
        assert max_speakers == 4
        return WhisperXResult.model_validate(
            {
                "segments": [
                    {
                        "start": 1.0,
                        "end": 2.0,
                        "text": "ライブ発言",
                        "speaker": "SPEAKER_00",
                        "words": [
                            {
                                "start": 1.0,
                                "end": 2.0,
                                "word": "ライブ発言",
                                "speaker": "SPEAKER_00",
                                "score": 0.9,
                            }
                        ],
                    }
                ]
            }
        )


class RecordingRealtimeMediaService:
    def __init__(self) -> None:
        self.windows: list[tuple[int, int]] = []

    def extract_audio_window(
        self,
        _source_path: Path,
        output_path: Path,
        *,
        start_ms: int,
        end_ms: int,
    ) -> None:
        self.windows.append((start_ms, end_ms))
        output_path.write_bytes(b"RIFF-fake")


class EmptyWhisperXClient:
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
        return WhisperXResult.model_validate({"segments": []})


class EmptyAudioErrorWhisperXClient:
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
        raise WhisperXEmptyAudioError("WhisperXがHTTP 422を返しました: Decoded audio is empty")


class MidWindowWhisperXClient:
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
                "segments": [
                    {
                        "start": 16.0,
                        "end": 17.0,
                        "text": "時間窓の発言",
                        "speaker": "SPEAKER_00",
                    }
                ]
            }
        )


def _create_live_session(
    db: Session,
    storage: MediaStorage,
    transcription_provider: str = "whisperx",
):
    meeting = Meeting(
        title="Live",
        source_type=MeetingSourceType.LIVE,
        min_speakers=2,
        max_speakers=4,
    )
    db.add(meeting)
    db.commit()
    realtime_session = start_realtime_session(
        db,
        meeting,
        storage,
        mime_type="video/webm;codecs=vp8,opus",
        transcription_provider=transcription_provider,
        transcription_region="japaneast" if transcription_provider == "azure_speech" else None,
        has_system_audio=True,
        model="large-v3",
        language="ja",
    )
    return meeting, realtime_session


def test_realtime_capture_saves_chunks_and_queues_final_processing(
    session_factory: sessionmaker[Session],
    tmp_path: Path,
) -> None:
    storage = MediaStorage(tmp_path, 10, 10)
    with session_factory() as db:
        meeting, realtime_session = _create_live_session(db, storage)
        chunk = append_realtime_chunk(
            db,
            realtime_session,
            storage,
            sequence=0,
            start_ms=0,
            end_ms=15000,
            content=b"webm-chunk",
            window_ms=30000,
            step_ms=15000,
            max_chunk_bytes=1024,
        )
        assert chunk.window_start_ms == 0
        assert realtime_session.received_bytes == len(b"webm-chunk")
        assert meeting.status == MeetingStatus.RECORDING
        live_job = db.scalar(select(Job).where(Job.type == JobType.TRANSCRIBE_LIVE))
        assert live_job is not None
        assert live_job.realtime_chunk_id == chunk.id
        assert live_job.realtime_window_start_ms == 0
        assert live_job.realtime_window_end_ms == 15000
        assert live_job.realtime_commit_start_ms == 0

        final_job = finalize_realtime_session(db, realtime_session)
        assert final_job.type == JobType.PREPROCESS_MEDIA
        assert realtime_session.status == RealtimeSessionStatus.COMPLETED
        assert meeting.status == MeetingStatus.QUEUED
        transcript = db.get(TranscriptVersion, realtime_session.transcript_version_id)
        assert transcript is not None
        assert transcript.kind == TranscriptKind.LIVE
        assert meeting.active_transcript_version_id is None


def test_azure_streaming_results_are_saved_without_chunk_transcription_jobs(
    session_factory: sessionmaker[Session],
    tmp_path: Path,
) -> None:
    storage = MediaStorage(tmp_path, 10, 10)
    with session_factory() as db:
        _meeting, realtime_session = _create_live_session(
            db,
            storage,
            transcription_provider="azure_speech",
        )
        append_realtime_chunk(
            db,
            realtime_session,
            storage,
            sequence=0,
            start_ms=0,
            end_ms=15000,
            content=b"webm-chunk",
            window_ms=30000,
            step_ms=15000,
            max_chunk_bytes=1024,
        )
        assert db.scalar(select(Job).where(Job.type == JobType.TRANSCRIBE_LIVE)) is None

        first = append_streaming_transcript_segment(
            db,
            realtime_session,
            result_id="azure-result-1",
            start_ms=1200,
            end_ms=3400,
            text="  発話ごとに   保存します。 ",
            speaker_label="SPEAKER_00",
            confidence=0.91,
        )
        duplicate = append_streaming_transcript_segment(
            db,
            realtime_session,
            result_id="azure-result-1",
            start_ms=1200,
            end_ms=3400,
            text="発話ごとに保存します。",
            speaker_label="SPEAKER_00",
            confidence=0.91,
        )
        second = append_streaming_transcript_segment(
            db,
            realtime_session,
            result_id="azure-result-2",
            start_ms=4000,
            end_ms=5100,
            text="次の発話です。",
            speaker_label="SPEAKER_01",
        )

        segments = list(db.scalars(select(TranscriptSegment).order_by(TranscriptSegment.sequence)))
        assert duplicate.id == first.id
        assert [segment.sequence for segment in segments] == [0, 1]
        assert [segment.text for segment in segments] == [
            "発話ごとに 保存します。",
            "次の発話です。",
        ]
        assert first.provisional_speaker_label == "SPEAKER_00"
        assert second.provisional_speaker_label == "SPEAKER_01"
        transcript = db.get(TranscriptVersion, realtime_session.transcript_version_id)
        assert transcript is not None
        assert transcript.diarization_enabled is True
        assert first.confidence == 0.91
        assert second.start_ms == 4000


@pytest.mark.parametrize(
    "source", [MeetingSourceType.AUDIO_RECORDING, MeetingSourceType.SHARED_AUDIO]
)
def test_audio_recording_saves_audio_without_automatic_final_transcription(
    session_factory: sessionmaker[Session],
    tmp_path: Path,
    source: MeetingSourceType,
) -> None:
    storage = MediaStorage(tmp_path, 10, 10)
    with session_factory() as db:
        meeting = Meeting(
            title="Microphone recording",
            source_type=source,
        )
        db.add(meeting)
        db.commit()
        realtime_session = start_realtime_session(
            db,
            meeting,
            storage,
            mime_type="audio/webm;codecs=opus",
            has_system_audio=source == MeetingSourceType.SHARED_AUDIO,
            model="large-v3",
            language="ja",
        )

        append_realtime_chunk(
            db,
            realtime_session,
            storage,
            sequence=0,
            start_ms=0,
            end_ms=15_000,
            content=b"microphone-audio",
            window_ms=30_000,
            step_ms=15_000,
            max_chunk_bytes=1024,
        )
        final_job = finalize_realtime_session(db, realtime_session)
        original = db.get(Media, realtime_session.media_id)

        assert original is not None
        assert original.kind == MediaKind.ORIGINAL_AUDIO
        assert original.mime_type == "audio/webm"
        assert original.size_bytes == len(b"microphone-audio")
        assert storage.absolute_path(original.storage_path).read_bytes() == b"microphone-audio"
        assert realtime_session.status == RealtimeSessionStatus.COMPLETED
        assert final_job is None
        assert meeting.status == MeetingStatus.COMPLETED
        assert list(db.scalars(select(RealtimeVideoPart))) == []
        assert list(db.scalars(select(Media).where(Media.kind == MediaKind.ORIGINAL_VIDEO))) == []
        assert list(db.scalars(select(Job).where(Job.type == JobType.PREPROCESS_MEDIA))) == []
        assert (
            db.scalar(
                select(Job.id).where(Job.meeting_id == meeting.id, Job.type == JobType.TRANSCRIBE)
            )
            is None
        )
        assert finalize_realtime_session(db, realtime_session) is None


def test_split_realtime_capture_stores_continuous_audio_and_video_parts(
    session_factory: sessionmaker[Session],
    tmp_path: Path,
) -> None:
    storage = MediaStorage(tmp_path, 10, 10)
    with session_factory() as db:
        meeting = Meeting(title="Split live", source_type=MeetingSourceType.LIVE)
        db.add(meeting)
        db.commit()
        realtime_session = start_realtime_session(
            db,
            meeting,
            storage,
            mime_type="video/webm;codecs=vp8",
            audio_mime_type="audio/webm;codecs=opus",
            has_system_audio=True,
            model="large-v3",
            language="ja",
            split_capture=True,
        )

        append_realtime_chunk(
            db,
            realtime_session,
            storage,
            sequence=0,
            start_ms=0,
            end_ms=30_000,
            content=b"continuous-audio",
            window_ms=30_000,
            step_ms=15_000,
            max_chunk_bytes=1024,
        )
        first_part = start_realtime_video_part(
            db,
            realtime_session,
            storage,
            sequence=0,
            start_ms=0,
            mime_type="video/webm;codecs=vp8",
        )
        append_realtime_video_chunk(
            db,
            realtime_session,
            first_part,
            storage,
            sequence=0,
            content=b"first-video",
            max_chunk_bytes=1024,
        )
        finish_realtime_video_part(
            db,
            realtime_session,
            first_part,
            end_ms=10_000,
        )
        second_part = start_realtime_video_part(
            db,
            realtime_session,
            storage,
            sequence=1,
            start_ms=15_000,
            mime_type="video/webm;codecs=vp8",
        )
        append_realtime_video_chunk(
            db,
            realtime_session,
            second_part,
            storage,
            sequence=0,
            content=b"second-video",
            max_chunk_bytes=1024,
        )
        finish_realtime_video_part(
            db,
            realtime_session,
            second_part,
            end_ms=30_000,
        )

        final_job = finalize_realtime_session(db, realtime_session)
        original = db.get(Media, realtime_session.media_id)
        parts = list(
            db.scalars(
                select(RealtimeVideoPart)
                .where(RealtimeVideoPart.session_id == realtime_session.id)
                .order_by(RealtimeVideoPart.sequence)
            )
        )

        assert final_job.type == JobType.PREPROCESS_MEDIA
        assert realtime_session.audio_chunk_count == 1
        assert realtime_session.video_part_count == 2
        assert realtime_session.duration_ms == 30_000
        assert realtime_session.audio_storage_path is not None
        assert (
            storage.absolute_path(realtime_session.audio_storage_path).read_bytes()
            == b"continuous-audio"
        )
        assert [(part.start_ms, part.end_ms) for part in parts] == [
            (0, 10_000),
            (15_000, 30_000),
        ]
        assert [storage.absolute_path(part.storage_path).read_bytes() for part in parts] == [
            b"first-video",
            b"second-video",
        ]
        assert original is not None
        assert original.size_bytes == 0
        assert storage.absolute_path(original.storage_path).read_bytes() == b""


def test_live_transcription_uses_global_window_timestamps(
    session_factory: sessionmaker[Session],
    tmp_path: Path,
) -> None:
    storage = MediaStorage(tmp_path, 10, 10)
    with session_factory() as db:
        _meeting, realtime_session = _create_live_session(db, storage)
        append_realtime_chunk(
            db,
            realtime_session,
            storage,
            sequence=0,
            start_ms=15000,
            end_ms=45000,
            content=b"webm-chunk",
            window_ms=30000,
            step_ms=15000,
            max_chunk_bytes=1024,
        )
        job = db.scalar(select(Job).where(Job.type == JobType.TRANSCRIBE_LIVE))
        assert job is not None
        process_live_transcription_job(
            db,
            job,
            FakeWhisperXClient(),  # type: ignore[arg-type]
            storage,
            FakeRealtimeMediaService(),  # type: ignore[arg-type]
        )

        segment = db.scalar(select(TranscriptSegment))
        assert segment is not None
        assert segment.start_ms == 16000
        assert segment.end_ms == 17000
        assert segment.provisional_speaker_label == "SPEAKER_00"
        assert segment.words[0].start_ms == 16000


def test_finished_live_session_does_not_schedule_another_realtime_analysis(
    session_factory: sessionmaker[Session],
    tmp_path: Path,
    monkeypatch,
) -> None:
    scheduled_sessions: list[object] = []
    monkeypatch.setattr(
        "app.services.realtime.processor.schedule_realtime_analysis",
        lambda _db, realtime_session: scheduled_sessions.append(realtime_session),
    )
    storage = MediaStorage(tmp_path, 10, 10)
    with session_factory() as db:
        _meeting, realtime_session = _create_live_session(db, storage)
        append_realtime_chunk(
            db,
            realtime_session,
            storage,
            sequence=0,
            start_ms=15000,
            end_ms=45000,
            content=b"webm-chunk",
            window_ms=30000,
            step_ms=15000,
            max_chunk_bytes=1024,
        )
        job = db.scalar(select(Job).where(Job.type == JobType.TRANSCRIBE_LIVE))
        assert job is not None
        finalize_realtime_session(db, realtime_session)

        process_live_transcription_job(
            db,
            job,
            FakeWhisperXClient(),  # type: ignore[arg-type]
            storage,
            FakeRealtimeMediaService(),  # type: ignore[arg-type]
        )

        assert scheduled_sessions == []


def test_delayed_chunk_keeps_its_complete_new_range(
    session_factory: sessionmaker[Session],
    tmp_path: Path,
) -> None:
    storage = MediaStorage(tmp_path, 10, 10)
    with session_factory() as db:
        _meeting, realtime_session = _create_live_session(db, storage)
        chunk = append_realtime_chunk(
            db,
            realtime_session,
            storage,
            sequence=0,
            start_ms=15000,
            end_ms=90000,
            content=b"delayed-webm-chunk",
            window_ms=30000,
            step_ms=15000,
            max_chunk_bytes=1024,
        )

        assert chunk.window_start_ms == 15000
        windows = build_realtime_transcription_windows(
            chunk,
            window_ms=30000,
            step_ms=15000,
        )
        assert [window.commit_start_ms for window in windows] == [
            15000,
            45000,
            60000,
            75000,
        ]
        assert windows[0].start_ms == 15000
        assert windows[-1].end_ms == 90000
        assert all(window.end_ms - window.start_ms <= 30000 for window in windows)

        jobs = list(
            db.scalars(
                select(Job)
                .where(Job.type == JobType.TRANSCRIBE_LIVE)
                .order_by(Job.realtime_commit_start_ms)
            )
        )
        assert [job.realtime_commit_start_ms for job in jobs] == [
            15000,
            45000,
            60000,
            75000,
        ]

        chunk.window_start_ms = 60000
        legacy_windows = build_realtime_transcription_windows(
            chunk,
            window_ms=30000,
            step_ms=15000,
        )
        assert legacy_windows[0].start_ms == 15000
        assert legacy_windows[-1].end_ms == 90000


def test_empty_audio_http_error_completes_as_a_silent_window(
    session_factory: sessionmaker[Session],
    tmp_path: Path,
) -> None:
    storage = MediaStorage(tmp_path, 10, 10)
    with session_factory() as db:
        _meeting, realtime_session = _create_live_session(db, storage)
        append_realtime_chunk(
            db,
            realtime_session,
            storage,
            sequence=0,
            start_ms=15000,
            end_ms=45000,
            content=b"webm-chunk",
            window_ms=30000,
            step_ms=15000,
            max_chunk_bytes=1024,
        )
        job = db.scalar(select(Job).where(Job.type == JobType.TRANSCRIBE_LIVE))
        assert job is not None

        process_live_transcription_job(
            db,
            job,
            EmptyAudioErrorWhisperXClient(),  # type: ignore[arg-type]
            storage,
            RecordingRealtimeMediaService(),  # type: ignore[arg-type]
        )

        db.refresh(job)
        transcript = db.get(TranscriptVersion, realtime_session.transcript_version_id)
        assert transcript is not None
        assert db.scalar(select(TranscriptSegment)) is None
        assert job.progress == 95
        assert transcript.raw_response is not None
        assert transcript.raw_response["whisperx"]["status"] == "no_audio"


def test_silent_delayed_chunk_completes_without_erasing_transcript(
    session_factory: sessionmaker[Session],
    tmp_path: Path,
) -> None:
    storage = MediaStorage(tmp_path, 10, 10)
    media_service = RecordingRealtimeMediaService()
    with session_factory() as db:
        _meeting, realtime_session = _create_live_session(db, storage)
        transcript = db.get(TranscriptVersion, realtime_session.transcript_version_id)
        assert transcript is not None
        db.add(
            TranscriptSegment(
                transcript_version_id=transcript.id,
                start_ms=1000,
                end_ms=2000,
                provisional_speaker_label="SPEAKER_00",
                text="既存の発言",
                sequence=0,
            )
        )
        db.commit()
        append_realtime_chunk(
            db,
            realtime_session,
            storage,
            sequence=0,
            start_ms=15000,
            end_ms=90000,
            content=b"delayed-webm-chunk",
            window_ms=30000,
            step_ms=15000,
            max_chunk_bytes=1024,
        )
        jobs = list(
            db.scalars(
                select(Job)
                .where(Job.type == JobType.TRANSCRIBE_LIVE)
                .order_by(Job.realtime_commit_start_ms)
            )
        )
        assert len(jobs) == 4
        for job in jobs:
            process_live_transcription_job(
                db,
                job,
                EmptyWhisperXClient(),  # type: ignore[arg-type]
                storage,
                media_service,  # type: ignore[arg-type]
                window_ms=30000,
                step_ms=15000,
            )

        assert media_service.windows == [
            (15000, 45000),
            (30000, 60000),
            (45000, 75000),
            (60000, 90000),
        ]
        segments = db.scalars(select(TranscriptSegment).order_by(TranscriptSegment.sequence)).all()
        assert [segment.text for segment in segments] == ["既存の発言"]


def test_retrying_an_earlier_window_preserves_later_window_segments(
    session_factory: sessionmaker[Session],
    tmp_path: Path,
) -> None:
    storage = MediaStorage(tmp_path, 10, 10)
    media_service = RecordingRealtimeMediaService()
    with session_factory() as db:
        _meeting, realtime_session = _create_live_session(db, storage)
        append_realtime_chunk(
            db,
            realtime_session,
            storage,
            sequence=0,
            start_ms=15000,
            end_ms=90000,
            content=b"delayed-webm-chunk",
            window_ms=30000,
            step_ms=15000,
            max_chunk_bytes=1024,
        )
        jobs = list(
            db.scalars(
                select(Job)
                .where(Job.type == JobType.TRANSCRIBE_LIVE)
                .order_by(Job.realtime_commit_start_ms)
            )
        )
        assert len(jobs) == 4

        # A later independent window can complete even while an earlier one is
        # awaiting retry. Retrying the earlier range must not erase it.
        for job in (jobs[1], jobs[0]):
            process_live_transcription_job(
                db,
                job,
                MidWindowWhisperXClient(),  # type: ignore[arg-type]
                storage,
                media_service,  # type: ignore[arg-type]
            )

        segments = list(db.scalars(select(TranscriptSegment).order_by(TranscriptSegment.sequence)))
        assert [segment.start_ms for segment in segments] == [31000, 46000]
        assert [segment.sequence for segment in segments] == [0, 1]


def test_retrying_a_legacy_delayed_job_expands_it_into_independent_windows(
    client: TestClient,
    session_factory: sessionmaker[Session],
    tmp_path: Path,
) -> None:
    storage = MediaStorage(tmp_path, 10, 10)
    with session_factory() as db:
        meeting, realtime_session = _create_live_session(db, storage)
        chunk = append_realtime_chunk(
            db,
            realtime_session,
            storage,
            sequence=0,
            start_ms=15000,
            end_ms=90000,
            content=b"delayed-webm-chunk",
            window_ms=30000,
            step_ms=15000,
            max_chunk_bytes=1024,
        )
        db.execute(delete(Job).where(Job.realtime_chunk_id == chunk.id))
        legacy_job = Job(
            meeting_id=meeting.id,
            realtime_chunk_id=chunk.id,
            type=JobType.TRANSCRIBE_LIVE,
            status=JobStatus.FAILED,
            error_message="WhisperXがHTTP 422を返しました",
        )
        db.add(legacy_job)
        db.commit()
        legacy_job_id = legacy_job.id

    response = client.post(f"/api/v1/jobs/{legacy_job_id}/retry")

    assert response.status_code == 200
    assert response.json()["id"] == str(legacy_job_id)
    with session_factory() as db:
        jobs = list(
            db.scalars(
                select(Job)
                .where(Job.realtime_chunk_id == chunk.id)
                .order_by(Job.realtime_commit_start_ms)
            )
        )
        assert [job.realtime_commit_start_ms for job in jobs] == [
            15000,
            45000,
            60000,
            75000,
        ]
        assert all(job.status == JobStatus.QUEUED for job in jobs)
        assert db.get(Meeting, meeting.id).status == MeetingStatus.RECORDING


def test_realtime_window_extraction_seeks_before_opening_input(monkeypatch, tmp_path: Path):
    calls: list[list[str]] = []

    def fake_run(arguments: list[str], **_kwargs):
        calls.append(arguments)
        Path(arguments[-1]).write_bytes(b"RIFF-fake")
        return subprocess.CompletedProcess(arguments, 0, "", "")

    monkeypatch.setattr(subprocess, "run", fake_run)
    source = tmp_path / "audio.webm"
    source.write_bytes(b"webm")

    RealtimeWindowMediaService().extract_audio_window(
        source, tmp_path / "window.wav", start_ms=3_590_000, end_ms=3_620_000
    )

    arguments = calls[0]
    # Input seeking keeps each window cheap regardless of how long the meeting is.
    assert arguments.index("-ss") < arguments.index("-i")
    assert arguments[arguments.index("-ss") + 1] == "3590.000"
    assert arguments[arguments.index("-t") + 1] == "30.000"
    assert arguments[arguments.index("-i") + 1] == str(source)

import uuid
from dataclasses import dataclass
from datetime import timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.orm import Session, sessionmaker

from app.api.dependencies import get_storage
from app.main import app
from app.models.analysis import (
    AnalysisItem,
    AnalysisItemKind,
    AnalysisItemState,
    AnalysisStatus,
    AnalysisVersion,
)
from app.models.job import Job, JobStatus, JobType
from app.models.media import Media, MediaKind
from app.models.meeting import Meeting, MeetingSourceType, MeetingStatus
from app.models.question import MeetingQuestion, MeetingQuestionStatus
from app.models.realtime import RealtimeSession, RealtimeSessionStatus
from app.models.transcript import (
    TranscriptKind,
    TranscriptSegment,
    TranscriptStatus,
    TranscriptVersion,
)
from app.services.jobs import fail_job, finish_job
from app.services.jobs.meeting_status import AUXILIARY_JOB_TYPES
from app.services.media import MediaStorage


@dataclass
class SavedMeeting:
    id: uuid.UUID
    transcript_id: uuid.UUID
    analysis_id: uuid.UUID
    capture_id: uuid.UUID
    media_id: uuid.UUID
    thumbnail_job_id: uuid.UUID
    storage: MediaStorage


@pytest.fixture
def saved_meeting(
    client: TestClient,
    session_factory: sessionmaker[Session],
    tmp_path: Path,
) -> SavedMeeting:
    storage = MediaStorage(tmp_path, 1)
    app.dependency_overrides[get_storage] = lambda: storage
    with session_factory() as session:
        meeting = Meeting(
            title="Stale thumbnail failure",
            source_type=MeetingSourceType.LIVE,
            status=MeetingStatus.FAILED,
            ai_disabled=True,
        )
        session.add(meeting)
        session.flush()
        transcript = TranscriptVersion(
            meeting_id=meeting.id,
            version=1,
            kind=TranscriptKind.LIVE,
            status=TranscriptStatus.COMPLETED,
            language="ja",
            model="stt-rt-v5",
            diarization_enabled=True,
        )
        source = Media(
            meeting_id=meeting.id,
            kind=MediaKind.ORIGINAL_VIDEO,
            storage_path=f"meetings/{meeting.id}/original/video.mp4",
            mime_type="video/mp4",
            size_bytes=5,
        )
        playback = Media(
            meeting_id=meeting.id,
            kind=MediaKind.PLAYBACK_VIDEO,
            storage_path=f"meetings/{meeting.id}/derived/playback.mp4",
            mime_type="video/mp4",
            size_bytes=5,
        )
        session.add_all([transcript, source, playback])
        session.flush()
        analysis = AnalysisVersion(
            meeting_id=meeting.id,
            transcript_version_id=transcript.id,
            version=1,
            model="test",
            temperature=0,
            prompt_version="test",
            status=AnalysisStatus.COMPLETED,
            template_snapshot={"revision": 1},
            template_values=[{"user_value": "keep"}],
        )
        analysis.items = [
            AnalysisItem(
                kind=AnalysisItemKind.SUMMARY,
                sequence=0,
                content="Keep confirmed note",
                state=AnalysisItemState.CONFIRMED,
            )
        ]
        capture = RealtimeSession(
            meeting_id=meeting.id,
            media_id=source.id,
            transcript_version_id=transcript.id,
            status=RealtimeSessionStatus.COMPLETED,
            mime_type="video/mp4",
        )
        session.add_all([analysis, capture])
        session.flush()
        meeting.active_transcript_version_id = transcript.id
        meeting.active_analysis_version_id = analysis.id
        thumbnail = Job(
            meeting_id=meeting.id,
            type=JobType.GENERATE_THUMBNAILS,
            status=JobStatus.FAILED,
            attempts=1,
            error_message="old worker",
        )
        session.add_all(
            [
                thumbnail,
                Job(
                    meeting_id=meeting.id, type=JobType.PREPROCESS_MEDIA, status=JobStatus.COMPLETED
                ),
                Job(meeting_id=meeting.id, type=JobType.ANALYZE, status=JobStatus.COMPLETED),
            ]
        )
        session.commit()
        path = storage.absolute_path(playback.storage_path)
        path.parent.mkdir(parents=True)
        path.write_bytes(b"video")
        return SavedMeeting(
            meeting.id, transcript.id, analysis.id, capture.id, playback.id, thumbnail.id, storage
        )


def reconcile(client: TestClient, saved: SavedMeeting) -> str:
    response = client.post(f"/api/v1/meetings/{saved.id}/reconcile-status")
    assert response.status_code == 200
    return str(response.json()["status"])


def test_successful_thumbnail_retry_restores_legacy_failure_without_changing_notes(
    session_factory: sessionmaker[Session],
    saved_meeting: SavedMeeting,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.core.config import get_settings
    from app.services.jobs import meeting_status

    monkeypatch.setattr(
        meeting_status,
        "get_settings",
        lambda: get_settings().model_copy(update={"storage_root": saved_meeting.storage.root}),
    )
    with session_factory() as session:
        job = session.get(Job, saved_meeting.thumbnail_job_id)
        assert job is not None
        job.attempts = 2
        job.status = JobStatus.RUNNING
        finish_job(session, job)
        meeting = session.get(Meeting, saved_meeting.id)
        analysis = session.get(AnalysisVersion, saved_meeting.analysis_id)
        assert meeting is not None and analysis is not None
        assert meeting.status == MeetingStatus.COMPLETED
        assert job.status == JobStatus.COMPLETED and job.attempts == 2
        assert meeting.active_transcript_version_id == saved_meeting.transcript_id
        assert meeting.active_analysis_version_id == analysis.id
        assert analysis.items[0].state == AnalysisItemState.CONFIRMED
        assert analysis.items[0].content == "Keep confirmed note"
        assert analysis.template_snapshot == {"revision": 1}
        assert analysis.template_values == [{"user_value": "keep"}]
        assert session.scalar(select(func.count()).select_from(Job)) == 3


def test_reconcile_is_idempotent_and_get_remains_read_only(
    client: TestClient,
    session_factory: sessionmaker[Session],
    saved_meeting: SavedMeeting,
) -> None:
    assert client.get(f"/api/v1/meetings/{saved_meeting.id}").json()["status"] == "failed"
    assert client.get("/api/v1/meetings").json()["items"][0]["status"] == "failed"
    assert reconcile(client, saved_meeting) == "completed"
    first = client.get(f"/api/v1/meetings/{saved_meeting.id}").json()
    assert reconcile(client, saved_meeting) == "completed"
    assert client.get(f"/api/v1/meetings/{saved_meeting.id}").json() == first
    assert client.get("/api/v1/meetings").json()["items"][0]["status"] == "completed"
    with session_factory() as session:
        job = session.get(Job, saved_meeting.thumbnail_job_id)
        assert (
            job is not None and job.status == JobStatus.FAILED and job.error_message == "old worker"
        )
        assert session.scalar(select(func.count()).select_from(Job)) == 3


@pytest.mark.parametrize(
    "status",
    [
        RealtimeSessionStatus.RECORDING,
        RealtimeSessionStatus.FINALIZING,
        RealtimeSessionStatus.FAILED,
    ],
)
def test_active_or_failed_capture_cannot_be_hidden(
    status: RealtimeSessionStatus,
    client: TestClient,
    session_factory: sessionmaker[Session],
    saved_meeting: SavedMeeting,
) -> None:
    with session_factory() as session:
        capture = session.get(RealtimeSession, saved_meeting.capture_id)
        assert capture is not None
        capture.status = status
        session.commit()
    assert reconcile(client, saved_meeting) == "failed"


def test_older_active_capture_is_not_hidden_by_a_completed_capture(
    client: TestClient,
    session_factory: sessionmaker[Session],
    saved_meeting: SavedMeeting,
) -> None:
    with session_factory() as session:
        latest = session.get(RealtimeSession, saved_meeting.capture_id)
        assert latest is not None
        media = Media(
            meeting_id=saved_meeting.id,
            kind=MediaKind.ORIGINAL_AUDIO,
            storage_path="older/capture.webm",
            mime_type="audio/webm",
            size_bytes=1,
        )
        older_transcript = TranscriptVersion(
            meeting_id=saved_meeting.id,
            version=2,
            kind=TranscriptKind.LIVE,
            status=TranscriptStatus.PROCESSING,
            language="ja",
            model="stt-rt-v5",
            diarization_enabled=True,
        )
        session.add_all([media, older_transcript])
        session.flush()
        session.add(
            RealtimeSession(
                meeting_id=saved_meeting.id,
                media_id=media.id,
                transcript_version_id=older_transcript.id,
                status=RealtimeSessionStatus.RECORDING,
                mime_type="audio/webm",
                started_at=latest.started_at - timedelta(hours=1),
            )
        )
        session.commit()
    assert reconcile(client, saved_meeting) == "failed"


@pytest.mark.parametrize("status", [JobStatus.QUEUED, JobStatus.RUNNING, JobStatus.FAILED])
def test_pending_or_failed_main_job_cannot_be_hidden_by_saved_results(
    status: JobStatus,
    client: TestClient,
    session_factory: sessionmaker[Session],
    saved_meeting: SavedMeeting,
) -> None:
    with session_factory() as session:
        session.add(Job(meeting_id=saved_meeting.id, type=JobType.ANALYZE, status=status))
        session.commit()
    assert reconcile(client, saved_meeting) == "failed"


def test_completed_replacement_ignores_old_failed_job_but_does_not_delete_it(
    client: TestClient,
    session_factory: sessionmaker[Session],
    saved_meeting: SavedMeeting,
) -> None:
    with session_factory() as session:
        old = Job(meeting_id=saved_meeting.id, type=JobType.ANALYZE, status=JobStatus.FAILED)
        session.add(old)
        session.flush()
        session.add(
            Job(meeting_id=saved_meeting.id, type=JobType.ANALYZE, status=JobStatus.COMPLETED)
        )
        session.commit()
        old_id = old.id
    assert reconcile(client, saved_meeting) == "completed"
    with session_factory() as session:
        assert session.get(Job, old_id).status == JobStatus.FAILED  # type: ignore[union-attr]


@pytest.mark.parametrize(
    "missing",
    ["file", "empty_file", "playback", "transcript", "recorded_transcript"],
)
def test_incomplete_saved_result_is_not_marked_completed(
    missing: str,
    client: TestClient,
    session_factory: sessionmaker[Session],
    saved_meeting: SavedMeeting,
) -> None:
    with session_factory() as session:
        media = session.get(Media, saved_meeting.media_id)
        assert media is not None
        if missing == "file":
            saved_meeting.storage.delete_file(media.storage_path)
        elif missing == "empty_file":
            saved_meeting.storage.absolute_path(media.storage_path).write_bytes(b"")
        elif missing == "playback":
            session.delete(media)
        elif missing == "recorded_transcript":
            transcript = session.get(TranscriptVersion, saved_meeting.transcript_id)
            assert transcript is not None
            transcript.status = TranscriptStatus.PROCESSING
        else:
            meeting = session.get(Meeting, saved_meeting.id)
            capture = session.get(RealtimeSession, saved_meeting.capture_id)
            assert meeting is not None and capture is not None
            meeting.active_analysis_version_id = None
            meeting.active_transcript_version_id = None
            session.delete(capture)
        session.commit()
    assert reconcile(client, saved_meeting) == "failed"


def test_saved_live_without_ai_or_final_can_be_restored_without_jobs(
    client: TestClient,
    session_factory: sessionmaker[Session],
    saved_meeting: SavedMeeting,
) -> None:
    with session_factory() as session:
        meeting = session.get(Meeting, saved_meeting.id)
        analysis = session.get(AnalysisVersion, saved_meeting.analysis_id)
        assert meeting is not None and analysis is not None
        meeting.active_analysis_version_id = None
        session.delete(analysis)
        session.commit()
    before = client.get(f"/api/v1/meetings/{saved_meeting.id}/jobs").json()
    assert reconcile(client, saved_meeting) == "completed"
    assert client.get(f"/api/v1/meetings/{saved_meeting.id}/jobs").json() == before


def test_uploaded_audio_with_saved_final_can_be_restored(
    client: TestClient,
    session_factory: sessionmaker[Session],
    saved_meeting: SavedMeeting,
) -> None:
    with session_factory() as session:
        meeting = session.get(Meeting, saved_meeting.id)
        capture = session.get(RealtimeSession, saved_meeting.capture_id)
        transcript = session.get(TranscriptVersion, saved_meeting.transcript_id)
        media = session.get(Media, saved_meeting.media_id)
        source = session.scalar(
            select(Media).where(
                Media.meeting_id == saved_meeting.id, Media.kind == MediaKind.ORIGINAL_VIDEO
            )
        )
        assert (
            meeting is not None
            and capture is not None
            and transcript is not None
            and media is not None
            and source is not None
        )
        meeting.source_type = MeetingSourceType.AUDIO_UPLOAD
        transcript.kind = TranscriptKind.FINAL
        session.delete(capture)
        session.delete(source)
        media.kind = MediaKind.ORIGINAL_AUDIO
        session.commit()
    assert reconcile(client, saved_meeting) == "completed"


@pytest.mark.parametrize("job_type", sorted(AUXILIARY_JOB_TYPES))
@pytest.mark.parametrize("status", [MeetingStatus.RECORDING, MeetingStatus.COMPLETED])
def test_auxiliary_failure_keeps_meeting_status(
    job_type: JobType,
    status: MeetingStatus,
    session_factory: sessionmaker[Session],
    saved_meeting: SavedMeeting,
) -> None:
    with session_factory() as session:
        meeting = session.get(Meeting, saved_meeting.id)
        assert meeting is not None
        meeting.status = status
        job = Job(meeting_id=meeting.id, type=job_type, status=JobStatus.RUNNING)
        session.add(job)
        session.commit()
        fail_job(session, job, "auxiliary API error")
        assert meeting.status == status
        assert job.status == JobStatus.FAILED


@pytest.mark.parametrize("job_type", sorted(AUXILIARY_JOB_TYPES))
def test_auxiliary_retry_does_not_mark_completed_meeting_queued(
    job_type: JobType,
    client: TestClient,
    session_factory: sessionmaker[Session],
    saved_meeting: SavedMeeting,
) -> None:
    with session_factory() as session:
        meeting = session.get(Meeting, saved_meeting.id)
        assert meeting is not None
        meeting.status = MeetingStatus.COMPLETED
        job = Job(meeting_id=meeting.id, type=job_type, status=JobStatus.FAILED)
        session.add(job)
        session.flush()
        if job_type == JobType.ASK_MEETING:
            session.add(
                TranscriptSegment(
                    transcript_version_id=saved_meeting.transcript_id,
                    sequence=0,
                    start_ms=0,
                    end_ms=1000,
                    text="保存された発言",
                )
            )
            session.add(
                MeetingQuestion(
                    meeting_id=meeting.id,
                    transcript_version_id=saved_meeting.transcript_id,
                    job_id=job.id,
                    question="保存済み原文について",
                    model="test",
                    status=MeetingQuestionStatus.FAILED,
                )
            )
        session.commit()
        job_id = job.id
    response = client.post(f"/api/v1/jobs/{job_id}/retry")
    assert response.status_code == 200
    assert response.json()["status"] == "queued"
    assert client.get(f"/api/v1/meetings/{saved_meeting.id}").json()["status"] == "completed"


def test_unknown_meeting_is_not_created(client: TestClient) -> None:
    assert client.post(f"/api/v1/meetings/{uuid.uuid4()}/reconcile-status").status_code == 404

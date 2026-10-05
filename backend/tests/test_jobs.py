from fastapi.testclient import TestClient
from sqlalchemy.orm import Session, sessionmaker

from app.models.job import Job, JobStatus, JobType
from app.models.meeting import Meeting, MeetingSourceType
from app.services.jobs import (
    LIVE_TRANSCRIPTION_JOB_TYPES,
    claim_next_job,
    fail_job,
    recover_interrupted_jobs,
)


def test_failed_job_can_be_retried(
    client: TestClient, session_factory: sessionmaker[Session]
) -> None:
    with session_factory() as session:
        meeting = Meeting(title="Job test", source_type=MeetingSourceType.AUDIO_UPLOAD)
        session.add(meeting)
        session.flush()
        job = Job(
            meeting_id=meeting.id,
            type=JobType.TRANSCRIBE,
            status=JobStatus.FAILED,
            error_message="service unavailable",
        )
        session.add(job)
        session.commit()
        meeting_id = meeting.id
        job_id = job.id

    list_response = client.get(f"/api/v1/meetings/{meeting_id}/jobs")
    assert list_response.status_code == 200
    assert list_response.json()[0]["status"] == "failed"

    retry_response = client.post(f"/api/v1/jobs/{job_id}/retry")
    assert retry_response.status_code == 200
    assert retry_response.json()["status"] == "queued"
    assert retry_response.json()["error_message"] is None

    second_retry = client.post(f"/api/v1/jobs/{job_id}/retry")
    assert second_retry.status_code == 409


def test_claim_and_fail_job(session_factory: sessionmaker[Session]) -> None:
    with session_factory() as session:
        meeting = Meeting(title="Worker test", source_type=MeetingSourceType.LIVE)
        session.add(meeting)
        session.flush()
        session.add(Job(meeting_id=meeting.id, type=JobType.PREPROCESS_MEDIA))
        session.commit()

        claimed = claim_next_job(session)
        assert claimed is not None
        assert claimed.status == JobStatus.RUNNING
        assert claimed.attempts == 1

        fail_job(session, claimed, "expected failure")
        assert claimed.status == JobStatus.FAILED
        assert claimed.error_message == "expected failure"


def test_recover_interrupted_jobs_requeues_running_work(
    session_factory: sessionmaker[Session],
) -> None:
    with session_factory() as session:
        meeting = Meeting(title="Recovery test", source_type=MeetingSourceType.LIVE)
        session.add(meeting)
        session.flush()
        interrupted = Job(
            meeting_id=meeting.id,
            type=JobType.TRANSCRIBE_LIVE,
            status=JobStatus.RUNNING,
            attempts=1,
            progress=40,
        )
        session.add(interrupted)
        session.commit()

        recovered = recover_interrupted_jobs(session, LIVE_TRANSCRIPTION_JOB_TYPES)

        assert recovered == 1
        assert interrupted.status == JobStatus.QUEUED
        assert interrupted.attempts == 1
        assert interrupted.progress == 0
        assert interrupted.started_at is None


def test_live_transcription_queue_is_separate_from_general_queue(
    session_factory: sessionmaker[Session],
) -> None:
    with session_factory() as session:
        meeting = Meeting(title="Queue test", source_type=MeetingSourceType.LIVE)
        session.add(meeting)
        session.flush()
        # The long final job is older, but must not delay live captions.
        final_job = Job(meeting_id=meeting.id, type=JobType.TRANSCRIBE)
        session.add(final_job)
        session.flush()
        live_job = Job(meeting_id=meeting.id, type=JobType.TRANSCRIBE_LIVE)
        session.add(live_job)
        session.commit()

        assert claim_next_job(session, LIVE_TRANSCRIPTION_JOB_TYPES) is live_job
        assert claim_next_job(session, LIVE_TRANSCRIPTION_JOB_TYPES) is None
        assert claim_next_job(session) is final_job
        assert claim_next_job(session) is None


def test_general_worker_does_not_recover_running_live_transcription(
    session_factory: sessionmaker[Session],
) -> None:
    with session_factory() as session:
        meeting = Meeting(title="Recovery scope test", source_type=MeetingSourceType.LIVE)
        session.add(meeting)
        session.flush()
        live_job = Job(
            meeting_id=meeting.id, type=JobType.TRANSCRIBE_LIVE, status=JobStatus.RUNNING
        )
        final_job = Job(meeting_id=meeting.id, type=JobType.TRANSCRIBE, status=JobStatus.RUNNING)
        session.add_all([live_job, final_job])
        session.commit()

        # Restarting the general worker must not requeue work the live worker is doing.
        assert recover_interrupted_jobs(session) == 1
        assert final_job.status == JobStatus.QUEUED
        assert live_job.status == JobStatus.RUNNING

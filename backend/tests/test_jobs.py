from fastapi.testclient import TestClient
from sqlalchemy.orm import Session, sessionmaker

from app.models.job import Job, JobStatus, JobType
from app.models.meeting import Meeting, MeetingSourceType
from app.services.jobs import claim_next_job, fail_job, recover_interrupted_jobs


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

        recovered = recover_interrupted_jobs(session)

        assert recovered == 1
        assert interrupted.status == JobStatus.QUEUED
        assert interrupted.attempts == 1
        assert interrupted.progress == 0
        assert interrupted.started_at is None

import uuid
from collections.abc import Collection

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.job import Job, JobStatus, JobType
from app.models.meeting import Meeting, MeetingStatus, utc_now

# Live transcription has its own worker so captions never wait behind
# hour-long final transcription or AI jobs on the general queue.
LIVE_TRANSCRIPTION_JOB_TYPES = frozenset({JobType.TRANSCRIBE_LIVE})
# Types claimed and recovered by dedicated workers, never by the general one.
DEDICATED_JOB_TYPES = frozenset(
    {JobType.ANALYZE_REALTIME, JobType.ANSWER_LIVE, *LIVE_TRANSCRIPTION_JOB_TYPES}
)
GENERAL_JOB_TYPES = frozenset(JobType) - DEDICATED_JOB_TYPES


def enqueue_job(session: Session, meeting_id: uuid.UUID, job_type: JobType) -> Job:
    job = Job(meeting_id=meeting_id, type=job_type)
    session.add(job)
    session.commit()
    session.refresh(job)
    return job


def recover_interrupted_jobs(
    session: Session, job_types: Collection[JobType] = GENERAL_JOB_TYPES
) -> int:
    jobs = list(
        session.scalars(
            select(Job)
            .where(
                Job.status == JobStatus.RUNNING,
                Job.type.in_(list(job_types)),
            )
            .with_for_update(skip_locked=True)
        )
    )
    for job in jobs:
        job.status = JobStatus.QUEUED
        job.progress = None if job.type in {JobType.ANALYZE, JobType.ASK_MEETING} else 0
        job.started_at = None
        job.finished_at = None
        job.error_message = None
    session.commit()
    return len(jobs)


def claim_next_job(
    session: Session, job_types: Collection[JobType] = GENERAL_JOB_TYPES
) -> Job | None:
    statement = (
        select(Job)
        .where(
            Job.status == JobStatus.QUEUED,
            Job.type.in_(list(job_types)),
        )
        .order_by(Job.created_at, Job.realtime_commit_start_ms.asc().nulls_first(), Job.id)
        .with_for_update(skip_locked=True)
        .limit(1)
    )
    job = session.scalar(statement)
    if job is None:
        return None

    job.status = JobStatus.RUNNING
    job.attempts += 1
    job.started_at = utc_now()
    job.finished_at = None
    job.error_message = None
    session.commit()
    session.refresh(job)
    return job


def finish_job(session: Session, job: Job) -> None:
    job.status = JobStatus.COMPLETED
    job.progress = 100
    job.finished_at = utc_now()
    session.commit()


def fail_job(session: Session, job: Job, error_message: str) -> None:
    from app.services.analysis import mark_analysis_failed
    from app.services.knowledge.answer_assist import mark_answer_failed
    from app.services.questions import mark_meeting_question_failed

    job.status = JobStatus.FAILED
    job.finished_at = utc_now()
    job.error_message = error_message[:2000]
    if job.type == JobType.ANALYZE:
        mark_analysis_failed(session, job, error_message)
    if job.type == JobType.ASK_MEETING:
        mark_meeting_question_failed(session, job, error_message)
    if job.type == JobType.ANSWER_LIVE:
        mark_answer_failed(session, job, error_message)
    meeting = session.get(Meeting, job.meeting_id)
    if meeting is not None and job.type not in {
        JobType.TRANSCRIBE_LIVE,
        JobType.ASK_MEETING,
        JobType.ANSWER_LIVE,
    }:
        meeting.status = MeetingStatus.FAILED
    session.commit()

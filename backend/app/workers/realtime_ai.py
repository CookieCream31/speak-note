import logging
import signal
import time
import uuid
from types import FrameType

from sqlalchemy import select

from app.core.config import get_settings
from app.db.session import SessionLocal
from app.models.job import Job, JobStatus, JobType
from app.models.meeting import utc_now
from app.services.analysis.realtime import (
    mark_realtime_analysis_failed,
    process_realtime_analysis_job,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)
running = True


def stop_worker(_signum: int, _frame: FrameType | None) -> None:
    global running
    running = False


def _recover_jobs() -> int:
    with SessionLocal() as session:
        jobs = list(
            session.scalars(
                select(Job).where(
                    Job.type == JobType.ANALYZE_REALTIME,
                    Job.status == JobStatus.RUNNING,
                )
            )
        )
        for job in jobs:
            job.status = JobStatus.QUEUED
            job.progress = None
            job.started_at = None
            job.finished_at = None
            job.error_message = None
        session.commit()
        return len(jobs)


def _claim_job() -> Job | None:
    with SessionLocal() as session:
        job = session.scalar(
            select(Job)
            .where(
                Job.type == JobType.ANALYZE_REALTIME,
                Job.status == JobStatus.QUEUED,
            )
            .order_by(Job.created_at, Job.id)
            .with_for_update(skip_locked=True)
            .limit(1)
        )
        if job is None:
            return None
        job.status = JobStatus.RUNNING
        job.attempts += 1
        job.started_at = utc_now()
        job.finished_at = None
        job.error_message = None
        session.commit()
        session.expunge(job)
        return job


def _finish(job_id: uuid.UUID) -> None:
    with SessionLocal() as session:
        job = session.get(Job, job_id)
        if job is None:
            return
        job.status = JobStatus.COMPLETED
        job.progress = 100
        job.finished_at = utc_now()
        session.commit()


def _fail(job_id: uuid.UUID, message: str) -> None:
    with SessionLocal() as session:
        job = session.get(Job, job_id)
        if job is None:
            return
        job.status = JobStatus.FAILED
        job.error_message = message[:2_000]
        job.finished_at = utc_now()
        mark_realtime_analysis_failed(session, job, message)
        session.commit()


def run() -> None:
    signal.signal(signal.SIGTERM, stop_worker)
    signal.signal(signal.SIGINT, stop_worker)
    poll_interval = get_settings().worker_poll_interval_seconds
    recovered = _recover_jobs()
    if recovered:
        logger.warning("Requeued %s interrupted realtime analysis job(s)", recovered)
    logger.info("speak-note realtime AI worker started")

    while running:
        job = _claim_job()
        if job is None:
            time.sleep(poll_interval)
            continue
        logger.info("Processing realtime AI job %s", job.id)
        try:
            with SessionLocal() as session:
                attached_job = session.get(Job, job.id)
                if attached_job is None:
                    continue
                process_realtime_analysis_job(session, attached_job, get_settings())
        except Exception as exc:
            safe_message = str(exc) or "Unexpected realtime AI worker error"
            _fail(job.id, safe_message)
            logger.exception("Realtime AI job %s failed", job.id)
        else:
            _finish(job.id)

    logger.info("speak-note realtime AI worker stopped")


if __name__ == "__main__":
    run()

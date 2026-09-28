"""Dedicated answer queue so live transcription and final media jobs remain independent."""

import logging
import signal
import time
from types import FrameType

from sqlalchemy import select

from app.core.config import get_settings
from app.db.session import SessionLocal
from app.models.job import Job, JobStatus, JobType
from app.models.meeting import utc_now
from app.services.jobs import fail_job, finish_job
from app.services.knowledge.answer_assist import process_answer
from app.services.knowledge.answer_monitor import enqueue_monitor_checks

logger = logging.getLogger(__name__)
running = True


def stop(_signum: int, _frame: FrameType | None) -> None:
    global running
    running = False


def run() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    settings = get_settings()
    with SessionLocal() as session:
        for interrupted_job in session.scalars(
            select(Job).where(Job.type == JobType.ANSWER_LIVE, Job.status == JobStatus.RUNNING)
        ):
            interrupted_job.status = JobStatus.QUEUED
            interrupted_job.started_at = None
            interrupted_job.error_message = None
        session.commit()
    while running:
        with SessionLocal() as session:
            enqueue_monitor_checks(session)
            job = session.scalar(
                select(Job)
                .where(Job.type == JobType.ANSWER_LIVE, Job.status == JobStatus.QUEUED)
                .order_by(Job.created_at, Job.id)
                .with_for_update(skip_locked=True)
                .limit(1)
            )
            if job is None:
                time.sleep(settings.worker_poll_interval_seconds)
                continue
            job.status = JobStatus.RUNNING
            job.attempts += 1
            job.started_at = utc_now()
            job.error_message = None
            session.commit()
            try:
                process_answer(session, job, settings)
            except Exception as exc:
                session.rollback()
                fail_job(session, job, str(exc) or "回答生成に失敗しました")
                logger.warning("Answer assistance job %s failed", job.id)
            else:
                finish_job(session, job)


if __name__ == "__main__":
    run()

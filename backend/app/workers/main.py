import logging
import signal
import time
from collections.abc import Callable, Collection
from types import FrameType

from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.db.session import SessionLocal
from app.models.job import Job, JobType
from app.models.realtime import RealtimeChunk, RealtimeSession
from app.services.analysis import process_analysis_job
from app.services.jobs import (
    GENERAL_JOB_TYPES,
    claim_next_job,
    fail_job,
    finish_job,
    recover_interrupted_jobs,
)
from app.services.media import (
    FFmpegMediaService,
    MediaStorage,
    RealtimeWindowMediaService,
    process_video_job,
)
from app.services.questions import process_meeting_question_job
from app.services.realtime import process_live_transcription_job
from app.services.transcription import (
    TranscriptionClient,
    WhisperXClient,
    process_transcription_job,
)
from app.services.transcription.settings import build_realtime_transcription_client

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)
running = True


class UnsupportedJobTypeError(Exception):
    pass


def stop_worker(_signum: int, _frame: FrameType | None) -> None:
    global running
    running = False


def _whisper_client() -> WhisperXClient:
    settings = get_settings()
    return WhisperXClient(
        base_url=settings.whisperx_base_url,
        api_key=settings.whisperx_api_key.get_secret_value(),
        model=settings.whisperx_model,
        language=settings.whisperx_language,
        timeout_seconds=settings.whisperx_timeout_seconds,
        max_attempts=settings.whisperx_max_attempts,
        retry_delay_seconds=settings.whisperx_retry_delay_seconds,
    )


def _realtime_client(session: Session, job: Job) -> TranscriptionClient:
    if job.realtime_chunk_id is None:
        raise RuntimeError("Realtime ChunkがJobに設定されていません")
    chunk = session.get(RealtimeChunk, job.realtime_chunk_id)
    if chunk is None:
        raise RuntimeError("Realtime Chunkが見つかりません")
    realtime_session = session.get(RealtimeSession, chunk.session_id)
    if realtime_session is None:
        raise RuntimeError("Realtime Sessionが見つかりません")
    return build_realtime_transcription_client(session, realtime_session, get_settings())


def process_job(session: Session, job: Job) -> None:
    settings = get_settings()
    storage = MediaStorage(
        settings.storage_root,
        settings.max_audio_upload_mb,
        settings.max_video_upload_mb,
    )
    if job.type == JobType.PREPROCESS_MEDIA:
        process_video_job(session, job, FFmpegMediaService(), storage)
        return
    if job.type == JobType.TRANSCRIBE:
        process_transcription_job(session, job, _whisper_client(), storage)
        return
    if job.type == JobType.TRANSCRIBE_LIVE:
        process_live_transcription_job(
            session,
            job,
            _realtime_client(session, job),
            storage,
            RealtimeWindowMediaService(),
            window_ms=settings.realtime_window_ms,
            step_ms=settings.realtime_chunk_ms,
        )
        return
    if job.type == JobType.ANALYZE:
        process_analysis_job(session, job, settings)
        return
    if job.type == JobType.ASK_MEETING:
        process_meeting_question_job(session, job, settings)
        return
    raise UnsupportedJobTypeError(f"No processor is registered for job type '{job.type.value}'")


def run(
    job_types: Collection[JobType] = GENERAL_JOB_TYPES,
    worker_name: str = "speak-note worker",
    maintenance: Callable[[Session], None] | None = None,
) -> None:
    signal.signal(signal.SIGTERM, stop_worker)
    signal.signal(signal.SIGINT, stop_worker)
    poll_interval = get_settings().worker_poll_interval_seconds
    with SessionLocal() as session:
        recovered_jobs = recover_interrupted_jobs(session, job_types)
    if recovered_jobs:
        logger.warning("Requeued %s interrupted job(s)", recovered_jobs)
    logger.info("%s started", worker_name)

    while running:
        if maintenance is not None:
            with SessionLocal() as session:
                try:
                    maintenance(session)
                except Exception:
                    session.rollback()
                    logger.exception("%s maintenance failed", worker_name)
        with SessionLocal() as session:
            job = claim_next_job(session, job_types)
            if job is None:
                time.sleep(poll_interval)
                continue

            logger.info("Processing job %s (%s)", job.id, job.type.value)
            try:
                process_job(session, job)
            except UnsupportedJobTypeError as exc:
                session.rollback()
                fail_job(session, job, str(exc))
                logger.warning("Job %s has no registered processor", job.id)
            except Exception as exc:
                session.rollback()
                safe_message = str(exc) or "Unexpected worker error"
                fail_job(session, job, safe_message)
                logger.exception("Job %s failed", job.id)
            else:
                finish_job(session, job)

    logger.info("%s stopped", worker_name)


if __name__ == "__main__":
    run()

"""Dedicated live transcription queue so captions never wait behind final or AI jobs."""

import time

from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.services.jobs import LIVE_TRANSCRIPTION_JOB_TYPES
from app.services.media import MediaStorage
from app.services.realtime import finalize_stale_realtime_sessions
from app.workers.main import run

STALE_SESSION_CHECK_INTERVAL_SECONDS = 30.0
_last_stale_check = 0.0


def finalize_abandoned_recordings(session: Session) -> None:
    """Save recordings whose browser never reconnected within the resume timeout."""
    global _last_stale_check
    now = time.monotonic()
    if now - _last_stale_check < STALE_SESSION_CHECK_INTERVAL_SECONDS:
        return
    _last_stale_check = now
    settings = get_settings()
    storage = MediaStorage(
        settings.storage_root,
        settings.max_audio_upload_mb,
        settings.max_video_upload_mb,
    )
    finalize_stale_realtime_sessions(
        session, storage, idle_seconds=settings.realtime_resume_timeout_seconds
    )


if __name__ == "__main__":
    # Run a single replica: windows of one recording are stored in queue order.
    run(
        LIVE_TRANSCRIPTION_JOB_TYPES,
        "speak-note live transcription worker",
        maintenance=finalize_abandoned_recordings,
    )

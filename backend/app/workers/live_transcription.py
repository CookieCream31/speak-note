"""Dedicated live transcription queue so captions never wait behind final or AI jobs."""

from app.services.jobs import LIVE_TRANSCRIPTION_JOB_TYPES
from app.workers.main import run

if __name__ == "__main__":
    # Run a single replica: windows of one recording are stored in queue order.
    run(LIVE_TRANSCRIPTION_JOB_TYPES, "speak-note live transcription worker")

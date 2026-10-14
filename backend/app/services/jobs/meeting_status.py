"""Restore a stale failure only when the saved meeting and its main jobs are complete."""

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.models.analysis import AnalysisStatus, AnalysisVersion
from app.models.job import Job, JobStatus, JobType
from app.models.media import Media, MediaKind
from app.models.meeting import Meeting, MeetingStatus
from app.models.realtime import RealtimeSession, RealtimeSessionStatus
from app.models.transcript import TranscriptKind, TranscriptStatus, TranscriptVersion
from app.services.media.storage import MediaStorage

MAIN_MEETING_JOB_TYPES = frozenset({JobType.PREPROCESS_MEDIA, JobType.TRANSCRIBE, JobType.ANALYZE})
AUXILIARY_JOB_TYPES = frozenset(
    {
        JobType.GENERATE_THUMBNAILS,
        JobType.TRANSCRIBE_LIVE,
        JobType.ANALYZE_REALTIME,
        JobType.ASK_MEETING,
        JobType.ANSWER_LIVE,
    }
)


def restore_completed_meeting(
    session: Session,
    meeting: Meeting,
    storage: MediaStorage | None = None,
) -> bool:
    """Caller commits. Keep real failures/ongoing capture; never regenerate any result."""
    session.flush()
    locked = session.scalar(
        select(Meeting)
        .where(Meeting.id == meeting.id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if locked is None or locked.status != MeetingStatus.FAILED:
        return False

    active_capture = session.scalar(
        select(RealtimeSession.id)
        .where(
            RealtimeSession.meeting_id == locked.id,
            RealtimeSession.status.in_(
                (RealtimeSessionStatus.RECORDING, RealtimeSessionStatus.FINALIZING)
            ),
        )
        .limit(1)
    )
    if active_capture is not None:
        return False

    # A completed older capture cannot prove that a newer failed/active capture succeeded.
    capture = session.scalar(
        select(RealtimeSession)
        .where(RealtimeSession.meeting_id == locked.id)
        .order_by(RealtimeSession.started_at.desc(), RealtimeSession.id.desc())
        .limit(1)
    )
    if capture is not None and capture.status != RealtimeSessionStatus.COMPLETED:
        return False

    jobs = list(
        session.scalars(
            select(Job)
            .where(Job.meeting_id == locked.id, Job.type.in_(MAIN_MEETING_JOB_TYPES))
            .order_by(Job.created_at.desc(), Job.id.desc())
            .execution_options(populate_existing=True)
        )
    )
    if any(job.status in {JobStatus.QUEUED, JobStatus.RUNNING} for job in jobs):
        return False
    latest: dict[JobType, Job] = {}
    for job in jobs:
        latest.setdefault(job.type, job)
    if any(job.status == JobStatus.FAILED for job in latest.values()):
        return False

    # Saved Live remains a valid completed meeting without Final or AI notes.
    # Final/analysis may also belong to old uploads with no capture session.
    transcript_ids = {locked.active_transcript_version_id}
    if capture is not None:
        transcript_ids.add(capture.transcript_version_id)
    completed = session.scalar(
        select(TranscriptVersion.id)
        .where(
            TranscriptVersion.meeting_id == locked.id,
            TranscriptVersion.status == TranscriptStatus.COMPLETED,
            TranscriptVersion.id.in_([value for value in transcript_ids if value is not None]),
            TranscriptVersion.kind.in_(
                [TranscriptKind.FINAL, TranscriptKind.LIVE]
                if capture is not None
                else [TranscriptKind.FINAL]
            ),
        )
        .limit(1)
    )
    if completed is None:
        completed = session.scalar(
            select(AnalysisVersion.id)
            .join(TranscriptVersion)
            .where(
                AnalysisVersion.id == locked.active_analysis_version_id,
                AnalysisVersion.meeting_id == locked.id,
                AnalysisVersion.status == AnalysisStatus.COMPLETED,
                TranscriptVersion.meeting_id == locked.id,
                TranscriptVersion.status == TranscriptStatus.COMPLETED,
            )
            .limit(1)
        )
    if completed is None:
        return False

    media = list(session.scalars(select(Media).where(Media.meeting_id == locked.id)))
    # An original video alone is insufficient: its required conversion may have failed.
    playback_kind = (
        MediaKind.PLAYBACK_VIDEO
        if any(row.kind == MediaKind.ORIGINAL_VIDEO for row in media)
        else MediaKind.ORIGINAL_AUDIO
    )
    playback = next(
        (row for row in media if row.kind == playback_kind and row.size_bytes > 0), None
    )
    if playback is None:
        return False
    if storage is None:
        settings = get_settings()
        storage = MediaStorage(settings.storage_root, settings.max_audio_upload_mb)
    try:
        path = storage.absolute_path(playback.storage_path)
        if not path.is_file() or path.stat().st_size == 0:
            return False
    except (OSError, ValueError):
        return False

    locked.status = MeetingStatus.COMPLETED
    return True

"""Reusable chapter frames from saved playback video; never process media in HTTP."""

import uuid
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.models.analysis import AnalysisItem, AnalysisItemKind, AnalysisStatus, AnalysisVersion
from app.models.job import Job, JobStatus, JobType
from app.models.media import Media, MediaKind
from app.models.meeting import Meeting, MeetingStatus
from app.models.realtime import RealtimeSession, RealtimeSessionStatus
from app.services.media.ffmpeg import FFmpegMediaService
from app.services.media.storage import MediaStorage


def thumbnail_storage_path(meeting_id: uuid.UUID, media_id: uuid.UUID, start_ms: int) -> str:
    return (
        Path("meetings") / str(meeting_id) / "thumbnails" / str(media_id) / f"{start_ms}.jpg"
    ).as_posix()


def saved_playback_video(session: Session, meeting: Meeting) -> Media | None:
    if meeting.status == MeetingStatus.RECORDING:
        return None
    capturing = session.scalar(
        select(RealtimeSession.id)
        .where(
            RealtimeSession.meeting_id == meeting.id,
            RealtimeSession.status.in_(
                (RealtimeSessionStatus.RECORDING, RealtimeSessionStatus.FINALIZING)
            ),
        )
        .limit(1)
    )
    converting = session.scalar(
        select(Job.id)
        .where(
            Job.meeting_id == meeting.id,
            Job.type == JobType.PREPROCESS_MEDIA,
            Job.status.in_((JobStatus.QUEUED, JobStatus.RUNNING)),
        )
        .limit(1)
    )
    if capturing is not None or converting is not None:
        return None
    return session.scalar(
        select(Media).where(Media.meeting_id == meeting.id, Media.kind == MediaKind.PLAYBACK_VIDEO)
    )


def chapter_items(
    session: Session, meeting_id: uuid.UUID, analysis_id: uuid.UUID | None = None
) -> list[AnalysisItem]:
    statement = (
        select(AnalysisItem)
        .join(AnalysisVersion)
        .where(
            AnalysisVersion.meeting_id == meeting_id,
            AnalysisVersion.status == AnalysisStatus.COMPLETED,
            AnalysisItem.kind == AnalysisItemKind.CHAPTER,
            AnalysisItem.start_ms.is_not(None),
        )
    )
    if analysis_id is not None:
        statement = statement.where(AnalysisVersion.id == analysis_id)
    return list(session.scalars(statement.order_by(AnalysisItem.start_ms, AnalysisItem.id)))


def eligible_chapters(items: list[AnalysisItem], video: Media) -> list[AnalysisItem]:
    return [
        item
        for item in items
        if item.content.strip()
        and item.start_ms is not None
        and item.start_ms >= 0
        and (video.duration_ms is None or item.start_ms < video.duration_ms)
    ]


def latest_thumbnail_job(session: Session, meeting_id: uuid.UUID) -> Job | None:
    # An old failed job must not hide an active retry/new request.
    active = session.scalar(
        select(Job)
        .where(
            Job.meeting_id == meeting_id,
            Job.type == JobType.GENERATE_THUMBNAILS,
            Job.status.in_((JobStatus.QUEUED, JobStatus.RUNNING)),
        )
        .order_by(Job.created_at.desc(), Job.id.desc())
        .limit(1)
    )
    return active or session.scalar(
        select(Job)
        .where(Job.meeting_id == meeting_id, Job.type == JobType.GENERATE_THUMBNAILS)
        .order_by(Job.created_at.desc(), Job.id.desc())
        .limit(1)
    )


def enqueue_chapter_thumbnails(
    session: Session,
    meeting: Meeting,
    storage: MediaStorage | None = None,
) -> Job | None:
    """Reserve at most one meeting-wide job under the same lock as regeneration.

    The caller commits. Files are keyed by playback media and integer timestamp,
    so histories share identical frames and edits cannot display an obsolete frame.
    A failed job needs an explicit retry; browsing must not retry forever.
    """
    session.flush()
    session.scalar(select(Meeting).where(Meeting.id == meeting.id).with_for_update())
    video = saved_playback_video(session, meeting)
    if video is None:
        return None
    items = eligible_chapters(chapter_items(session, meeting.id), video)
    if not items:
        return None
    if storage is None:
        settings = get_settings()
        storage = MediaStorage(settings.storage_root, settings.max_audio_upload_mb)
    missing = any(
        not storage.absolute_path(
            thumbnail_storage_path(meeting.id, video.id, item.start_ms)
        ).is_file()
        for item in items
        if item.start_ms is not None
    )
    if not missing:
        return None
    previous = latest_thumbnail_job(session, meeting.id)
    if previous is not None and previous.status != JobStatus.COMPLETED:
        return previous
    job = Job(meeting_id=meeting.id, type=JobType.GENERATE_THUMBNAILS, progress=0)
    session.add(job)
    session.flush()
    return job


def process_thumbnail_job(
    session: Session,
    job: Job,
    media_service: FFmpegMediaService,
    storage: MediaStorage,
) -> None:
    meeting = session.get(Meeting, job.meeting_id)
    if meeting is None:
        raise RuntimeError("Meeting no longer exists")
    video = saved_playback_video(session, meeting)
    if video is None:
        raise RuntimeError("録音・録画と動画変換の完了後にサムネイルを再試行してください")
    source = storage.absolute_path(video.storage_path)
    if not source.is_file():
        raise RuntimeError("再生用動画が見つかりません")
    timestamps = sorted(
        {
            item.start_ms
            for item in eligible_chapters(chapter_items(session, meeting.id), video)
            if item.start_ms is not None
        }
    )
    for index, start_ms in enumerate(timestamps):
        if saved_playback_video(session, meeting) is None:
            raise RuntimeError("録音・録画と動画変換の完了後にサムネイルを再試行してください")
        destination = storage.absolute_path(thumbnail_storage_path(meeting.id, video.id, start_ms))
        if not destination.is_file():
            media_service.create_thumbnail(source, destination, start_ms)
        job.progress = (index + 1) * 95 // len(timestamps)
        session.commit()

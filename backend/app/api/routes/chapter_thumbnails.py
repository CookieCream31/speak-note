import uuid

from fastapi import APIRouter, HTTPException, Path
from fastapi.responses import FileResponse
from sqlalchemy import select

from app.api.dependencies import DbSession, MeetingDep, StorageDep
from app.models.analysis import AnalysisStatus, AnalysisVersion
from app.models.job import JobStatus
from app.models.media import Media, MediaKind
from app.schemas.job import JobRead
from app.schemas.thumbnail import ChapterThumbnailRead, ChapterThumbnailsRead
from app.services.media.thumbnails import (
    chapter_items,
    eligible_chapters,
    enqueue_chapter_thumbnails,
    latest_thumbnail_job,
    saved_playback_video,
    thumbnail_storage_path,
)

router = APIRouter(prefix="/meetings", tags=["thumbnails"])


def thumbnail_manifest(
    analysis_id: uuid.UUID,
    meeting: MeetingDep,
    session: DbSession,
    storage: StorageDep,
) -> ChapterThumbnailsRead:
    analysis = session.scalar(
        select(AnalysisVersion).where(
            AnalysisVersion.id == analysis_id,
            AnalysisVersion.meeting_id == meeting.id,
            AnalysisVersion.status == AnalysisStatus.COMPLETED,
        )
    )
    if analysis is None:
        raise HTTPException(status_code=404, detail="Analysis not found")
    video = saved_playback_video(session, meeting)
    if video is None:
        return ChapterThumbnailsRead(status="unavailable", thumbnails=[])
    thumbnails = []
    for item in eligible_chapters(chapter_items(session, meeting.id, analysis_id), video):
        assert item.start_ms is not None
        ready = storage.absolute_path(
            thumbnail_storage_path(meeting.id, video.id, item.start_ms)
        ).is_file()
        thumbnails.append(
            ChapterThumbnailRead(
                chapter_id=item.id,
                start_ms=item.start_ms,
                url=f"/api/v1/meetings/{meeting.id}/chapter-thumbnails/{video.id}/{item.start_ms}"
                if ready
                else None,
            )
        )
    if not thumbnails:
        return ChapterThumbnailsRead(status="unavailable", thumbnails=[])
    if all(item.url for item in thumbnails):
        return ChapterThumbnailsRead(status="completed", thumbnails=thumbnails)
    job = latest_thumbnail_job(session, meeting.id)
    result = ChapterThumbnailsRead(status="missing", thumbnails=thumbnails)
    if job is not None and job.status != JobStatus.COMPLETED:
        if job.status == JobStatus.QUEUED:
            result.status = "queued"
        elif job.status == JobStatus.RUNNING:
            result.status = "running"
        else:
            result.status = "failed"
        result.job = JobRead.model_validate(job)
    return result


@router.get("/{meeting_id}/analyses/{analysis_id}/chapter-thumbnails")
def get_chapter_thumbnails(
    analysis_id: uuid.UUID,
    meeting: MeetingDep,
    session: DbSession,
    storage: StorageDep,
) -> ChapterThumbnailsRead:
    return thumbnail_manifest(analysis_id, meeting, session, storage)


@router.post("/{meeting_id}/analyses/{analysis_id}/chapter-thumbnails")
def ensure_chapter_thumbnails(
    analysis_id: uuid.UUID,
    meeting: MeetingDep,
    session: DbSession,
    storage: StorageDep,
) -> ChapterThumbnailsRead:
    # Validate ownership before reserving anything. GET remains read-only.
    result = thumbnail_manifest(analysis_id, meeting, session, storage)
    if result.status == "missing":
        enqueue_chapter_thumbnails(session, meeting, storage)
        session.commit()
        result = thumbnail_manifest(analysis_id, meeting, session, storage)
    return result


@router.get("/{meeting_id}/chapter-thumbnails/{media_id}/{timestamp_ms}")
def get_chapter_thumbnail_content(
    media_id: uuid.UUID,
    meeting: MeetingDep,
    session: DbSession,
    storage: StorageDep,
    timestamp_ms: int = Path(ge=0),
) -> FileResponse:
    video = session.scalar(
        select(Media).where(
            Media.id == media_id,
            Media.meeting_id == meeting.id,
            Media.kind == MediaKind.PLAYBACK_VIDEO,
        )
    )
    if video is None:
        raise HTTPException(status_code=404, detail="Thumbnail not found")
    path = storage.absolute_path(thumbnail_storage_path(meeting.id, video.id, timestamp_ms))
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Thumbnail not found")
    return FileResponse(
        path, media_type="image/jpeg", headers={"Cache-Control": "private, max-age=86400"}
    )

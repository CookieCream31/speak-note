import uuid
from pathlib import Path

from fastapi import APIRouter, HTTPException, status
from fastapi.responses import FileResponse
from sqlalchemy import select

from app.api.dependencies import DbSession, MeetingDep, StorageDep
from app.models.media import Media
from app.models.meeting import Meeting
from app.services.media import MediaStorage

router = APIRouter(prefix="/meetings", tags=["media"])


def _get_media_file(
    media_id: uuid.UUID,
    meeting: Meeting,
    session: DbSession,
    storage: MediaStorage,
) -> tuple[Media, Path]:
    media = session.scalar(
        select(Media).where(Media.id == media_id, Media.meeting_id == meeting.id)
    )
    if media is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Media not found")
    path = storage.absolute_path(media.storage_path)
    if not path.is_file():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Media file not found",
        )
    return media, path


@router.get("/{meeting_id}/media/{media_id}/content", response_class=FileResponse)
def get_media_content(
    media_id: uuid.UUID,
    meeting: MeetingDep,
    session: DbSession,
    storage: StorageDep,
) -> FileResponse:
    media, path = _get_media_file(media_id, meeting, session, storage)
    return FileResponse(
        path,
        media_type=media.mime_type,
        headers={
            "Cache-Control": "private, no-store",
            "Content-Disposition": "inline",
        },
    )


@router.get("/{meeting_id}/media/{media_id}/download", response_class=FileResponse)
def download_media(
    media_id: uuid.UUID,
    meeting: MeetingDep,
    session: DbSession,
    storage: StorageDep,
) -> FileResponse:
    media, path = _get_media_file(media_id, meeting, session, storage)
    suffix = path.suffix.lower()
    title = meeting.title.strip() or "meeting"
    filename = title if suffix and title.lower().endswith(suffix) else f"{title}{suffix}"
    return FileResponse(
        path,
        media_type=media.mime_type,
        filename=filename,
        content_disposition_type="attachment",
        headers={"Cache-Control": "private, no-store"},
    )

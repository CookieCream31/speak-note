import uuid
from typing import Annotated

from fastapi import Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.db.session import get_db
from app.models.meeting import Meeting
from app.services.media import MediaStorage

DbSession = Annotated[Session, Depends(get_db)]


def get_storage() -> MediaStorage:
    settings = get_settings()
    return MediaStorage(
        settings.storage_root,
        settings.max_audio_upload_mb,
        settings.max_video_upload_mb,
    )


StorageDep = Annotated[MediaStorage, Depends(get_storage)]


def get_meeting_or_404(meeting_id: uuid.UUID, session: DbSession) -> Meeting:
    meeting = session.get(Meeting, meeting_id)
    if meeting is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Meeting not found")
    return meeting


MeetingDep = Annotated[Meeting, Depends(get_meeting_or_404)]

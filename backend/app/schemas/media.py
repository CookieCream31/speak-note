import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict

from app.models.media import MediaKind
from app.schemas.job import JobRead


class MediaRead(BaseModel):
    id: uuid.UUID
    meeting_id: uuid.UUID
    kind: MediaKind
    mime_type: str
    size_bytes: int
    duration_ms: int | None
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class MediaUploadRead(BaseModel):
    media: MediaRead
    job: JobRead

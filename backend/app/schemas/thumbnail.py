import uuid
from typing import Literal

from pydantic import BaseModel

from app.schemas.job import JobRead


class ChapterThumbnailRead(BaseModel):
    chapter_id: uuid.UUID
    start_ms: int
    url: str | None


class ChapterThumbnailsRead(BaseModel):
    status: Literal["unavailable", "missing", "queued", "running", "completed", "failed"]
    thumbnails: list[ChapterThumbnailRead]
    job: JobRead | None = None

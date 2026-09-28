import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict

from app.models.job import JobStatus, JobType


class JobRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    meeting_id: uuid.UUID
    realtime_chunk_id: uuid.UUID | None
    realtime_window_start_ms: int | None
    realtime_window_end_ms: int | None
    realtime_commit_start_ms: int | None
    type: JobType
    status: JobStatus
    attempts: int
    progress: int | None
    error_message: str | None
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None

import uuid
from datetime import datetime

from pydantic import BaseModel

from app.models.realtime import RealtimeSessionStatus
from app.schemas.transcript import TranscriptSegmentRead


class RealtimeSessionRead(BaseModel):
    id: uuid.UUID
    status: RealtimeSessionStatus
    has_system_audio: bool
    transcription_provider: str
    transcription_region: str | None
    chunk_count: int
    received_bytes: int
    duration_ms: int
    started_at: datetime
    ended_at: datetime | None
    transcript_status: str
    segments: list[TranscriptSegmentRead]

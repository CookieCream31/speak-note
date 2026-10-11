import uuid
from datetime import datetime

from pydantic import BaseModel, Field

from app.models.realtime import RealtimeSessionStatus
from app.schemas.transcript import TranscriptSegmentRead
from app.schemas.translation import RealtimeTranslationRead, TranslationConfig


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
    translation: TranslationConfig | None = None
    translations: list[RealtimeTranslationRead] = Field(default_factory=list)

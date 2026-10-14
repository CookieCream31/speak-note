import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from app.models.transcript import TranscriptKind, TranscriptStatus


class SpeakerRead(BaseModel):
    id: uuid.UUID
    meeting_id: uuid.UUID
    internal_name: str
    display_name: str | None
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class SpeakerUpdate(BaseModel):
    display_name: str | None = Field(default=None, max_length=200)


class LiveSpeakerNameUpdate(SpeakerUpdate):
    segment_ids: list[uuid.UUID] = Field(min_length=1, max_length=10_000)


class TranscriptWordRead(BaseModel):
    id: uuid.UUID
    start_ms: int
    end_ms: int
    text: str
    confidence: float | None
    sequence: int
    speaker_id: uuid.UUID | None

    model_config = ConfigDict(from_attributes=True)


class TranscriptWordTiming(BaseModel):
    """Client-side confirmed token timing, without persistent IDs or speaker identity."""

    text: str = Field(min_length=1, max_length=20_000)
    start_ms: int = Field(ge=0)
    end_ms: int = Field(ge=0)
    confidence: float | None = Field(default=None, ge=0, le=1)

    model_config = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)


class TranscriptSegmentRead(BaseModel):
    id: uuid.UUID
    start_ms: int
    end_ms: int
    text: str
    confidence: float | None
    sequence: int
    speaker: SpeakerRead | None
    provisional_speaker_label: str | None
    provisional_speaker_name: str | None
    words: list[TranscriptWordRead]

    model_config = ConfigDict(from_attributes=True)


class TranscriptSegmentUpdate(BaseModel):
    text: str = Field(min_length=1)


class TranscriptVersionRead(BaseModel):
    id: uuid.UUID
    meeting_id: uuid.UUID
    version: int
    kind: TranscriptKind
    status: TranscriptStatus
    language: str
    model: str
    diarization_enabled: bool
    created_at: datetime
    segments: list[TranscriptSegmentRead]

    model_config = ConfigDict(from_attributes=True)

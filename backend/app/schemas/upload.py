import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.models.upload import MediaUploadStatus


class MediaUploadSessionCreate(BaseModel):
    filename: str = Field(min_length=1, max_length=255)
    mime_type: str = Field(min_length=1, max_length=100)
    size_bytes: int = Field(gt=0)

    @field_validator("filename", "mime_type")
    @classmethod
    def strip_value(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("value must not be blank")
        return normalized


class MediaUploadSessionRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    meeting_id: uuid.UUID
    size_bytes: int
    chunk_size_bytes: int
    chunk_count: int
    received_chunks: list[int] = Field(default_factory=list)
    status: MediaUploadStatus
    created_at: datetime
    updated_at: datetime


class MediaUploadChunkRead(BaseModel):
    upload_id: uuid.UUID
    chunk_index: int
    received_chunks: int
    chunk_count: int

from datetime import datetime
from typing import Self

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.models.transcription import RealtimeTranscriptionProvider


class RealtimeTranscriptionSettingsUpdate(BaseModel):
    provider: RealtimeTranscriptionProvider
    azure_region: str | None = Field(default=None, max_length=100)
    azure_language: str = Field(default="ja-JP", min_length=2, max_length=20)
    api_key: str | None = Field(default=None, min_length=1, max_length=1000)
    clear_api_key: bool = False

    @model_validator(mode="after")
    def normalize(self) -> Self:
        self.azure_region = self.azure_region.strip().lower() if self.azure_region else None
        self.azure_language = self.azure_language.strip()
        return self


class RealtimeTranscriptionSettingsRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    provider: RealtimeTranscriptionProvider
    azure_region: str | None
    azure_language: str
    has_api_key: bool
    api_key_masked: str | None
    updated_at: datetime


class RealtimeTranscriptionConnectionRead(BaseModel):
    success: bool
    message: str


class RealtimeTranscriptionTokenRead(BaseModel):
    token: str
    region: str
    language: str
    expires_in_seconds: int = 600

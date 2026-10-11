from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.models.transcription import AsyncTranscriptionProvider, RealtimeTranscriptionProvider


class SonioxSettingsUpdate(BaseModel):
    soniox_model: str | None = Field(default=None, min_length=1, max_length=32)
    soniox_language: str | None = Field(default=None, pattern=r"^[a-z]{2,3}$")
    soniox_api_key: str | None = Field(default=None, min_length=1, max_length=1000)
    clear_soniox_api_key: bool = False


class AsyncTranscriptionSettingsUpdate(SonioxSettingsUpdate):
    provider: AsyncTranscriptionProvider


class AsyncTranscriptionSettingsRead(BaseModel):
    provider: AsyncTranscriptionProvider
    soniox_model: str
    soniox_language: str
    has_soniox_api_key: bool
    soniox_api_key_masked: str | None
    updated_at: datetime


class RealtimeTranscriptionSettingsUpdate(SonioxSettingsUpdate):
    provider: RealtimeTranscriptionProvider
    azure_region: str | None = Field(default=None, max_length=100)
    azure_language: str = Field(default="ja-JP", min_length=2, max_length=20)
    api_key: str | None = Field(default=None, min_length=1, max_length=1000)
    clear_api_key: bool = False

    @field_validator("azure_region")
    @classmethod
    def normalize_region(cls, value: str | None) -> str | None:
        return value.strip().lower() or None if value else None

    @field_validator("azure_language")
    @classmethod
    def normalize_language(cls, value: str) -> str:
        value = value.strip()
        if len(value) < 2:
            raise ValueError("認識言語を入力してください")
        return value


class RealtimeTranscriptionSettingsRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    provider: RealtimeTranscriptionProvider
    azure_region: str | None
    azure_language: str
    has_api_key: bool
    api_key_masked: str | None
    soniox_model: str
    soniox_language: str
    has_soniox_api_key: bool
    soniox_api_key_masked: str | None
    updated_at: datetime


class RealtimeTranscriptionConnectionRead(BaseModel):
    success: bool
    message: str


class RealtimeTranscriptionTokenRead(BaseModel):
    token: str
    region: str
    language: str
    expires_in_seconds: int = 600


class SonioxRealtimeTokenRead(BaseModel):
    api_key: str
    expires_at: datetime
    model: str
    language: str

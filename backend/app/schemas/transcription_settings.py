from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, SecretStr

from app.models.transcription import AsyncTranscriptionProvider, RealtimeTranscriptionProvider


class SonioxSettingsUpdate(BaseModel):
    soniox_model: str | None = Field(default=None, min_length=1, max_length=32)
    soniox_language: str | None = Field(default=None, pattern=r"^[a-z]{2,3}$")
    soniox_api_key: str | None = Field(default=None, min_length=1, max_length=1000)
    clear_soniox_api_key: bool = False


class SonioxModelListRequest(BaseModel):
    purpose: Literal["realtime", "async"]
    soniox_api_key: SecretStr | None = Field(default=None, min_length=1, max_length=1000)


class SonioxModelRead(BaseModel):
    id: str
    name: str


class SonioxModelListRead(BaseModel):
    models: list[SonioxModelRead]


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
    model_config = ConfigDict(extra="forbid")
    provider: Literal[RealtimeTranscriptionProvider.SONIOX] = RealtimeTranscriptionProvider.SONIOX


class RealtimeTranscriptionSettingsRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    provider: Literal[RealtimeTranscriptionProvider.SONIOX]
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
    language_hints: list[str]
    language_hints_strict: bool = False
    translation: dict[str, str] | None = None

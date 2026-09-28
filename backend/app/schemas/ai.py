import uuid
from datetime import datetime
from typing import Self

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.models.ai import AIProviderType, AIUsage


class AIProviderCreate(BaseModel):
    provider_type: AIProviderType
    name: str = Field(min_length=1, max_length=200)
    base_url: str | None = Field(default=None, max_length=500)
    enabled: bool = True
    api_key: str | None = Field(default=None, min_length=1, max_length=1000)

    @model_validator(mode="after")
    def validate_provider_fields(self) -> Self:
        self.name = self.name.strip()
        if not self.name:
            raise ValueError("name must not be blank")
        if self.provider_type == AIProviderType.OLLAMA and not self.base_url:
            raise ValueError("Ollama base_url is required")
        if self.provider_type == AIProviderType.GEMINI and self.base_url:
            raise ValueError("Gemini base_url cannot be configured")
        return self


class AIProviderUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    base_url: str | None = Field(default=None, max_length=500)
    enabled: bool | None = None
    api_key: str | None = Field(default=None, min_length=1, max_length=1000)
    clear_api_key: bool = False


class AIProviderRead(BaseModel):
    id: uuid.UUID
    provider_type: AIProviderType
    name: str
    base_url: str | None
    enabled: bool
    has_api_key: bool
    api_key_masked: str | None
    created_at: datetime
    updated_at: datetime


class AIProfileCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    provider_id: uuid.UUID
    model: str = Field(min_length=1, max_length=200)
    temperature: float = Field(default=0.2, ge=0, le=2)
    is_default: bool = False


class AIProfileUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    provider_id: uuid.UUID | None = None
    model: str | None = Field(default=None, min_length=1, max_length=200)
    temperature: float | None = Field(default=None, ge=0, le=2)
    is_default: bool | None = None


class AIProfileRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    provider_id: uuid.UUID
    model: str
    temperature: float
    is_default: bool
    created_at: datetime
    updated_at: datetime


class AIUsageSettingUpdate(BaseModel):
    profile_id: uuid.UUID | None = None
    disabled: bool = False


class AIUsageSettingRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    usage: AIUsage
    profile_id: uuid.UUID | None
    disabled: bool
    updated_at: datetime


class AIConnectionTestRead(BaseModel):
    success: bool
    message: str
    models: list[str] = Field(default_factory=list)


class MeetingAISelection(BaseModel):
    mode: str = Field(pattern="^(default|profile|none)$")
    profile_id: uuid.UUID | None = None

    @model_validator(mode="after")
    def validate_selection(self) -> Self:
        if self.mode == "profile" and self.profile_id is None:
            raise ValueError("profile_id is required for profile mode")
        if self.mode != "profile" and self.profile_id is not None:
            raise ValueError("profile_id is only valid for profile mode")
        return self

import uuid
from typing import Any
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.models.meeting import MeetingSourceType, MeetingStatus
from app.schemas.tag import MeetingTagRead

MeetingSummaryFormat = Literal["standard", "concise", "detailed", "bullet"]


class MeetingBase(BaseModel):
    title: str = Field(min_length=1, max_length=200)

    @field_validator("title")
    @classmethod
    def normalize_title(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("title must not be blank")
        return normalized


class MeetingCreate(MeetingBase):
    source_type: MeetingSourceType
    project_id: uuid.UUID | None = None
    min_speakers: int | None = Field(default=None, ge=1)
    max_speakers: int | None = Field(default=None, ge=1)
    summary_format: MeetingSummaryFormat = "standard"
    template_id: uuid.UUID | None = None
    meeting_context: str | None = Field(default=None, max_length=4000)

    @field_validator("meeting_context")
    @classmethod
    def normalize_meeting_context(cls, value: str | None) -> str | None:
        normalized = value.strip() if value is not None else ""
        return normalized or None

    @model_validator(mode="after")
    def validate_speaker_bounds(self) -> "MeetingCreate":
        if (
            self.min_speakers is not None
            and self.max_speakers is not None
            and self.min_speakers > self.max_speakers
        ):
            raise ValueError("min_speakers must not exceed max_speakers")
        return self


class MeetingUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=200)
    project_id: uuid.UUID | None = None
    status: MeetingStatus | None = None
    started_at: datetime | None = None
    duration_ms: int | None = Field(default=None, ge=0)
    is_favorite: bool | None = None
    min_speakers: int | None = Field(default=None, ge=1)
    max_speakers: int | None = Field(default=None, ge=1)
    summary_format: MeetingSummaryFormat | None = None
    meeting_context: str | None = Field(default=None, max_length=4000)

    @model_validator(mode="after")
    def validate_speaker_bounds(self) -> "MeetingUpdate":
        if (
            self.min_speakers is not None
            and self.max_speakers is not None
            and self.min_speakers > self.max_speakers
        ):
            raise ValueError("min_speakers must not exceed max_speakers")
        return self

    @model_validator(mode="before")
    @classmethod
    def reject_null_required_fields(cls, value: Any) -> Any:
        if isinstance(value, dict):
            for field in ("title", "status", "is_favorite", "summary_format"):
                if field in value and value[field] is None:
                    raise ValueError(f"{field} must not be null")
        return value

    @field_validator("title")
    @classmethod
    def normalize_optional_title(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip()
        if not normalized:
            raise ValueError("title must not be blank")
        return normalized

    @field_validator("meeting_context")
    @classmethod
    def normalize_optional_meeting_context(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip()
        return normalized or None


class MeetingRead(MeetingBase):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    source_type: MeetingSourceType
    status: MeetingStatus
    created_at: datetime
    updated_at: datetime
    started_at: datetime | None
    duration_ms: int | None
    active_transcript_version_id: uuid.UUID | None
    active_analysis_version_id: uuid.UUID | None
    ai_profile_id: uuid.UUID | None
    project_id: uuid.UUID | None
    ai_disabled: bool
    is_favorite: bool
    min_speakers: int | None
    max_speakers: int | None
    summary_format: MeetingSummaryFormat
    template_id: uuid.UUID | None
    template_snapshot: dict[str, Any] | None
    meeting_context: str | None
    tags: list[MeetingTagRead] = Field(default_factory=list)


class MeetingList(BaseModel):
    items: list[MeetingRead]
    total: int
    limit: int
    offset: int


MeetingBulkAction = Literal["favorite", "unfavorite", "tag", "untag", "delete"]


class MeetingBulkActionRequest(BaseModel):
    meeting_ids: list[uuid.UUID] = Field(min_length=1, max_length=100)
    action: MeetingBulkAction
    tag_id: uuid.UUID | None = None

    @model_validator(mode="after")
    def require_tag_id_for_tag_actions(self) -> "MeetingBulkActionRequest":
        if self.action in {"tag", "untag"} and self.tag_id is None:
            raise ValueError("tag_id is required for tag actions")
        return self


class MeetingBulkActionRead(BaseModel):
    action: MeetingBulkAction
    affected: int

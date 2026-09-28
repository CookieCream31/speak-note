import uuid
from datetime import date, datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.models.analysis import AnalysisItemKind, AnalysisItemState, AnalysisStatus


class EvidenceOutput(BaseModel):
    content: str = Field(min_length=1, max_length=5000)
    evidence_segment_ids: list[uuid.UUID] = Field(min_length=1, max_length=20)


class ActionItemOutput(EvidenceOutput):
    assignee: str | None = Field(default=None, max_length=200)
    deadline: date | None = None


class ChapterOutput(BaseModel):
    title: str = Field(min_length=1, max_length=500)
    start_ms: int = Field(ge=0)
    end_ms: int = Field(ge=0)
    evidence_segment_ids: list[uuid.UUID] = Field(min_length=1, max_length=20)

    @model_validator(mode="before")
    @classmethod
    def accept_content_as_title(cls, value: object) -> object:
        if not isinstance(value, dict) or "title" in value:
            return value
        content = value.get("content")
        if not isinstance(content, str) or not content.strip():
            return value
        return {**value, "title": content}

    @model_validator(mode="after")
    def validate_range(self) -> "ChapterOutput":
        if self.end_ms < self.start_ms:
            raise ValueError("end_ms must be greater than or equal to start_ms")
        return self


class HighlightOutput(ChapterOutput):
    title: str = Field(default="重要箇所", min_length=1, max_length=500)


class StructuredChaptersOutput(BaseModel):
    chapters: list[ChapterOutput] = Field(min_length=1, max_length=100)


class TemplateValueOutput(BaseModel):
    card_id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,64}$")
    row_id: str = Field(pattern=r"^[A-Za-z0-9_:-]{1,64}$")
    field_id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,64}$")
    field_type: Literal["short_text", "long_text", "number", "date", "boolean", "single_select"]
    text_value: str | None = Field(default=None, max_length=5000)
    number_value: float | None = None
    boolean_value: bool | None = None
    evidence_segment_ids: list[uuid.UUID] = Field(default_factory=list, max_length=20)

    @model_validator(mode="after")
    def validate_typed_value(self) -> "TemplateValueOutput":
        if self.field_type in {"short_text", "long_text", "date", "single_select"}:
            if self.number_value is not None or self.boolean_value is not None:
                raise ValueError("typed value does not match field_type")
            if (
                self.field_type == "short_text"
                and self.text_value is not None
                and len(self.text_value) > 500
            ):
                raise ValueError("short_text is too long")
        elif self.field_type == "number":
            if self.text_value is not None or self.boolean_value is not None:
                raise ValueError("typed value does not match field_type")
        elif self.field_type == "boolean":
            if self.text_value is not None or self.number_value is not None:
                raise ValueError("typed value does not match field_type")
        return self

    @property
    def value(self) -> str | float | bool | None:
        if self.field_type == "number":
            return self.number_value
        if self.field_type == "boolean":
            return self.boolean_value
        return self.text_value


class StructuredMinutesOutput(BaseModel):
    summary: str = Field(min_length=1, max_length=20000)
    summary_evidence_segment_ids: list[uuid.UUID] = Field(min_length=1, max_length=50)
    decisions: list[EvidenceOutput] = Field(default_factory=list, max_length=100)
    action_items: list[ActionItemOutput] = Field(default_factory=list, max_length=100)
    open_questions: list[EvidenceOutput] = Field(default_factory=list, max_length=100)
    important_points: list[EvidenceOutput] = Field(default_factory=list, max_length=100)
    chapters: list[ChapterOutput] = Field(default_factory=list, max_length=100)
    suggested_questions: list[EvidenceOutput] = Field(default_factory=list, max_length=100)
    highlights: list[HighlightOutput] = Field(default_factory=list, max_length=100)
    template_values: list[TemplateValueOutput] = Field(default_factory=list, max_length=500)


class AnalysisEvidenceRead(BaseModel):
    segment_id: uuid.UUID

    model_config = ConfigDict(from_attributes=True)


class AnalysisItemRead(BaseModel):
    id: uuid.UUID
    kind: AnalysisItemKind
    state: AnalysisItemState
    content: str
    assignee: str | None
    deadline: date | None
    start_ms: int | None
    end_ms: int | None
    sequence: int
    evidence: list[AnalysisEvidenceRead]
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class AnalysisVersionRead(BaseModel):
    id: uuid.UUID
    meeting_id: uuid.UUID
    transcript_version_id: uuid.UUID
    provider_id: uuid.UUID | None
    profile_id: uuid.UUID | None
    job_id: uuid.UUID | None
    version: int
    model: str
    temperature: float
    prompt_version: str
    status: AnalysisStatus
    error_message: str | None
    created_at: datetime
    completed_at: datetime | None
    template_snapshot: dict[str, Any] | None = None
    template_values: list[dict[str, Any]] = Field(default_factory=list)
    items: list[AnalysisItemRead]

    model_config = ConfigDict(from_attributes=True)


class AnalysisVersionSummaryRead(BaseModel):
    id: uuid.UUID
    version: int
    model: str
    status: AnalysisStatus
    created_at: datetime
    completed_at: datetime | None

    model_config = ConfigDict(from_attributes=True)


class AnalysisGenerateRequest(BaseModel):
    profile_id: uuid.UUID | None = None
    template_id: uuid.UUID | None = None
    template_revision: int | None = Field(default=None, ge=1)
    request_id: uuid.UUID | None = None

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def validate_template_revision(self) -> "AnalysisGenerateRequest":
        if self.template_revision is not None and self.template_id is None:
            raise ValueError("template_revision requires template_id")
        return self


class AnalysisGenerateRead(BaseModel):
    analysis: AnalysisVersionSummaryRead | None
    job_id: uuid.UUID


class ManualAnalysisPromptRead(BaseModel):
    transcript_version_id: uuid.UUID
    prompt_version: str
    filename: str
    prompt: str


class ManualAnalysisImportRequest(BaseModel):
    transcript_version_id: uuid.UUID
    response_text: str = Field(min_length=2, max_length=5_000_000)


class ManualChapterPreviewRead(BaseModel):
    title: str
    start_ms: int
    end_ms: int


class ManualAnalysisPreviewRead(BaseModel):
    transcript_version_id: uuid.UUID
    summary: str
    item_counts: dict[str, int]
    chapters: list[ManualChapterPreviewRead]


class AnalysisItemUpdate(BaseModel):
    content: str | None = Field(default=None, min_length=1, max_length=20000)
    assignee: str | None = Field(default=None, max_length=200)
    deadline: date | None = None
    state: AnalysisItemState | None = None


class BookmarkCreate(BaseModel):
    timestamp_ms: int = Field(ge=0)
    title: str = Field(min_length=1, max_length=200)
    note: str | None = Field(default=None, max_length=5000)


class BookmarkUpdate(BaseModel):
    timestamp_ms: int | None = Field(default=None, ge=0)
    title: str | None = Field(default=None, min_length=1, max_length=200)
    note: str | None = Field(default=None, max_length=5000)


class BookmarkRead(BaseModel):
    id: uuid.UUID
    meeting_id: uuid.UUID
    timestamp_ms: int
    title: str
    note: str | None
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class TranscriptSearchResultRead(BaseModel):
    segment_id: uuid.UUID
    start_ms: int
    end_ms: int
    text: str
    speaker_id: uuid.UUID | None
    speaker_name: str


class TimelineMarkerRead(BaseModel):
    id: uuid.UUID
    kind: str
    timestamp_ms: int
    end_ms: int | None
    title: str

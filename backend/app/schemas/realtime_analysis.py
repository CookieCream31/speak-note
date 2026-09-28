import uuid
from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, Field

from app.models.realtime_analysis import RealtimeAnalysisStatus
from app.schemas.analysis import TemplateValueOutput


class RealtimeSummaryOutput(BaseModel):
    content: str = Field(min_length=1, max_length=20_000)
    evidence_segment_ids: list[uuid.UUID] = Field(min_length=1, max_length=50)


class RealtimeDecisionOutput(BaseModel):
    content: str = Field(min_length=1, max_length=5_000)
    status: Literal["candidate", "explicit"] = "explicit"
    evidence_segment_ids: list[uuid.UUID] = Field(min_length=1, max_length=20)


class RealtimeActionItemOutput(BaseModel):
    content: str = Field(min_length=1, max_length=5_000)
    assignee: str | None = Field(default=None, max_length=200)
    deadline: date | None = None
    status: Literal["open", "done"] = "open"
    evidence_segment_ids: list[uuid.UUID] = Field(min_length=1, max_length=20)


class RealtimeAttentionItemOutput(BaseModel):
    type: Literal["unresolved", "missing_information", "possible_contradiction", "risk"]
    title: str = Field(min_length=1, max_length=500)
    known_information: str = Field(min_length=1, max_length=5_000)
    information_needed: str | None = Field(default=None, max_length=5_000)
    reason: str = Field(min_length=1, max_length=5_000)
    evidence_segment_ids: list[uuid.UUID] = Field(min_length=1, max_length=20)


class RealtimeKeyFactOutput(BaseModel):
    label: str = Field(min_length=1, max_length=500)
    value: str = Field(min_length=1, max_length=5_000)
    evidence_segment_ids: list[uuid.UUID] = Field(min_length=1, max_length=20)


class RealtimeSupersededItemOutput(BaseModel):
    index: int = Field(ge=0)
    evidence_segment_ids: list[uuid.UUID] = Field(min_length=1, max_length=20)


class RealtimeSupersededOutput(BaseModel):
    summary_sentences: list[RealtimeSupersededItemOutput] = Field(
        default_factory=list, max_length=100
    )
    decisions: list[RealtimeSupersededItemOutput] = Field(default_factory=list, max_length=50)
    action_items: list[RealtimeSupersededItemOutput] = Field(default_factory=list, max_length=50)
    attention_items: list[RealtimeSupersededItemOutput] = Field(default_factory=list, max_length=50)
    key_facts: list[RealtimeSupersededItemOutput] = Field(default_factory=list, max_length=100)


class RealtimeAnalysisOutput(BaseModel):
    input_revision: int = Field(ge=1)
    as_of_ms: int = Field(ge=0)
    summary: RealtimeSummaryOutput
    decisions: list[RealtimeDecisionOutput] = Field(default_factory=list, max_length=50)
    action_items: list[RealtimeActionItemOutput] = Field(default_factory=list, max_length=50)
    attention_items: list[RealtimeAttentionItemOutput] = Field(default_factory=list, max_length=50)
    superseded: RealtimeSupersededOutput = Field(
        default_factory=RealtimeSupersededOutput,
        exclude=True,
    )
    key_facts: list[RealtimeKeyFactOutput] = Field(default_factory=list, max_length=100)
    template_values: list[TemplateValueOutput] = Field(default_factory=list, max_length=500)


class RealtimeEvidenceRead(BaseModel):
    evidence_id: uuid.UUID
    segment_id: uuid.UUID
    start_ms: int
    end_ms: int
    status: Literal["draft", "confirmed"]


class RealtimeAnalysisRead(BaseModel):
    status: RealtimeAnalysisStatus
    input_revision: int
    processed_revision: int
    analyzed_through_ms: int
    model: str | None
    error_message: str | None
    updated_at: datetime
    completed_at: datetime | None
    snapshot: RealtimeAnalysisOutput | None
    evidence: list[RealtimeEvidenceRead]

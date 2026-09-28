import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.models.question import MeetingQuestionStatus


class MeetingAnswerOutput(BaseModel):
    answer: str = Field(min_length=1, max_length=20_000)
    evidence_segment_ids: list[uuid.UUID] = Field(default_factory=list, max_length=20)
    insufficient_information: bool = False

    @model_validator(mode="after")
    def require_evidence_for_supported_answer(self) -> "MeetingAnswerOutput":
        if self.insufficient_information and self.evidence_segment_ids:
            raise ValueError("情報不足の回答にはEvidenceを指定できません")
        if not self.insufficient_information and not self.evidence_segment_ids:
            raise ValueError("回答には根拠となるEvidenceが必要です")
        return self


class MeetingQuestionCreate(BaseModel):
    question: str = Field(min_length=1, max_length=2_000)


class MeetingQuestionEvidenceRead(BaseModel):
    segment_id: uuid.UUID

    model_config = ConfigDict(from_attributes=True)


class MeetingQuestionRead(BaseModel):
    id: uuid.UUID
    meeting_id: uuid.UUID
    transcript_version_id: uuid.UUID
    provider_id: uuid.UUID | None
    profile_id: uuid.UUID | None
    job_id: uuid.UUID | None
    question: str
    answer: str | None
    insufficient_information: bool
    model: str
    status: MeetingQuestionStatus
    error_message: str | None
    created_at: datetime
    completed_at: datetime | None
    evidence: list[MeetingQuestionEvidenceRead]

    model_config = ConfigDict(from_attributes=True)

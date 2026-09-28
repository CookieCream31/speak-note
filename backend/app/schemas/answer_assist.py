import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class AssistStart(BaseModel):
    profile_id: uuid.UUID
    consent: Literal[True]


class AssistRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    meeting_id: uuid.UUID
    capture_id: uuid.UUID
    enabled: bool
    profile_id: uuid.UUID | None
    configuration: dict[str, Any]
    knowledge_snapshot: dict[str, Any]
    consented_at: datetime


class AnswerRequest(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    session_id: uuid.UUID
    request_id: uuid.UUID
    question: str = Field(min_length=1, max_length=2000)
    brevity: Literal["standard", "brief"] = "standard"


class AnswerOutput(BaseModel):
    short_answer: str = Field(min_length=1, max_length=2000)
    detailed_answer: str = Field(min_length=1, max_length=8000)
    insufficient_information: bool = False
    source_ids: list[str] = Field(default_factory=list, max_length=20)


class AnswerRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    session_id: uuid.UUID
    sequence: int
    question: str
    status: str
    short_answer: str | None
    detailed_answer: str | None
    insufficient_information: bool
    source_ids: list[str]
    input_snapshot: dict[str, Any]
    error_message: str | None
    created_at: datetime


class MonitorSettings(BaseModel):
    enabled: bool
    target_speaker: str | None = Field(default=None, max_length=100)

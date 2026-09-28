from typing import Any

from pydantic import BaseModel, ConfigDict, Field, model_validator


class WhisperXWord(BaseModel):
    word: str
    start: float | None = Field(default=None, ge=0)
    end: float | None = Field(default=None, ge=0)
    speaker: str | None = None
    score: float | None = None

    model_config = ConfigDict(extra="allow")


class WhisperXSegment(BaseModel):
    start: float = Field(ge=0)
    end: float = Field(ge=0)
    text: str
    speaker: str | None = None
    confidence: float | None = None
    score: float | None = None
    words: list[WhisperXWord] = Field(default_factory=list)

    model_config = ConfigDict(extra="allow")


class WhisperXResult(BaseModel):
    segments: list[WhisperXSegment]
    raw_response: dict[str, Any]

    @model_validator(mode="before")
    @classmethod
    def normalize_response(cls, value: Any) -> Any:
        if not isinstance(value, dict):
            return value
        raw = dict(value)
        segments = raw.get("segments")
        if isinstance(segments, dict):
            segments = segments.get("segments", [])
        return {"segments": segments or [], "raw_response": raw}

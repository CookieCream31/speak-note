import uuid
from datetime import datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

LanguageCode = Annotated[str, Field(pattern=r"^[a-z]{2,3}$")]


class OneWayTranslation(BaseModel):
    model_config = ConfigDict(extra="forbid")
    type: Literal["one_way"]
    target_language: LanguageCode


class TwoWayTranslation(BaseModel):
    model_config = ConfigDict(extra="forbid")
    type: Literal["two_way"]
    language_a: LanguageCode
    language_b: LanguageCode

    @model_validator(mode="after")
    def distinct_languages(self) -> "TwoWayTranslation":
        if self.language_a == self.language_b:
            raise ValueError("双方向翻訳では異なる2つの言語を選んでください")
        return self


TranslationConfig = Annotated[OneWayTranslation | TwoWayTranslation, Field(discriminator="type")]


def parse_translation_config(value: dict[str, Any]) -> OneWayTranslation | TwoWayTranslation:
    if value.get("type") == "one_way":
        return OneWayTranslation.model_validate(value)
    if value.get("type") == "two_way":
        return TwoWayTranslation.model_validate(value)
    raise ValueError("翻訳方法が不正です")


class StreamingTranslation(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    result_id: str = Field(min_length=1, max_length=200)
    text: str = Field(min_length=1, max_length=20_000)
    source_language: LanguageCode
    target_language: LanguageCode
    speaker_label: str | None = Field(default=None, max_length=100)


class RealtimeTranslationRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    result_id: str
    sequence: int
    text: str
    source_language: str
    target_language: str
    speaker_label: str | None
    created_at: datetime

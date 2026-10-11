from typing import Annotated

from pydantic import BaseModel, Field

LanguageHints = Annotated[
    list[Annotated[str, Field(pattern=r"^[a-z]{2,3}$")]], Field(max_length=64)
]


def validate_language_hints(value: list[str] | None) -> list[str] | None:
    if value is not None and len(set(value)) != len(value):
        raise ValueError("同じ言語を複数回指定できません")
    return value


class TranscriptionLanguageOptionsRead(BaseModel):
    languages: list[str]
    supports_auto: bool
    supports_multiple: bool
    supports_strict: bool
    providers: list[str]

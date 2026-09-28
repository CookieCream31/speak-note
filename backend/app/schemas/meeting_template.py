import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

FieldType = Literal["short_text", "long_text", "number", "date", "boolean", "single_select"]


class TemplateField(BaseModel):
    id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,64}$")
    name: str = Field(min_length=1, max_length=100)
    type: FieldType
    options: list[str] = Field(default_factory=list, max_length=50)
    required: bool = False

    @field_validator("name")
    @classmethod
    def normalize_name(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("field name must not be blank")
        return value

    @model_validator(mode="after")
    def validate_options(self) -> "TemplateField":
        if self.type == "single_select":
            if not self.options or any(not option.strip() for option in self.options):
                raise ValueError("single_select requires non-blank options")
            if len({option.strip() for option in self.options}) != len(self.options):
                raise ValueError("single_select options must be unique")
        elif self.options:
            raise ValueError("options are only allowed for single_select")
        return self


class TemplateCard(BaseModel):
    id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,64}$")
    title: str = Field(min_length=1, max_length=100)
    visible: bool = True
    show_when_empty: bool = False
    instructions: str = Field(default="", max_length=2000)
    core_kind: (
        Literal[
            "summary",
            "decision",
            "action_item",
            "open_question",
            "important_point",
            "chapter",
            "suggested_question",
            "highlight",
        ]
        | None
    ) = None
    fields: list[TemplateField] = Field(default_factory=list, max_length=30)

    @field_validator("title")
    @classmethod
    def normalize_title(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("card title must not be blank")
        return value

    @model_validator(mode="after")
    def validate_field_ids(self) -> "TemplateCard":
        ids = [field.id for field in self.fields]
        if len(ids) != len(set(ids)):
            raise ValueError("field IDs must be unique within a card")
        return self


class TemplateDefinition(BaseModel):
    realtime: list[TemplateCard] = Field(default_factory=list, max_length=30)
    final: list[TemplateCard] = Field(default_factory=list, max_length=30)

    @model_validator(mode="after")
    def validate_ids(self) -> "TemplateDefinition":
        for cards in (self.realtime, self.final):
            ids = [card.id for card in cards]
            if len(ids) != len(set(ids)):
                raise ValueError("card IDs must be unique within a view")
        realtime_supported = {
            "summary",
            "decision",
            "action_item",
            "open_question",
            "important_point",
        }
        if any(
            card.core_kind is not None and card.core_kind not in realtime_supported
            for card in self.realtime
        ):
            raise ValueError("Realtime cards use an unsupported core_kind")
        return self


class MeetingTemplateCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    definition: TemplateDefinition
    is_default: bool = False

    @field_validator("name")
    @classmethod
    def normalize_name(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("template name must not be blank")
        return value


class MeetingTemplateUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    expected_revision: int | None = Field(default=None, ge=1)
    definition: TemplateDefinition | None = None
    is_default: bool | None = None

    @model_validator(mode="before")
    @classmethod
    def reject_null_updates(cls, value: Any) -> Any:
        if isinstance(value, dict):
            for field in ("name", "definition", "is_default", "expected_revision"):
                if field in value and value[field] is None:
                    raise ValueError(f"{field} must not be null")
        return value


class MeetingTemplateRead(BaseModel):
    id: uuid.UUID
    name: str
    definition: TemplateDefinition
    revision: int
    is_default: bool
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)

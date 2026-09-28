import enum
import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    Enum,
    Float,
    ForeignKey,
    Index,
    String,
    Text,
    Uuid,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.models.meeting import utc_now

if TYPE_CHECKING:
    from app.models.meeting import Meeting


class AIProviderType(enum.StrEnum):
    OLLAMA = "ollama"
    GEMINI = "gemini"


class AIUsage(enum.StrEnum):
    REALTIME_ANALYSIS = "realtime_analysis"
    FINAL_MINUTES = "final_minutes"
    SUGGESTED_QUESTIONS = "suggested_questions"
    CHAPTERS = "chapters"


class AIProviderConfig(Base):
    __tablename__ = "ai_provider_configs"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    provider_type: Mapped[AIProviderType] = mapped_column(
        Enum(
            AIProviderType,
            name="ai_provider_type",
            values_callable=lambda values: [value.value for value in values],
        ),
        index=True,
    )
    name: Mapped[str] = mapped_column(String(200), unique=True)
    base_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    encrypted_api_key: Mapped[str | None] = mapped_column(Text, nullable=True)
    api_key_hint: Mapped[str | None] = mapped_column(String(20), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now, onupdate=utc_now
    )

    profiles: Mapped[list["AIProfile"]] = relationship(back_populates="provider")


class AIProfile(Base):
    __tablename__ = "ai_profiles"
    __table_args__ = (
        CheckConstraint("temperature >= 0 AND temperature <= 2", name="ck_ai_profile_temp"),
        Index(
            "uq_ai_profiles_single_default",
            "is_default",
            unique=True,
            postgresql_where=text("is_default"),
            sqlite_where=text("is_default = 1"),
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(200), unique=True)
    provider_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("ai_provider_configs.id", ondelete="RESTRICT"), index=True
    )
    model: Mapped[str] = mapped_column(String(200))
    temperature: Mapped[float] = mapped_column(Float, default=0.2)
    is_default: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now, onupdate=utc_now
    )

    provider: Mapped[AIProviderConfig] = relationship(back_populates="profiles")
    meetings: Mapped[list["Meeting"]] = relationship(back_populates="ai_profile")
    usage_settings: Mapped[list["AIUsageSetting"]] = relationship(back_populates="profile")


class AIUsageSetting(Base):
    __tablename__ = "ai_usage_settings"

    usage: Mapped[AIUsage] = mapped_column(
        Enum(
            AIUsage,
            name="ai_usage",
            values_callable=lambda values: [value.value for value in values],
        ),
        primary_key=True,
    )
    profile_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("ai_profiles.id", ondelete="SET NULL"), nullable=True
    )
    disabled: Mapped[bool] = mapped_column(Boolean, default=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now, onupdate=utc_now
    )

    profile: Mapped[AIProfile | None] = relationship(back_populates="usage_settings")

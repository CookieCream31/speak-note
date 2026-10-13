import enum
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.models.meeting import utc_now


class RealtimeTranscriptionProvider(enum.StrEnum):
    WHISPERX = "whisperx"
    AZURE_SPEECH = "azure_speech"
    SONIOX = "soniox"


class AsyncTranscriptionProvider(enum.StrEnum):
    WHISPERX = "whisperx"
    SONIOX = "soniox"


class RealtimeTranscriptionSettings(Base):
    __tablename__ = "realtime_transcription_settings"
    __table_args__ = (
        CheckConstraint("id = 1", name="ck_realtime_transcription_settings_singleton"),
        CheckConstraint(
            "provider IN ('whisperx', 'azure_speech', 'soniox')",
            name="ck_realtime_transcription_settings_provider",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, default=1)
    provider: Mapped[str] = mapped_column(String(20), default="soniox")
    azure_region: Mapped[str | None] = mapped_column(String(100), nullable=True)
    azure_language: Mapped[str] = mapped_column(String(20), default="ja-JP")
    encrypted_api_key: Mapped[str | None] = mapped_column(Text, nullable=True)
    api_key_hint: Mapped[str | None] = mapped_column(String(20), nullable=True)
    soniox_model: Mapped[str] = mapped_column(String(32), default="stt-rt-v5")
    soniox_language: Mapped[str] = mapped_column(String(20), default="ja")
    soniox_encrypted_api_key: Mapped[str | None] = mapped_column(Text, nullable=True)
    soniox_api_key_hint: Mapped[str | None] = mapped_column(String(20), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now, onupdate=utc_now
    )


class AsyncTranscriptionSettings(Base):
    __tablename__ = "async_transcription_settings"
    __table_args__ = (
        CheckConstraint("id = 1", name="ck_async_transcription_settings_singleton"),
        CheckConstraint(
            "provider IN ('whisperx', 'soniox')", name="ck_async_transcription_settings_provider"
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, default=1)
    provider: Mapped[str] = mapped_column(String(20), default="whisperx")
    soniox_model: Mapped[str] = mapped_column(String(32), default="stt-async-v5")
    soniox_language: Mapped[str] = mapped_column(String(20), default="ja")
    soniox_encrypted_api_key: Mapped[str | None] = mapped_column(Text, nullable=True)
    soniox_api_key_hint: Mapped[str | None] = mapped_column(String(20), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now, onupdate=utc_now
    )

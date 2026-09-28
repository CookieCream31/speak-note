import enum
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.models.meeting import utc_now


class RealtimeTranscriptionProvider(enum.StrEnum):
    WHISPERX = "whisperx"
    AZURE_SPEECH = "azure_speech"


class RealtimeTranscriptionSettings(Base):
    __tablename__ = "realtime_transcription_settings"
    __table_args__ = (
        CheckConstraint("id = 1", name="ck_realtime_transcription_settings_singleton"),
        CheckConstraint(
            "provider IN (\047whisperx\047, \047azure_speech\047)",
            name="ck_realtime_transcription_settings_provider",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, default=1)
    provider: Mapped[str] = mapped_column(String(20), default="whisperx")
    azure_region: Mapped[str | None] = mapped_column(String(100), nullable=True)
    azure_language: Mapped[str] = mapped_column(String(20), default="ja-JP")
    encrypted_api_key: Mapped[str | None] = mapped_column(Text, nullable=True)
    api_key_hint: Mapped[str | None] = mapped_column(String(20), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now, onupdate=utc_now
    )

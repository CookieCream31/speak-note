import enum
import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    DateTime,
    Enum,
    ForeignKey,
    String,
    UniqueConstraint,
    Uuid,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.models.meeting import utc_now

if TYPE_CHECKING:
    from app.models.meeting import Meeting


class MediaKind(enum.StrEnum):
    ORIGINAL_VIDEO = "original_video"
    ORIGINAL_AUDIO = "original_audio"
    PLAYBACK_VIDEO = "playback_video"
    TRANSCRIPTION_AUDIO = "transcription_audio"


class Media(Base):
    __tablename__ = "media"
    __table_args__ = (
        CheckConstraint("size_bytes >= 0", name="ck_media_size_bytes"),
        CheckConstraint("duration_ms IS NULL OR duration_ms >= 0", name="ck_media_duration_ms"),
        UniqueConstraint("meeting_id", "kind", name="uq_media_meeting_kind"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    meeting_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("meetings.id", ondelete="CASCADE"), index=True
    )
    kind: Mapped[MediaKind] = mapped_column(
        Enum(MediaKind, name="media_kind", values_callable=lambda x: [e.value for e in x])
    )
    storage_path: Mapped[str] = mapped_column(String(500), unique=True)
    mime_type: Mapped[str] = mapped_column(String(100))
    size_bytes: Mapped[int] = mapped_column(BigInteger)
    duration_ms: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)

    meeting: Mapped["Meeting"] = relationship(back_populates="media")

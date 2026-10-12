import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, UniqueConstraint, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.models.meeting import utc_now


class RealtimeTranslation(Base):
    """Translated captions have no audio timestamps and are never transcript evidence."""

    __tablename__ = "realtime_translations"
    __table_args__ = (
        UniqueConstraint("session_id", "result_id", name="uq_live_translation_result"),
        UniqueConstraint("session_id", "sequence", name="uq_live_translation_sequence"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True)
    session_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("realtime_sessions.id", ondelete="CASCADE"), index=True
    )
    result_id: Mapped[str] = mapped_column(String(200))
    sequence: Mapped[int] = mapped_column(Integer)
    text: Mapped[str] = mapped_column(Text)
    source_language: Mapped[str] = mapped_column(String(3))
    target_language: Mapped[str] = mapped_column(String(3))
    speaker_label: Mapped[str | None] = mapped_column(String(100), nullable=True)
    source_result_id: Mapped[str | None] = mapped_column(String(200), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)

    @property
    def source_segment_id(self) -> uuid.UUID | None:
        """Session-scoped display anchor, not translation timing or AI evidence."""
        if self.source_result_id is None:
            return None
        return uuid.uuid5(self.session_id, f"soniox:{self.source_result_id}")

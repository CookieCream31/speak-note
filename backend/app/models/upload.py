import enum
import uuid
from datetime import UTC, datetime
from typing import TYPE_CHECKING

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    DateTime,
    Enum,
    ForeignKey,
    Integer,
    String,
    Uuid,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base

if TYPE_CHECKING:
    from app.models.meeting import Meeting


def utc_now() -> datetime:
    return datetime.now(UTC)


class MediaUploadStatus(enum.StrEnum):
    UPLOADING = "uploading"
    COMPLETED = "completed"


class MediaUploadSession(Base):
    __tablename__ = "media_upload_sessions"
    __table_args__ = (
        CheckConstraint("size_bytes > 0", name="ck_media_upload_size_bytes"),
        CheckConstraint("chunk_size_bytes > 0", name="ck_media_upload_chunk_size_bytes"),
        CheckConstraint("chunk_count > 0", name="ck_media_upload_chunk_count"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    meeting_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("meetings.id", ondelete="CASCADE"), index=True
    )
    media_id: Mapped[uuid.UUID] = mapped_column(Uuid, unique=True, default=uuid.uuid4)
    job_id: Mapped[uuid.UUID] = mapped_column(Uuid, unique=True, default=uuid.uuid4)
    filename_suffix: Mapped[str] = mapped_column(String(16))
    mime_type: Mapped[str] = mapped_column(String(100))
    size_bytes: Mapped[int] = mapped_column(BigInteger)
    chunk_size_bytes: Mapped[int] = mapped_column(BigInteger)
    chunk_count: Mapped[int] = mapped_column(Integer)
    status: Mapped[MediaUploadStatus] = mapped_column(
        Enum(
            MediaUploadStatus,
            name="media_upload_status",
            values_callable=lambda values: [value.value for value in values],
        ),
        default=MediaUploadStatus.UPLOADING,
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now, onupdate=utc_now
    )

    meeting: Mapped["Meeting"] = relationship(back_populates="upload_sessions")

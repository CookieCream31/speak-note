import uuid
from datetime import UTC, datetime
from typing import TYPE_CHECKING

from sqlalchemy import Column, DateTime, ForeignKey, Index, String, Table, Uuid
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base

if TYPE_CHECKING:
    from app.models.meeting import Meeting


def utc_now() -> datetime:
    return datetime.now(UTC)


meeting_tag_assignments = Table(
    "meeting_tag_assignments",
    Base.metadata,
    Column(
        "meeting_id",
        Uuid,
        ForeignKey("meetings.id", ondelete="CASCADE"),
        primary_key=True,
    ),
    Column(
        "tag_id",
        Uuid,
        ForeignKey("meeting_tags.id", ondelete="CASCADE"),
        primary_key=True,
    ),
    Index("ix_meeting_tag_assignments_tag_id", "tag_id"),
)


class MeetingTag(Base):
    __tablename__ = "meeting_tags"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(50), unique=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now, onupdate=utc_now
    )

    meetings: Mapped[list["Meeting"]] = relationship(
        secondary=meeting_tag_assignments,
        back_populates="tags",
        passive_deletes=True,
    )

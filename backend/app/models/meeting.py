import enum
import uuid
from datetime import UTC, datetime
from typing import TYPE_CHECKING

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    Enum,
    ForeignKey,
    Integer,
    JSON,
    String,
    Text,
    Uuid,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.models.tag import MeetingTag, meeting_tag_assignments
from app.models.upload import MediaUploadSession

if TYPE_CHECKING:
    from app.models.ai import AIProfile
    from app.models.job import Job
    from app.models.media import Media
    from app.models.speaker import Speaker
    from app.models.transcript import TranscriptVersion


class MeetingSourceType(enum.StrEnum):
    LIVE = "live"
    AUDIO_RECORDING = "audio_recording"
    MEDIA_UPLOAD = "media_upload"
    VIDEO_UPLOAD = "video_upload"
    AUDIO_UPLOAD = "audio_upload"


class MeetingStatus(enum.StrEnum):
    CREATED = "created"
    RECORDING = "recording"
    UPLOADING = "uploading"
    PREPROCESSING = "preprocessing"
    QUEUED = "queued"
    TRANSCRIBING = "transcribing"
    ANALYZING = "analyzing"
    COMPLETED = "completed"
    FAILED = "failed"


def utc_now() -> datetime:
    return datetime.now(UTC)


class Meeting(Base):
    __tablename__ = "meetings"
    __table_args__ = (
        CheckConstraint("duration_ms IS NULL OR duration_ms >= 0", name="ck_meeting_duration_ms"),
        CheckConstraint(
            "min_speakers IS NULL OR min_speakers >= 1",
            name="ck_meeting_min_speakers",
        ),
        CheckConstraint(
            "max_speakers IS NULL OR max_speakers >= 1",
            name="ck_meeting_max_speakers",
        ),
        CheckConstraint(
            "min_speakers IS NULL OR max_speakers IS NULL OR min_speakers <= max_speakers",
            name="ck_meeting_speaker_bounds",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    title: Mapped[str] = mapped_column(String(200))
    source_type: Mapped[MeetingSourceType] = mapped_column(
        Enum(
            MeetingSourceType,
            name="meeting_source_type",
            values_callable=lambda values: [value.value for value in values],
        )
    )
    status: Mapped[MeetingStatus] = mapped_column(
        Enum(
            MeetingStatus,
            name="meeting_status",
            values_callable=lambda values: [value.value for value in values],
        ),
        default=MeetingStatus.CREATED,
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now, onupdate=utc_now
    )
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    duration_ms: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    active_transcript_version_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True)
    active_analysis_version_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True)
    ai_profile_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid,
        ForeignKey("ai_profiles.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    project_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("projects.id", ondelete="SET NULL"), nullable=True, index=True
    )
    ai_disabled: Mapped[bool] = mapped_column(Boolean, default=False)
    is_favorite: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    min_speakers: Mapped[int | None] = mapped_column(Integer, nullable=True)
    max_speakers: Mapped[int | None] = mapped_column(Integer, nullable=True)
    summary_format: Mapped[str] = mapped_column(String(20), default="standard")
    template_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("meeting_templates.id", ondelete="SET NULL"), nullable=True, index=True
    )
    template_snapshot: Mapped[dict | None] = mapped_column(JSON().with_variant(JSONB, "postgresql"), nullable=True)
    meeting_context: Mapped[str | None] = mapped_column(Text, nullable=True)

    ai_profile: Mapped["AIProfile | None"] = relationship(back_populates="meetings")
    jobs: Mapped[list["Job"]] = relationship(
        back_populates="meeting", cascade="all, delete-orphan", passive_deletes=True
    )
    media: Mapped[list["Media"]] = relationship(
        back_populates="meeting", cascade="all, delete-orphan", passive_deletes=True
    )
    speakers: Mapped[list["Speaker"]] = relationship(
        back_populates="meeting", cascade="all, delete-orphan", passive_deletes=True
    )
    transcript_versions: Mapped[list["TranscriptVersion"]] = relationship(
        back_populates="meeting", cascade="all, delete-orphan", passive_deletes=True
    )
    tags: Mapped[list[MeetingTag]] = relationship(
        secondary=meeting_tag_assignments,
        back_populates="meetings",
        order_by=lambda: MeetingTag.name,
        lazy="selectin",
        passive_deletes=True,
    )
    upload_sessions: Mapped[list[MediaUploadSession]] = relationship(
        back_populates="meeting", cascade="all, delete-orphan", passive_deletes=True
    )

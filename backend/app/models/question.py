import enum
import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, Enum, ForeignKey, Index, String, Text, Uuid
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.models.meeting import utc_now


class MeetingQuestionStatus(enum.StrEnum):
    QUEUED = "queued"
    PROCESSING = "processing"
    COMPLETED = "completed"
    FAILED = "failed"


class MeetingQuestion(Base):
    __tablename__ = "meeting_questions"
    __table_args__ = (
        Index("ix_meeting_questions_meeting_created", "meeting_id", "created_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    meeting_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("meetings.id", ondelete="CASCADE"), index=True
    )
    transcript_version_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("transcript_versions.id", ondelete="CASCADE"), index=True
    )
    provider_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("ai_provider_configs.id", ondelete="SET NULL"), nullable=True
    )
    profile_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("ai_profiles.id", ondelete="SET NULL"), nullable=True
    )
    job_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("jobs.id", ondelete="SET NULL"), nullable=True, unique=True
    )
    question: Mapped[str] = mapped_column(Text)
    answer: Mapped[str | None] = mapped_column(Text, nullable=True)
    insufficient_information: Mapped[bool] = mapped_column(Boolean, default=False)
    model: Mapped[str] = mapped_column(String(200))
    status: Mapped[MeetingQuestionStatus] = mapped_column(
        Enum(
            MeetingQuestionStatus,
            name="meeting_question_status",
            values_callable=lambda values: [value.value for value in values],
        ),
        default=MeetingQuestionStatus.QUEUED,
    )
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    evidence: Mapped[list["MeetingQuestionEvidence"]] = relationship(
        back_populates="meeting_question",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )


class MeetingQuestionEvidence(Base):
    __tablename__ = "meeting_question_evidence"

    meeting_question_id: Mapped[uuid.UUID] = mapped_column(
        Uuid,
        ForeignKey("meeting_questions.id", ondelete="CASCADE"),
        primary_key=True,
    )
    segment_id: Mapped[uuid.UUID] = mapped_column(
        Uuid,
        ForeignKey("transcript_segments.id", ondelete="CASCADE"),
        primary_key=True,
    )

    meeting_question: Mapped[MeetingQuestion] = relationship(back_populates="evidence")

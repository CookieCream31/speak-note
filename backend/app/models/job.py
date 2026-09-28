import enum
import uuid
from datetime import datetime
from typing import TYPE_CHECKING, Any

from sqlalchemy import (
    JSON,
    BigInteger,
    CheckConstraint,
    DateTime,
    Enum,
    ForeignKey,
    Index,
    Integer,
    Text,
    UniqueConstraint,
    Uuid,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.models.meeting import utc_now

if TYPE_CHECKING:
    from app.models.meeting import Meeting


class JobType(enum.StrEnum):
    PREPROCESS_MEDIA = "preprocess_media"
    TRANSCRIBE = "transcribe"
    TRANSCRIBE_LIVE = "transcribe_live"
    ANALYZE_REALTIME = "analyze_realtime"
    ANALYZE = "analyze"
    ASK_MEETING = "ask_meeting"
    ANSWER_LIVE = "answer_live"
    GENERATE_THUMBNAILS = "generate_thumbnails"


class JobStatus(enum.StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"


class Job(Base):
    __tablename__ = "jobs"
    __table_args__ = (
        CheckConstraint("attempts >= 0", name="ck_job_attempts"),
        CheckConstraint("progress IS NULL OR progress BETWEEN 0 AND 100", name="ck_job_progress"),
        CheckConstraint(
            "(realtime_window_start_ms IS NULL "
            "AND realtime_window_end_ms IS NULL "
            "AND realtime_commit_start_ms IS NULL) "
            "OR (realtime_window_start_ms IS NOT NULL "
            "AND realtime_window_end_ms IS NOT NULL "
            "AND realtime_commit_start_ms IS NOT NULL)",
            name="ck_job_realtime_window_complete",
        ),
        CheckConstraint(
            "realtime_window_start_ms IS NULL OR "
            "(realtime_window_start_ms >= 0 "
            "AND realtime_window_end_ms > realtime_window_start_ms "
            "AND realtime_commit_start_ms >= realtime_window_start_ms "
            "AND realtime_commit_start_ms < realtime_window_end_ms)",
            name="ck_job_realtime_window_bounds",
        ),
        UniqueConstraint(
            "realtime_chunk_id",
            "realtime_window_start_ms",
            "realtime_window_end_ms",
            name="uq_job_realtime_chunk_window",
        ),
        UniqueConstraint("request_id", name="uq_jobs_request_id"),
        Index("ix_jobs_status_created_at", "status", "created_at"),
        Index("ix_jobs_realtime_chunk_id", "realtime_chunk_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    meeting_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("meetings.id", ondelete="CASCADE"), index=True
    )
    realtime_chunk_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid,
        ForeignKey("realtime_chunks.id", ondelete="CASCADE"),
        nullable=True,
    )
    realtime_window_start_ms: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    realtime_window_end_ms: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    realtime_commit_start_ms: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    type: Mapped[JobType] = mapped_column(
        Enum(JobType, name="job_type", values_callable=lambda x: [e.value for e in x])
    )
    status: Mapped[JobStatus] = mapped_column(
        Enum(JobStatus, name="job_status", values_callable=lambda x: [e.value for e in x]),
        default=JobStatus.QUEUED,
    )
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    progress: Mapped[int | None] = mapped_column(Integer, nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    request_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True)
    analysis_request: Mapped[dict[str, Any] | None] = mapped_column(
        JSON().with_variant(JSONB, "postgresql"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    meeting: Mapped["Meeting"] = relationship(back_populates="jobs")

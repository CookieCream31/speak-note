import enum
import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import (
    JSON,
    BigInteger,
    CheckConstraint,
    DateTime,
    Enum,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
    Uuid,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.models.meeting import utc_now


class RealtimeAnalysisStatus(enum.StrEnum):
    QUEUED = "queued"
    PROCESSING = "processing"
    COMPLETED = "completed"
    FAILED = "failed"


class RealtimeAnalysisState(Base):
    __tablename__ = "realtime_analysis_states"
    __table_args__ = (
        CheckConstraint("input_revision >= 0", name="ck_realtime_analysis_input_revision"),
        CheckConstraint("processed_revision >= 0", name="ck_realtime_analysis_processed_revision"),
        CheckConstraint("analyzed_through_ms >= 0", name="ck_realtime_analysis_through_ms"),
        CheckConstraint("scheduled_through_ms >= 0", name="ck_realtime_analysis_scheduled_ms"),
        UniqueConstraint("realtime_session_id", name="uq_realtime_analysis_realtime_session"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    realtime_session_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("realtime_sessions.id", ondelete="CASCADE"), index=True
    )
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
    status: Mapped[RealtimeAnalysisStatus] = mapped_column(
        Enum(
            RealtimeAnalysisStatus,
            name="realtime_analysis_status",
            values_callable=lambda values: [value.value for value in values],
        ),
        default=RealtimeAnalysisStatus.QUEUED,
    )
    input_revision: Mapped[int] = mapped_column(Integer, default=0)
    processed_revision: Mapped[int] = mapped_column(Integer, default=0)
    analyzed_through_ms: Mapped[int] = mapped_column(BigInteger, default=0)
    scheduled_through_ms: Mapped[int] = mapped_column(BigInteger, default=0)
    model: Mapped[str | None] = mapped_column(String(200), nullable=True)
    snapshot: Mapped[dict[str, Any] | None] = mapped_column(
        JSON().with_variant(JSONB, "postgresql"), nullable=True
    )
    source_segments: Mapped[list[dict[str, Any]]] = mapped_column(
        JSON().with_variant(JSONB, "postgresql"), default=list
    )
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now, onupdate=utc_now
    )
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

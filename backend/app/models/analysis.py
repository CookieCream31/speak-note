import enum
import uuid
from typing import Any
from datetime import date, datetime

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    Date,
    DateTime,
    Enum,
    Float,
    ForeignKey,
    Index,
    Integer,
    JSON,
    String,
    Text,
    UniqueConstraint,
    Uuid,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.models.meeting import utc_now


class AnalysisStatus(enum.StrEnum):
    PROCESSING = "processing"
    COMPLETED = "completed"
    FAILED = "failed"


class AnalysisItemKind(enum.StrEnum):
    SUMMARY = "summary"
    DECISION = "decision"
    ACTION_ITEM = "action_item"
    OPEN_QUESTION = "open_question"
    IMPORTANT_POINT = "important_point"
    CHAPTER = "chapter"
    SUGGESTED_QUESTION = "suggested_question"
    HIGHLIGHT = "highlight"


class AnalysisItemState(enum.StrEnum):
    GENERATED = "generated"
    CONFIRMED = "confirmed"
    EDITED = "edited"


class AnalysisVersion(Base):
    __tablename__ = "analysis_versions"
    __table_args__ = (
        CheckConstraint("version >= 1", name="ck_analysis_version_positive"),
        UniqueConstraint("meeting_id", "version", name="uq_analysis_meeting_version"),
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
    version: Mapped[int] = mapped_column(Integer)
    model: Mapped[str] = mapped_column(String(200))
    temperature: Mapped[float] = mapped_column(Float)
    prompt_version: Mapped[str] = mapped_column(String(50))
    status: Mapped[AnalysisStatus] = mapped_column(
        Enum(
            AnalysisStatus,
            name="analysis_status",
            values_callable=lambda values: [value.value for value in values],
        ),
        default=AnalysisStatus.PROCESSING,
    )
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    template_snapshot: Mapped[dict | None] = mapped_column(JSON().with_variant(JSONB, "postgresql"), nullable=True)
    template_values: Mapped[list[dict[str, Any]]] = mapped_column(JSON().with_variant(JSONB, "postgresql"), nullable=False, default=list)

    items: Mapped[list["AnalysisItem"]] = relationship(
        back_populates="analysis_version",
        cascade="all, delete-orphan",
        passive_deletes=True,
        order_by="AnalysisItem.sequence",
    )


class AnalysisItem(Base):
    __tablename__ = "analysis_items"
    __table_args__ = (
        CheckConstraint("sequence >= 0", name="ck_analysis_item_sequence"),
        CheckConstraint("start_ms IS NULL OR start_ms >= 0", name="ck_analysis_item_start_ms"),
        CheckConstraint(
            "end_ms IS NULL OR (start_ms IS NOT NULL AND end_ms >= start_ms)",
            name="ck_analysis_item_end_ms",
        ),
        UniqueConstraint(
            "analysis_version_id", "sequence", name="uq_analysis_item_version_sequence"
        ),
        Index("ix_analysis_items_version_kind", "analysis_version_id", "kind"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    analysis_version_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("analysis_versions.id", ondelete="CASCADE"), index=True
    )
    kind: Mapped[AnalysisItemKind] = mapped_column(
        Enum(
            AnalysisItemKind,
            name="analysis_item_kind",
            values_callable=lambda values: [value.value for value in values],
        )
    )
    state: Mapped[AnalysisItemState] = mapped_column(
        Enum(
            AnalysisItemState,
            name="analysis_item_state",
            values_callable=lambda values: [value.value for value in values],
        ),
        default=AnalysisItemState.GENERATED,
    )
    content: Mapped[str] = mapped_column(Text)
    assignee: Mapped[str | None] = mapped_column(String(200), nullable=True)
    deadline: Mapped[date | None] = mapped_column(Date, nullable=True)
    start_ms: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    end_ms: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    sequence: Mapped[int] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now, onupdate=utc_now
    )

    analysis_version: Mapped[AnalysisVersion] = relationship(back_populates="items")
    evidence: Mapped[list["AnalysisEvidence"]] = relationship(
        back_populates="item",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )


class AnalysisEvidence(Base):
    __tablename__ = "analysis_evidence"

    item_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("analysis_items.id", ondelete="CASCADE"), primary_key=True
    )
    segment_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("transcript_segments.id", ondelete="CASCADE"), primary_key=True
    )

    item: Mapped[AnalysisItem] = relationship(back_populates="evidence")


class Bookmark(Base):
    __tablename__ = "bookmarks"
    __table_args__ = (
        CheckConstraint("timestamp_ms >= 0", name="ck_bookmark_timestamp_ms"),
        Index("ix_bookmarks_meeting_timestamp", "meeting_id", "timestamp_ms"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    meeting_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("meetings.id", ondelete="CASCADE"), index=True
    )
    timestamp_ms: Mapped[int] = mapped_column(BigInteger)
    title: Mapped[str] = mapped_column(String(200))
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)

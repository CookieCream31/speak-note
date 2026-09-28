import enum
import uuid
from datetime import datetime
from typing import TYPE_CHECKING, Any

from sqlalchemy import (
    JSON,
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    Enum,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
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
    from app.models.speaker import Speaker


class TranscriptKind(enum.StrEnum):
    LIVE = "live"
    FINAL = "final"


class TranscriptStatus(enum.StrEnum):
    PROCESSING = "processing"
    COMPLETED = "completed"
    FAILED = "failed"


class TranscriptVersion(Base):
    __tablename__ = "transcript_versions"
    __table_args__ = (
        CheckConstraint("version >= 1", name="ck_transcript_version_positive"),
        UniqueConstraint(
            "meeting_id", "kind", "version", name="uq_transcript_version_meeting_kind_version"
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    meeting_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("meetings.id", ondelete="CASCADE"), index=True
    )
    version: Mapped[int] = mapped_column(Integer)
    kind: Mapped[TranscriptKind] = mapped_column(
        Enum(TranscriptKind, name="transcript_kind", values_callable=lambda x: [e.value for e in x])
    )
    status: Mapped[TranscriptStatus] = mapped_column(
        Enum(
            TranscriptStatus,
            name="transcript_status",
            values_callable=lambda x: [e.value for e in x],
        )
    )
    language: Mapped[str] = mapped_column(String(20))
    model: Mapped[str] = mapped_column(String(100))
    diarization_enabled: Mapped[bool] = mapped_column(Boolean)
    raw_response: Mapped[dict[str, Any] | None] = mapped_column(
        JSON().with_variant(JSONB, "postgresql"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)

    meeting: Mapped["Meeting"] = relationship(back_populates="transcript_versions")
    segments: Mapped[list["TranscriptSegment"]] = relationship(
        back_populates="transcript_version",
        cascade="all, delete-orphan",
        passive_deletes=True,
        order_by="TranscriptSegment.sequence",
    )


class TranscriptSegment(Base):
    __tablename__ = "transcript_segments"
    __table_args__ = (
        CheckConstraint("start_ms >= 0", name="ck_transcript_segment_start_ms"),
        CheckConstraint("end_ms >= start_ms", name="ck_transcript_segment_end_ms"),
        CheckConstraint("sequence >= 0", name="ck_transcript_segment_sequence"),
        UniqueConstraint(
            "transcript_version_id", "sequence", name="uq_transcript_segment_version_sequence"
        ),
        Index("ix_transcript_segments_version_start", "transcript_version_id", "start_ms"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    transcript_version_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("transcript_versions.id", ondelete="CASCADE"), index=True
    )
    start_ms: Mapped[int] = mapped_column(BigInteger)
    end_ms: Mapped[int] = mapped_column(BigInteger)
    speaker_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("speakers.id", ondelete="SET NULL"), nullable=True, index=True
    )
    provisional_speaker_label: Mapped[str | None] = mapped_column(String(100), nullable=True)
    text: Mapped[str] = mapped_column(Text)
    confidence: Mapped[float | None] = mapped_column(Float, nullable=True)
    sequence: Mapped[int] = mapped_column(Integer)

    transcript_version: Mapped[TranscriptVersion] = relationship(back_populates="segments")
    speaker: Mapped["Speaker | None"] = relationship(back_populates="segments")
    words: Mapped[list["TranscriptWord"]] = relationship(
        back_populates="segment",
        cascade="all, delete-orphan",
        passive_deletes=True,
        order_by="TranscriptWord.sequence",
    )


class TranscriptWord(Base):
    __tablename__ = "transcript_words"
    __table_args__ = (
        CheckConstraint("start_ms >= 0", name="ck_transcript_word_start_ms"),
        CheckConstraint("end_ms >= start_ms", name="ck_transcript_word_end_ms"),
        CheckConstraint("sequence >= 0", name="ck_transcript_word_sequence"),
        UniqueConstraint("segment_id", "sequence", name="uq_transcript_word_segment_sequence"),
        Index("ix_transcript_words_segment_start", "segment_id", "start_ms"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    segment_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("transcript_segments.id", ondelete="CASCADE"), index=True
    )
    start_ms: Mapped[int] = mapped_column(BigInteger)
    end_ms: Mapped[int] = mapped_column(BigInteger)
    speaker_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("speakers.id", ondelete="SET NULL"), nullable=True, index=True
    )
    text: Mapped[str] = mapped_column(Text)
    confidence: Mapped[float | None] = mapped_column(Float, nullable=True)
    sequence: Mapped[int] = mapped_column(Integer)

    segment: Mapped[TranscriptSegment] = relationship(back_populates="words")
    speaker: Mapped["Speaker | None"] = relationship(back_populates="words")

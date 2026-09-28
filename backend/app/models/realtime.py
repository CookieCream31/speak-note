import enum
import uuid
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    Enum,
    ForeignKey,
    Integer,
    String,
    UniqueConstraint,
    Uuid,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.models.meeting import utc_now


class RealtimeSessionStatus(enum.StrEnum):
    RECORDING = "recording"
    FINALIZING = "finalizing"
    COMPLETED = "completed"
    FAILED = "failed"


class RealtimeSession(Base):
    __tablename__ = "realtime_sessions"
    __table_args__ = (
        CheckConstraint("duration_ms >= 0", name="ck_realtime_session_duration_ms"),
        CheckConstraint("received_bytes >= 0", name="ck_realtime_session_received_bytes"),
        CheckConstraint("chunk_count >= 0", name="ck_realtime_session_chunk_count"),
        CheckConstraint("audio_chunk_count >= 0", name="ck_realtime_session_audio_chunk_count"),
        CheckConstraint("video_part_count >= 0", name="ck_realtime_session_video_part_count"),
        UniqueConstraint("media_id", name="uq_realtime_session_media"),
        UniqueConstraint("transcript_version_id", name="uq_realtime_session_transcript"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    meeting_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("meetings.id", ondelete="CASCADE"), index=True
    )
    media_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("media.id", ondelete="CASCADE"))
    transcript_version_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("transcript_versions.id", ondelete="CASCADE")
    )
    status: Mapped[RealtimeSessionStatus] = mapped_column(
        Enum(
            RealtimeSessionStatus,
            name="realtime_session_status",
            values_callable=lambda values: [value.value for value in values],
        ),
        default=RealtimeSessionStatus.RECORDING,
    )
    mime_type: Mapped[str] = mapped_column(String(200))
    split_capture: Mapped[bool] = mapped_column(Boolean, default=False)
    audio_storage_path: Mapped[str | None] = mapped_column(String(500), nullable=True)
    audio_mime_type: Mapped[str | None] = mapped_column(String(200), nullable=True)
    audio_chunk_count: Mapped[int] = mapped_column(Integer, default=0)
    video_part_count: Mapped[int] = mapped_column(Integer, default=0)
    has_system_audio: Mapped[bool] = mapped_column(Boolean, default=False)
    transcription_provider: Mapped[str] = mapped_column(String(20), default="whisperx")
    transcription_region: Mapped[str | None] = mapped_column(String(100), nullable=True)
    chunk_count: Mapped[int] = mapped_column(Integer, default=0)
    received_bytes: Mapped[int] = mapped_column(BigInteger, default=0)
    duration_ms: Mapped[int] = mapped_column(BigInteger, default=0)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class RealtimeChunk(Base):
    __tablename__ = "realtime_chunks"
    __table_args__ = (
        CheckConstraint("sequence >= 0", name="ck_realtime_chunk_sequence"),
        CheckConstraint("start_ms >= 0", name="ck_realtime_chunk_start_ms"),
        CheckConstraint("end_ms >= start_ms", name="ck_realtime_chunk_end_ms"),
        CheckConstraint("window_start_ms >= 0", name="ck_realtime_chunk_window_start_ms"),
        CheckConstraint("size_bytes > 0", name="ck_realtime_chunk_size_bytes"),
        UniqueConstraint("session_id", "sequence", name="uq_realtime_chunk_session_sequence"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    session_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("realtime_sessions.id", ondelete="CASCADE"), index=True
    )
    sequence: Mapped[int] = mapped_column(Integer)
    start_ms: Mapped[int] = mapped_column(BigInteger)
    end_ms: Mapped[int] = mapped_column(BigInteger)
    window_start_ms: Mapped[int] = mapped_column(BigInteger)
    size_bytes: Mapped[int] = mapped_column(BigInteger)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)


class RealtimeVideoPart(Base):
    __tablename__ = "realtime_video_parts"
    __table_args__ = (
        CheckConstraint("sequence >= 0", name="ck_realtime_video_part_sequence"),
        CheckConstraint("start_ms >= 0", name="ck_realtime_video_part_start_ms"),
        CheckConstraint(
            "end_ms IS NULL OR end_ms > start_ms",
            name="ck_realtime_video_part_end_ms",
        ),
        CheckConstraint("chunk_count >= 0", name="ck_realtime_video_part_chunk_count"),
        CheckConstraint("size_bytes >= 0", name="ck_realtime_video_part_size_bytes"),
        UniqueConstraint("session_id", "sequence", name="uq_realtime_video_part_sequence"),
        UniqueConstraint("storage_path", name="uq_realtime_video_part_storage_path"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    session_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("realtime_sessions.id", ondelete="CASCADE"), index=True
    )
    sequence: Mapped[int] = mapped_column(Integer)
    start_ms: Mapped[int] = mapped_column(BigInteger)
    end_ms: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    mime_type: Mapped[str] = mapped_column(String(200))
    storage_path: Mapped[str] = mapped_column(String(500))
    chunk_count: Mapped[int] = mapped_column(Integer, default=0)
    size_bytes: Mapped[int] = mapped_column(BigInteger, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)

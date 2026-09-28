from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.job import Job, JobType
from app.models.media import Media, MediaKind
from app.models.meeting import Meeting, MeetingSourceType, MeetingStatus
from app.models.realtime import RealtimeSession, RealtimeVideoPart
from app.services.media.ffmpeg import FFmpegMediaService
from app.services.media.live_recording import (
    FFmpegLiveRecordingAssembler,
    LiveVideoPartInput,
)
from app.services.media.storage import MediaStorage


def process_video_job(
    session: Session,
    job: Job,
    media_service: FFmpegMediaService,
    storage: MediaStorage,
    live_assembler: FFmpegLiveRecordingAssembler | None = None,
) -> None:
    meeting = session.get(Meeting, job.meeting_id)
    if meeting is None:
        raise RuntimeError("Meeting no longer exists")
    original = session.scalar(
        select(Media).where(
            Media.meeting_id == meeting.id,
            Media.kind == MediaKind.ORIGINAL_VIDEO,
        )
    )
    if original is None:
        raise RuntimeError("Original video is missing")

    meeting.status = MeetingStatus.PREPROCESSING
    job.progress = 10
    session.commit()

    realtime_session = None
    if meeting.source_type == MeetingSourceType.LIVE:
        realtime_session = session.scalar(
            select(RealtimeSession)
            .where(RealtimeSession.meeting_id == meeting.id)
            .order_by(RealtimeSession.started_at.desc())
            .limit(1)
        )
    if realtime_session is not None and realtime_session.split_capture:
        if realtime_session.audio_storage_path is None:
            raise RuntimeError("Live recording audio is missing")
        video_parts = list(
            session.scalars(
                select(RealtimeVideoPart)
                .where(RealtimeVideoPart.session_id == realtime_session.id)
                .order_by(RealtimeVideoPart.sequence)
            )
        )
        assembler = live_assembler or FFmpegLiveRecordingAssembler()
        original.size_bytes = assembler.assemble(
            [
                LiveVideoPartInput(
                    path=storage.absolute_path(part.storage_path),
                    start_ms=part.start_ms,
                    end_ms=part.end_ms if part.end_ms is not None else realtime_session.duration_ms,
                )
                for part in video_parts
                if part.size_bytes > 0
            ],
            storage.absolute_path(realtime_session.audio_storage_path),
            storage.absolute_path(original.storage_path),
            duration_ms=realtime_session.duration_ms,
        )
        original.mime_type = "video/mp4"
        job.progress = 35
        session.commit()

    playback_storage_path = (
        Path("meetings") / str(meeting.id) / "derived" / "playback.mp4"
    ).as_posix()
    transcription_storage_path = (
        Path("meetings") / str(meeting.id) / "derived" / "transcription.wav"
    ).as_posix()
    processed = media_service.process_video(
        storage.absolute_path(original.storage_path),
        storage.absolute_path(playback_storage_path),
        storage.absolute_path(transcription_storage_path),
        fallback_duration_ms=(
            meeting.duration_ms if meeting.source_type == MeetingSourceType.LIVE else None
        ),
    )

    playback = session.scalar(
        select(Media).where(
            Media.meeting_id == meeting.id,
            Media.kind == MediaKind.PLAYBACK_VIDEO,
        )
    )
    if playback is None:
        playback = Media(
            meeting_id=meeting.id,
            kind=MediaKind.PLAYBACK_VIDEO,
            storage_path=playback_storage_path,
            mime_type="video/mp4",
            size_bytes=processed.playback_size_bytes,
        )
        session.add(playback)
    playback.size_bytes = processed.playback_size_bytes
    playback.duration_ms = processed.duration_ms

    transcription_audio = session.scalar(
        select(Media).where(
            Media.meeting_id == meeting.id,
            Media.kind == MediaKind.TRANSCRIPTION_AUDIO,
        )
    )
    if transcription_audio is None:
        transcription_audio = Media(
            meeting_id=meeting.id,
            kind=MediaKind.TRANSCRIPTION_AUDIO,
            storage_path=transcription_storage_path,
            mime_type="audio/wav",
            size_bytes=processed.transcription_size_bytes,
        )
        session.add(transcription_audio)
    transcription_audio.size_bytes = processed.transcription_size_bytes
    transcription_audio.duration_ms = processed.duration_ms

    original.duration_ms = processed.duration_ms
    meeting.duration_ms = processed.duration_ms
    if meeting.source_type == MeetingSourceType.LIVE:
        # Live録画は、録画停止直後に重いFinal処理を開始しない。
        # 変換済み音声を用意した状態で、ユーザーによる手動開始を待つ。
        meeting.status = MeetingStatus.COMPLETED
    else:
        existing_transcription_job = session.scalar(
            select(Job.id).where(
                Job.meeting_id == meeting.id,
                Job.type == JobType.TRANSCRIBE,
            )
        )
        if existing_transcription_job is None:
            session.add(Job(meeting_id=meeting.id, type=JobType.TRANSCRIBE, progress=0))
        meeting.status = MeetingStatus.QUEUED
    job.progress = 95
    session.commit()

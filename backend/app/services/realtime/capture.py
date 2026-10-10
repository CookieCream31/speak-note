import logging
import uuid
from datetime import timedelta
from pathlib import Path

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.job import Job, JobType
from app.models.media import Media, MediaKind
from app.models.meeting import Meeting, MeetingSourceType, MeetingStatus, utc_now
from app.models.realtime import (
    RealtimeChunk,
    RealtimeSession,
    RealtimeSessionStatus,
    RealtimeVideoPart,
)
from app.models.transcript import (
    TranscriptKind,
    TranscriptSegment,
    TranscriptStatus,
    TranscriptVersion,
)
from app.models.transcription import RealtimeTranscriptionProvider
from app.services.analysis.realtime import schedule_realtime_analysis
from app.services.media import MediaStorage
from app.services.realtime.windows import build_realtime_transcription_windows

ALLOWED_REALTIME_MIME_TYPES = frozenset({"video/webm", "video/mp4"})
ALLOWED_REALTIME_AUDIO_MIME_TYPES = frozenset({"audio/webm", "audio/mp4"})

logger = logging.getLogger(__name__)


class RealtimeCaptureError(RuntimeError):
    pass


def _base_mime_type(mime_type: str) -> str:
    return mime_type.split(";", maxsplit=1)[0].strip().lower()


def start_realtime_session(
    db: Session,
    meeting: Meeting,
    storage: MediaStorage,
    *,
    mime_type: str,
    has_system_audio: bool,
    model: str,
    language: str,
    transcription_provider: str = "whisperx",
    transcription_region: str | None = None,
    split_capture: bool = False,
    audio_mime_type: str | None = None,
) -> RealtimeSession:
    if meeting.source_type not in {
        MeetingSourceType.LIVE,
        MeetingSourceType.AUDIO_RECORDING,
        MeetingSourceType.SHARED_AUDIO,
    }:
        raise RealtimeCaptureError("この会議はリアルタイム録音用ではありません")
    audio_only = meeting.source_type in {
        MeetingSourceType.AUDIO_RECORDING,
        MeetingSourceType.SHARED_AUDIO,
    }
    if audio_only and split_capture:
        raise RealtimeCaptureError("音声のみの録音では分離録画を使用できません")
    if meeting.source_type == MeetingSourceType.SHARED_AUDIO and not has_system_audio:
        raise RealtimeCaptureError("共有元の音声共有を有効にしてください")
    base_mime = _base_mime_type(mime_type)
    allowed_mime_types = (
        ALLOWED_REALTIME_AUDIO_MIME_TYPES if audio_only else ALLOWED_REALTIME_MIME_TYPES
    )
    if base_mime not in allowed_mime_types:
        media_label = "録音" if audio_only else "録画"
        raise RealtimeCaptureError(f"{media_label}形式はWebMまたはMP4を使用してください")
    base_audio_mime: str | None = None
    if split_capture:
        if audio_mime_type is None:
            raise RealtimeCaptureError("分離録画には音声形式が必要です")
        base_audio_mime = _base_mime_type(audio_mime_type)
        if base_audio_mime not in ALLOWED_REALTIME_AUDIO_MIME_TYPES:
            raise RealtimeCaptureError("録音形式はWebMまたはMP4を使用してください")
    original_media_kind = MediaKind.ORIGINAL_AUDIO if audio_only else MediaKind.ORIGINAL_VIDEO
    existing_media = db.scalar(
        select(Media.id).where(
            Media.meeting_id == meeting.id,
            Media.kind == original_media_kind,
        )
    )
    if existing_media is not None:
        raise RealtimeCaptureError("この会議には録音・録画済みのメディアがあります")
    active = db.scalar(
        select(RealtimeSession.id).where(
            RealtimeSession.meeting_id == meeting.id,
            RealtimeSession.status == RealtimeSessionStatus.RECORDING,
        )
    )
    if active is not None:
        raise RealtimeCaptureError("録音または画面共有はすでに開始されています")

    media_id = uuid.uuid4()
    realtime_session_id = uuid.uuid4()
    suffix = (
        ".mp4"
        if split_capture
        else (".webm" if base_mime in {"video/webm", "audio/webm"} else ".mp4")
    )
    storage_path = (
        Path("meetings") / str(meeting.id) / "original" / f"{media_id}{suffix}"
    ).as_posix()
    absolute_path = storage.absolute_path(storage_path)
    absolute_path.parent.mkdir(parents=True, exist_ok=True)
    audio_storage_path: str | None = None
    audio_absolute_path: Path | None = None
    if split_capture:
        assert base_audio_mime is not None
        audio_suffix = ".webm" if base_audio_mime == "audio/webm" else ".mp4"
        audio_storage_path = (
            Path("meetings")
            / str(meeting.id)
            / "capture"
            / str(realtime_session_id)
            / f"audio{audio_suffix}"
        ).as_posix()
        audio_absolute_path = storage.absolute_path(audio_storage_path)
        audio_absolute_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        absolute_path.open("xb").close()
        if audio_absolute_path is not None:
            audio_absolute_path.open("xb").close()
    except FileExistsError as exc:
        absolute_path.unlink(missing_ok=True)
        if audio_absolute_path is not None:
            audio_absolute_path.unlink(missing_ok=True)
        raise RealtimeCaptureError("録画ファイルを初期化できませんでした") from exc

    live_version = db.scalar(
        select(func.max(TranscriptVersion.version)).where(
            TranscriptVersion.meeting_id == meeting.id,
            TranscriptVersion.kind == TranscriptKind.LIVE,
        )
    )
    media = Media(
        id=media_id,
        meeting_id=meeting.id,
        kind=original_media_kind,
        storage_path=storage_path,
        mime_type="video/mp4" if split_capture else base_mime,
        size_bytes=0,
        duration_ms=0,
    )
    transcript = TranscriptVersion(
        meeting_id=meeting.id,
        version=(live_version or 0) + 1,
        kind=TranscriptKind.LIVE,
        status=TranscriptStatus.PROCESSING,
        language=language,
        model=model,
        diarization_enabled=transcription_provider in {"whisperx", "azure_speech"},
    )
    db.add_all([media, transcript])
    db.flush()
    realtime_session = RealtimeSession(
        id=realtime_session_id,
        meeting_id=meeting.id,
        media_id=media.id,
        transcript_version_id=transcript.id,
        mime_type=mime_type[:200],
        split_capture=split_capture,
        audio_storage_path=audio_storage_path,
        audio_mime_type=audio_mime_type[:200] if audio_mime_type is not None else None,
        has_system_audio=has_system_audio,
        transcription_provider=transcription_provider,
        transcription_region=transcription_region,
    )
    meeting.status = MeetingStatus.RECORDING
    meeting.started_at = utc_now()
    meeting.duration_ms = 0
    db.add(realtime_session)
    try:
        db.commit()
    except Exception:
        db.rollback()
        absolute_path.unlink(missing_ok=True)
        if audio_absolute_path is not None:
            audio_absolute_path.unlink(missing_ok=True)
        raise
    db.refresh(realtime_session)
    return realtime_session


def append_realtime_chunk(
    db: Session,
    realtime_session: RealtimeSession,
    storage: MediaStorage,
    *,
    sequence: int,
    start_ms: int,
    end_ms: int,
    content: bytes,
    window_ms: int,
    step_ms: int,
    max_chunk_bytes: int,
) -> RealtimeChunk:
    if realtime_session.status != RealtimeSessionStatus.RECORDING:
        raise RealtimeCaptureError("録画セッションは終了しています")
    expected_sequence = (
        realtime_session.audio_chunk_count
        if realtime_session.split_capture
        else realtime_session.chunk_count
    )
    if sequence < expected_sequence:
        existing = db.scalar(
            select(RealtimeChunk).where(
                RealtimeChunk.session_id == realtime_session.id,
                RealtimeChunk.sequence == sequence,
            )
        )
        if (
            existing is not None
            and existing.start_ms == start_ms
            and existing.end_ms == end_ms
            and existing.size_bytes == len(content)
        ):
            # A reconnected client replays chunks whose acknowledgement was lost.
            return existing
    if sequence != expected_sequence:
        raise RealtimeCaptureError(f"Chunkの順序が不正です（expected={expected_sequence}）")
    if start_ms < 0 or end_ms <= start_ms:
        raise RealtimeCaptureError("Chunkの時刻が不正です")
    if start_ms < realtime_session.duration_ms:
        raise RealtimeCaptureError("Chunkの時刻が前のChunkと重複しています")
    if not content:
        raise RealtimeCaptureError("空のChunkは保存できません")
    if len(content) > max_chunk_bytes:
        raise RealtimeCaptureError("Chunkサイズが上限を超えています")

    media = db.get(Media, realtime_session.media_id)
    if media is None:
        raise RealtimeCaptureError("録画メディアが見つかりません")
    meeting = db.get(Meeting, realtime_session.meeting_id)
    audio_only = media.kind == MediaKind.ORIGINAL_AUDIO
    max_upload_bytes = (
        storage.max_audio_upload_bytes if audio_only else storage.max_video_upload_bytes
    )
    if realtime_session.received_bytes + len(content) > max_upload_bytes:
        limit_mb = max_upload_bytes // (1024 * 1024)
        media_label = "録音" if audio_only else "録画"
        raise RealtimeCaptureError(f"{media_label}は{limit_mb}MB以下にしてください")

    destination = storage.absolute_path(
        realtime_session.audio_storage_path
        if realtime_session.split_capture and realtime_session.audio_storage_path is not None
        else media.storage_path
    )
    previous_size = destination.stat().st_size
    with destination.open("ab") as output:
        output.write(content)

    effective_window_ms = max(1, window_ms)
    chunk = RealtimeChunk(
        session_id=realtime_session.id,
        sequence=sequence,
        start_ms=start_ms,
        end_ms=end_ms,
        # MediaRecorder may delay a dataavailable event for several minutes when
        # the browser is busy or backgrounded.  Keep the whole newly received
        # range available to the worker instead of silently retaining only the
        # final overlap window.
        window_start_ms=max(0, min(start_ms, end_ms - effective_window_ms)),
        size_bytes=len(content),
    )
    db.add(chunk)
    db.flush()
    if realtime_session.transcription_provider == RealtimeTranscriptionProvider.WHISPERX:
        windows = build_realtime_transcription_windows(
            chunk,
            window_ms=effective_window_ms,
            step_ms=step_ms,
        )
        db.add_all(
            [
                Job(
                    meeting_id=realtime_session.meeting_id,
                    realtime_chunk_id=chunk.id,
                    realtime_window_start_ms=window.start_ms,
                    realtime_window_end_ms=window.end_ms,
                    realtime_commit_start_ms=window.commit_start_ms,
                    type=JobType.TRANSCRIBE_LIVE,
                    progress=0,
                )
                for window in windows
            ]
        )
    realtime_session.chunk_count += 1
    if realtime_session.split_capture:
        realtime_session.audio_chunk_count += 1
    realtime_session.received_bytes += len(content)
    realtime_session.duration_ms = end_ms
    realtime_session.last_activity_at = utc_now()
    if not realtime_session.split_capture:
        media.size_bytes = realtime_session.received_bytes
    media.duration_ms = end_ms
    if meeting is not None:
        meeting.duration_ms = end_ms
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        with destination.open("r+b") as output:
            output.truncate(previous_size)
        raise RealtimeCaptureError("Chunkを重複して受信しました") from exc
    except Exception:
        db.rollback()
        with destination.open("r+b") as output:
            output.truncate(previous_size)
        raise
    db.refresh(chunk)
    if realtime_session.transcription_provider == RealtimeTranscriptionProvider.AZURE_SPEECH:
        has_segments = db.scalar(
            select(TranscriptSegment.id)
            .where(
                TranscriptSegment.transcript_version_id == realtime_session.transcript_version_id
            )
            .limit(1)
        )
        if has_segments is not None:
            schedule_realtime_analysis(db, realtime_session)
    return chunk


def append_streaming_transcript_segment(
    db: Session,
    realtime_session: RealtimeSession,
    *,
    result_id: str,
    start_ms: int,
    end_ms: int,
    text: str,
    speaker_label: str | None = None,
    confidence: float | None = None,
) -> TranscriptSegment:
    if realtime_session.status != RealtimeSessionStatus.RECORDING:
        raise RealtimeCaptureError("録画セッションは終了しています")
    if realtime_session.transcription_provider != RealtimeTranscriptionProvider.AZURE_SPEECH:
        raise RealtimeCaptureError("この録画セッションはAzure連続認識を使用していません")
    normalized_result_id = result_id.strip()
    normalized_text = " ".join(text.split())
    normalized_speaker_label = (speaker_label or "SPEAKER_UNKNOWN").strip()
    if not normalized_result_id or len(normalized_result_id) > 200:
        raise RealtimeCaptureError("Azure認識結果IDの形式が不正です")
    if not normalized_text or len(normalized_text) > 20_000:
        raise RealtimeCaptureError("Azure認識結果の本文が不正です")
    if not normalized_speaker_label or len(normalized_speaker_label) > 100:
        raise RealtimeCaptureError("Azure認識結果の話者ラベルが不正です")
    if start_ms < 0 or end_ms <= start_ms:
        raise RealtimeCaptureError("Azure認識結果の時刻が不正です")
    if confidence is not None and not 0 <= confidence <= 1:
        raise RealtimeCaptureError("Azure認識結果の信頼度が不正です")

    segment_id = uuid.uuid5(realtime_session.id, f"azure:{normalized_result_id}")
    existing = db.get(TranscriptSegment, segment_id)
    if existing is not None:
        return existing
    transcript = db.get(TranscriptVersion, realtime_session.transcript_version_id)
    if transcript is None:
        raise RealtimeCaptureError("Live Transcriptが見つかりません")
    last_sequence = db.scalar(
        select(func.max(TranscriptSegment.sequence)).where(
            TranscriptSegment.transcript_version_id == transcript.id
        )
    )
    next_sequence = 0 if last_sequence is None else last_sequence + 1
    segment = TranscriptSegment(
        id=segment_id,
        transcript_version_id=transcript.id,
        start_ms=start_ms,
        end_ms=end_ms,
        provisional_speaker_label=normalized_speaker_label,
        text=normalized_text,
        confidence=confidence,
        sequence=next_sequence,
    )
    db.add(segment)
    db.commit()
    db.refresh(segment)
    schedule_realtime_analysis(db, realtime_session)
    return segment


def start_realtime_video_part(
    db: Session,
    realtime_session: RealtimeSession,
    storage: MediaStorage,
    *,
    sequence: int,
    start_ms: int,
    mime_type: str,
) -> RealtimeVideoPart:
    if not realtime_session.split_capture:
        raise RealtimeCaptureError("この録画セッションは映像Partに対応していません")
    if realtime_session.status != RealtimeSessionStatus.RECORDING:
        raise RealtimeCaptureError("録画セッションは終了しています")
    if sequence < realtime_session.video_part_count:
        existing_part = db.scalar(
            select(RealtimeVideoPart).where(
                RealtimeVideoPart.session_id == realtime_session.id,
                RealtimeVideoPart.sequence == sequence,
            )
        )
        if existing_part is not None and existing_part.start_ms == start_ms:
            return existing_part
    if sequence != realtime_session.video_part_count:
        raise RealtimeCaptureError(
            f"映像Partの順序が不正です（expected={realtime_session.video_part_count}）"
        )
    if start_ms < 0:
        raise RealtimeCaptureError("映像Partの開始時刻が不正です")
    previous_part = db.scalar(
        select(RealtimeVideoPart)
        .where(RealtimeVideoPart.session_id == realtime_session.id)
        .order_by(RealtimeVideoPart.sequence.desc())
        .limit(1)
    )
    if previous_part is not None and (
        previous_part.end_ms is None or start_ms < previous_part.end_ms
    ):
        raise RealtimeCaptureError("前の映像Partが未完了、または映像Partの時刻が重複しています")
    base_mime = _base_mime_type(mime_type)
    if base_mime not in ALLOWED_REALTIME_MIME_TYPES:
        raise RealtimeCaptureError("映像PartはWebMまたはMP4を使用してください")
    suffix = ".webm" if base_mime == "video/webm" else ".mp4"
    part_id = uuid.uuid4()
    storage_path = (
        Path("meetings")
        / str(realtime_session.meeting_id)
        / "capture"
        / str(realtime_session.id)
        / f"video-{sequence:04d}-{part_id}{suffix}"
    ).as_posix()
    destination = storage.absolute_path(storage_path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    try:
        destination.open("xb").close()
    except FileExistsError as exc:
        raise RealtimeCaptureError("映像Partを初期化できませんでした") from exc

    part = RealtimeVideoPart(
        id=part_id,
        session_id=realtime_session.id,
        sequence=sequence,
        start_ms=start_ms,
        mime_type=mime_type[:200],
        storage_path=storage_path,
    )
    realtime_session.video_part_count += 1
    db.add(part)
    try:
        db.commit()
    except Exception:
        db.rollback()
        destination.unlink(missing_ok=True)
        raise
    db.refresh(part)
    return part


def append_realtime_video_chunk(
    db: Session,
    realtime_session: RealtimeSession,
    part: RealtimeVideoPart,
    storage: MediaStorage,
    *,
    sequence: int,
    content: bytes,
    max_chunk_bytes: int,
) -> RealtimeVideoPart:
    if realtime_session.status != RealtimeSessionStatus.RECORDING:
        raise RealtimeCaptureError("録画セッションは終了しています")
    if part.session_id != realtime_session.id:
        raise RealtimeCaptureError("映像Partが録画セッションと一致しません")
    if 0 <= sequence < part.chunk_count:
        # Replayed after a reconnect; the bytes were already appended.
        return part
    if part.end_ms is not None:
        raise RealtimeCaptureError("映像Partはすでに終了しています")
    if sequence != part.chunk_count:
        raise RealtimeCaptureError(f"映像Chunkの順序が不正です（expected={part.chunk_count}）")
    if not content:
        raise RealtimeCaptureError("空の映像Chunkは保存できません")
    if len(content) > max_chunk_bytes:
        raise RealtimeCaptureError("映像Chunkサイズが上限を超えています")
    if realtime_session.received_bytes + len(content) > storage.max_video_upload_bytes:
        limit_mb = storage.max_video_upload_bytes // (1024 * 1024)
        raise RealtimeCaptureError(f"録画は{limit_mb}MB以下にしてください")

    destination = storage.absolute_path(part.storage_path)
    previous_size = destination.stat().st_size
    with destination.open("ab") as output:
        output.write(content)
    part.chunk_count += 1
    part.size_bytes += len(content)
    realtime_session.received_bytes += len(content)
    realtime_session.last_activity_at = utc_now()
    try:
        db.commit()
    except Exception:
        db.rollback()
        with destination.open("r+b") as output:
            output.truncate(previous_size)
        raise
    db.refresh(part)
    return part


def finish_realtime_video_part(
    db: Session,
    realtime_session: RealtimeSession,
    part: RealtimeVideoPart,
    *,
    end_ms: int,
) -> RealtimeVideoPart:
    if part.session_id != realtime_session.id:
        raise RealtimeCaptureError("映像Partが録画セッションと一致しません")
    if part.end_ms is not None:
        return part
    if end_ms <= part.start_ms:
        raise RealtimeCaptureError("映像Partの終了時刻が不正です")
    part.end_ms = end_ms
    db.commit()
    db.refresh(part)
    return part


def finalize_realtime_session(db: Session, realtime_session: RealtimeSession) -> Job | None:
    if realtime_session.status != RealtimeSessionStatus.RECORDING:
        meeting = db.get(Meeting, realtime_session.meeting_id)
        if meeting is not None and meeting.source_type in {
            MeetingSourceType.AUDIO_RECORDING,
            MeetingSourceType.SHARED_AUDIO,
        }:
            return None
        expected_job_type = JobType.PREPROCESS_MEDIA
        existing = db.scalar(
            select(Job).where(
                Job.meeting_id == realtime_session.meeting_id,
                Job.type == expected_job_type,
            )
        )
        if existing is None:
            raise RealtimeCaptureError("録画セッションはすでに終了しています")
        return existing
    if realtime_session.split_capture:
        video_parts = list(
            db.scalars(
                select(RealtimeVideoPart).where(RealtimeVideoPart.session_id == realtime_session.id)
            )
        )
        if realtime_session.audio_chunk_count <= 0:
            raise RealtimeCaptureError("録音データがありません")
        if not any(part.size_bytes > 0 for part in video_parts) or any(
            part.end_ms is None for part in video_parts
        ):
            raise RealtimeCaptureError("録画映像が完了していません")
    elif realtime_session.received_bytes <= 0:
        raise RealtimeCaptureError("録画データがありません")

    realtime_session.status = RealtimeSessionStatus.COMPLETED
    realtime_session.ended_at = utc_now()
    transcript = db.get(TranscriptVersion, realtime_session.transcript_version_id)
    if transcript is not None:
        transcript.status = TranscriptStatus.COMPLETED
    meeting = db.get(Meeting, realtime_session.meeting_id)
    if meeting is None:
        raise RealtimeCaptureError("会議が見つかりません")
    meeting.duration_ms = realtime_session.duration_ms
    if meeting.source_type in {MeetingSourceType.AUDIO_RECORDING, MeetingSourceType.SHARED_AUDIO}:
        meeting.status = MeetingStatus.COMPLETED
        db.commit()
        return None
    meeting.status = MeetingStatus.QUEUED
    job_type = JobType.PREPROCESS_MEDIA
    job = Job(
        meeting_id=realtime_session.meeting_id,
        type=job_type,
        progress=0,
    )
    db.add(job)
    db.commit()
    db.refresh(job)
    return job


def resume_realtime_session(
    db: Session, meeting_id: uuid.UUID, session_id: uuid.UUID
) -> RealtimeSession:
    realtime_session = db.get(RealtimeSession, session_id)
    if realtime_session is None or realtime_session.meeting_id != meeting_id:
        raise RealtimeCaptureError("再開する録音セッションが見つかりません")
    if realtime_session.status != RealtimeSessionStatus.RECORDING:
        raise RealtimeCaptureError("録音セッションはすでに終了しているため再開できません")
    realtime_session.last_activity_at = utc_now()
    db.commit()
    db.refresh(realtime_session)
    return realtime_session


def _discard_empty_session(
    db: Session,
    realtime_session: RealtimeSession,
    storage: MediaStorage,
) -> None:
    media = db.get(Media, realtime_session.media_id)
    transcript = db.get(TranscriptVersion, realtime_session.transcript_version_id)
    meeting = db.get(Meeting, realtime_session.meeting_id)
    storage_path = media.storage_path if media is not None else None
    capture_paths = [
        realtime_session.audio_storage_path,
        *db.scalars(
            select(RealtimeVideoPart.storage_path).where(
                RealtimeVideoPart.session_id == realtime_session.id
            )
        ),
    ]
    db.delete(realtime_session)
    if media is not None:
        db.delete(media)
    if transcript is not None:
        db.delete(transcript)
    if meeting is not None:
        meeting.status = MeetingStatus.CREATED
        meeting.started_at = None
        meeting.duration_ms = None
    db.commit()
    if storage_path is not None:
        storage.delete_file(storage_path)
    for capture_path in capture_paths:
        if capture_path is not None:
            storage.delete_file(capture_path)


def close_interrupted_realtime_session(
    db: Session,
    realtime_session: RealtimeSession,
    storage: MediaStorage,
) -> bool:
    """Save what was received, or discard a session that never received data."""
    try:
        # Another connection may have resumed and appended since this one loaded it.
        db.refresh(realtime_session)
        if realtime_session.status != RealtimeSessionStatus.RECORDING:
            return True
        if realtime_session.received_bytes > 0:
            if realtime_session.split_capture:
                open_parts = list(
                    db.scalars(
                        select(RealtimeVideoPart).where(
                            RealtimeVideoPart.session_id == realtime_session.id,
                            RealtimeVideoPart.end_ms.is_(None),
                        )
                    )
                )
                for part in open_parts:
                    part.end_ms = max(
                        realtime_session.duration_ms,
                        part.start_ms + 1,
                    )
                db.commit()
            finalize_realtime_session(db, realtime_session)
        else:
            _discard_empty_session(db, realtime_session, storage)
    except Exception:
        db.rollback()
        return False
    return True


def finalize_stale_realtime_sessions(
    db: Session,
    storage: MediaStorage,
    *,
    idle_seconds: float,
) -> int:
    """Finalize recordings whose client never reconnected within the resume timeout."""
    cutoff = utc_now() - timedelta(seconds=idle_seconds)
    stale_sessions = list(
        db.scalars(
            select(RealtimeSession)
            .where(
                RealtimeSession.status == RealtimeSessionStatus.RECORDING,
                RealtimeSession.last_activity_at < cutoff,
            )
            .order_by(RealtimeSession.last_activity_at)
            .with_for_update(skip_locked=True)
        )
    )
    for realtime_session in stale_sessions:
        session_id = realtime_session.id
        if close_interrupted_realtime_session(db, realtime_session, storage):
            logger.warning("Finalized interrupted realtime session %s", session_id)
            continue
        # Never leave an unrecoverable capture blocking the meeting forever.
        failed_session = db.get(RealtimeSession, session_id)
        if failed_session is None:
            continue
        failed_session.status = RealtimeSessionStatus.FAILED
        failed_session.ended_at = utc_now()
        meeting = db.get(Meeting, failed_session.meeting_id)
        if meeting is not None:
            meeting.status = MeetingStatus.FAILED
        db.commit()
        logger.warning("Could not finalize interrupted realtime session %s", session_id)
    return len(stale_sessions)

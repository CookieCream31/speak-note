import shutil
import tempfile
import uuid
from pathlib import Path
from statistics import fmean

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app.models.job import Job
from app.models.media import Media
from app.models.meeting import Meeting
from app.models.realtime import RealtimeChunk, RealtimeSession, RealtimeSessionStatus
from app.models.transcript import TranscriptSegment, TranscriptVersion, TranscriptWord
from app.services.analysis.realtime import schedule_realtime_analysis
from app.services.media import MediaStorage
from app.services.media.realtime import RealtimeWindowMediaService
from app.services.realtime.windows import (
    RealtimeTranscriptionWindow,
    build_realtime_transcription_windows,
)
from app.services.transcription.base import TranscriptionClient
from app.services.transcription.client import WhisperXEmptyAudioError
from app.services.transcription.processor import seconds_to_ms
from app.services.transcription.schemas import WhisperXResult
from app.services.transcription.speaker_turns import (
    SpeakerTurn,
    build_speaker_turns,
)

_MIN_REPETITION_COUNT = 5
_MIN_REPETITION_CHARACTERS = 15
_MIN_REPETITION_RATIO = 0.65
_MAX_REPETITION_UNIT_CHARACTERS = 12


def _is_likely_repetitive_hallucination(text: str) -> bool:
    normalized = "".join(character.casefold() for character in text if character.isalnum())
    if len(normalized) < _MIN_REPETITION_CHARACTERS:
        return False

    max_unit_length = min(
        _MAX_REPETITION_UNIT_CHARACTERS,
        len(normalized) // _MIN_REPETITION_COUNT,
    )
    for start in range(len(normalized)):
        for unit_length in range(1, max_unit_length + 1):
            cursor = start + unit_length
            if cursor + unit_length * (_MIN_REPETITION_COUNT - 1) > len(normalized):
                continue
            unit = normalized[start:cursor]
            repetitions = 1
            while normalized[cursor : cursor + unit_length] == unit:
                repetitions += 1
                cursor += unit_length
            repeated_characters = repetitions * unit_length
            if (
                repetitions >= _MIN_REPETITION_COUNT
                and repeated_characters >= _MIN_REPETITION_CHARACTERS
                and repeated_characters / len(normalized) >= _MIN_REPETITION_RATIO
            ):
                return True
    return False


def _trim_turn_to_commit_range(
    turn: SpeakerTurn,
    window: RealtimeTranscriptionWindow,
) -> SpeakerTurn | None:
    if turn.words:
        retained_words = tuple(
            word
            for word in turn.words
            if (
                window.start_ms + seconds_to_ms(word.end_seconds) > window.commit_start_ms
                and window.start_ms + seconds_to_ms(word.start_seconds) < window.end_ms
            )
        )
        if not retained_words:
            return None
        text = "".join(word.text for word in retained_words).strip()
        if not text:
            return None
        scores = [
            word.confidence for word in retained_words if word.confidence is not None
        ]
        return SpeakerTurn(
            start_seconds=min(word.start_seconds for word in retained_words),
            end_seconds=max(word.end_seconds for word in retained_words),
            text=text,
            speaker=turn.speaker,
            confidence=fmean(scores) if scores else turn.confidence,
            words=retained_words,
        )

    global_start_ms = window.start_ms + seconds_to_ms(turn.start_seconds)
    global_end_ms = window.start_ms + seconds_to_ms(turn.end_seconds)
    if (
        global_start_ms < window.commit_start_ms
        or global_start_ms >= window.end_ms
        or global_end_ms <= window.commit_start_ms
    ):
        return None
    return turn


def _build_committed_turns(
    result: WhisperXResult,
    window: RealtimeTranscriptionWindow,
) -> list[SpeakerTurn]:
    accepted_segments = [
        segment
        for segment in result.segments
        if not _is_likely_repetitive_hallucination(segment.text)
    ]
    filtered_result = result.model_copy(update={"segments": accepted_segments})
    return [
        trimmed
        for turn in build_speaker_turns(filtered_result)
        if (trimmed := _trim_turn_to_commit_range(turn, window)) is not None
    ]


def _restore_chronological_sequences(db: Session, transcript_id: uuid.UUID) -> None:
    segments = list(
        db.scalars(
            select(TranscriptSegment)
            .where(TranscriptSegment.transcript_version_id == transcript_id)
            .order_by(
                TranscriptSegment.start_ms,
                TranscriptSegment.end_ms,
                TranscriptSegment.sequence,
            )
        )
    )
    if not segments:
        return
    temporary_base = max(segment.sequence for segment in segments) + len(segments) + 1
    for offset, segment in enumerate(segments):
        segment.sequence = temporary_base + offset
    db.flush()
    for sequence, segment in enumerate(segments):
        segment.sequence = sequence
    db.flush()


def _store_window_result(
    db: Session,
    transcript: TranscriptVersion,
    window: RealtimeTranscriptionWindow,
    result: WhisperXResult,
) -> bool:
    turns = []
    for turn in _build_committed_turns(result, window):
        start_ms = window.start_ms + seconds_to_ms(turn.start_seconds)
        end_ms = window.start_ms + seconds_to_ms(turn.end_seconds)
        start_ms = min(max(window.commit_start_ms, start_ms), window.end_ms)
        end_ms = min(max(start_ms, end_ms), window.end_ms)
        # The beginning of an overlap window is context.  Only a turn which
        # reaches the newly advanced range may replace or extend the transcript.
        if end_ms > window.commit_start_ms and end_ms > start_ms:
            turns.append((turn, start_ms, end_ms))

    # Silence is a valid result.  Most importantly, do not erase an earlier
    # transcript merely because the current window contains no speech.
    if not turns:
        return False

    has_later_segments = db.scalar(
        select(TranscriptSegment.id)
        .where(
            TranscriptSegment.transcript_version_id == transcript.id,
            TranscriptSegment.start_ms >= window.end_ms,
        )
        .limit(1)
    ) is not None
    db.execute(
        delete(TranscriptSegment).where(
            TranscriptSegment.transcript_version_id == transcript.id,
            TranscriptSegment.start_ms >= window.commit_start_ms,
            TranscriptSegment.start_ms < window.end_ms,
        )
    )
    db.flush()
    last_sequence = db.scalar(
        select(func.max(TranscriptSegment.sequence)).where(
            TranscriptSegment.transcript_version_id == transcript.id
        )
    )
    next_sequence = (last_sequence if last_sequence is not None else -1) + 1
    for offset, (turn, start_ms, end_ms) in enumerate(turns):
        segment = TranscriptSegment(
            transcript_version_id=transcript.id,
            start_ms=start_ms,
            end_ms=end_ms,
            provisional_speaker_label=turn.speaker,
            text=turn.text,
            confidence=turn.confidence,
            sequence=next_sequence + offset,
        )
        for word_sequence, word in enumerate(turn.words):
            word_start_ms = window.start_ms + seconds_to_ms(word.start_seconds)
            word_end_ms = window.start_ms + seconds_to_ms(word.end_seconds)
            segment.words.append(
                TranscriptWord(
                    start_ms=min(max(start_ms, word_start_ms), end_ms),
                    end_ms=min(max(start_ms, word_end_ms), end_ms),
                    text=word.text,
                    confidence=word.confidence,
                    sequence=word_sequence,
                )
            )
        db.add(segment)
    db.flush()
    if has_later_segments:
        _restore_chronological_sequences(db, transcript.id)
    return True


def process_live_transcription_job(
    db: Session,
    job: Job,
    client: TranscriptionClient,
    storage: MediaStorage,
    media_service: RealtimeWindowMediaService,
    *,
    window_ms: int | None = None,
    step_ms: int | None = None,
) -> None:
    if job.realtime_chunk_id is None:
        raise RuntimeError("Realtime ChunkがJobに設定されていません")
    chunk = db.get(RealtimeChunk, job.realtime_chunk_id)
    if chunk is None:
        raise RuntimeError("Realtime Chunkが見つかりません")
    realtime_session = db.get(RealtimeSession, chunk.session_id)
    if realtime_session is None:
        raise RuntimeError("Realtime Sessionが見つかりません")
    media = db.get(Media, realtime_session.media_id)
    meeting = db.get(Meeting, realtime_session.meeting_id)
    transcript = db.get(TranscriptVersion, realtime_session.transcript_version_id)
    if media is None or meeting is None or transcript is None:
        raise RuntimeError("Realtime文字起こしの入力が見つかりません")

    job_window_values = (
        job.realtime_window_start_ms,
        job.realtime_window_end_ms,
        job.realtime_commit_start_ms,
    )
    if all(value is not None for value in job_window_values):
        window_start_ms = job.realtime_window_start_ms
        window_end_ms = job.realtime_window_end_ms
        commit_start_ms = job.realtime_commit_start_ms
        assert window_start_ms is not None
        assert window_end_ms is not None
        assert commit_start_ms is not None
        windows = [
            RealtimeTranscriptionWindow(
                start_ms=window_start_ms,
                end_ms=window_end_ms,
                commit_start_ms=commit_start_ms,
            )
        ]
    elif any(value is not None for value in job_window_values):
        raise RuntimeError("Realtime Jobの時間範囲が不正です")
    else:
        # Jobs created before window-level scheduling remain retryable.
        effective_window_ms = window_ms or max(1, chunk.end_ms - chunk.window_start_ms)
        effective_step_ms = step_ms or max(1, chunk.end_ms - chunk.start_ms)
        windows = build_realtime_transcription_windows(
            chunk,
            window_ms=effective_window_ms,
            step_ms=effective_step_ms,
        )

    job.progress = 10
    db.commit()
    transcript_changed = False
    with tempfile.TemporaryDirectory(prefix="speak-note-live-") as temporary_directory:
        temporary_root = Path(temporary_directory)
        source_storage_path = realtime_session.audio_storage_path or media.storage_path
        snapshot_path = temporary_root / Path(source_storage_path).name
        shutil.copyfile(storage.absolute_path(source_storage_path), snapshot_path)
        for index, window in enumerate(windows):
            transcription_window = window
            if not getattr(client, "supports_overlap_context", True):
                # Azure's short-audio REST response has utterance timing but no
                # word timing. Send only the newly committed range so overlap
                # context cannot duplicate or hide an entire utterance.
                transcription_window = RealtimeTranscriptionWindow(
                    start_ms=window.commit_start_ms,
                    end_ms=window.end_ms,
                    commit_start_ms=window.commit_start_ms,
                )
            audio_path = temporary_root / f"window-{index}.wav"
            media_service.extract_audio_window(
                snapshot_path,
                audio_path,
                start_ms=transcription_window.start_ms,
                end_ms=transcription_window.end_ms,
            )
            job.progress = min(90, 20 + round((index / len(windows)) * 70))
            db.commit()
            try:
                result = client.transcribe(
                    audio_path,
                    "audio/wav",
                    min_speakers=meeting.min_speakers,
                    max_speakers=meeting.max_speakers,
                )
            except WhisperXEmptyAudioError:
                # A captured time range can legitimately contain no encoded
                # audio (silence, a muted source, or a delayed MediaRecorder).
                # Record it as a silent window so later overlapping windows can
                # recover normally without erasing already stored transcript.
                result = WhisperXResult.model_validate({
                    "segments": [],
                    "status": "no_audio",
                })
            transcript_changed = (
                _store_window_result(db, transcript, transcription_window, result)
                or transcript_changed
            )
            previous_latest_end_ms = (
                transcript.raw_response.get("latest_window_end_ms", -1)
                if transcript.raw_response is not None
                else -1
            )
            if not isinstance(previous_latest_end_ms, int):
                previous_latest_end_ms = -1
            if window.end_ms >= previous_latest_end_ms:
                transcript.raw_response = {
                    "latest_window_start_ms": transcription_window.start_ms,
                    "latest_window_end_ms": transcription_window.end_ms,
                    realtime_session.transcription_provider: result.raw_response,
                }
            job.progress = min(94, 20 + round(((index + 1) / len(windows)) * 74))
            # Commit each catch-up window so a temporary failure later in a long
            # chunk does not discard already recovered transcript ranges.
            db.commit()

    job.progress = 95
    db.commit()
    db.refresh(realtime_session)
    if transcript_changed and realtime_session.status == RealtimeSessionStatus.RECORDING:
        schedule_realtime_analysis(db, realtime_session)

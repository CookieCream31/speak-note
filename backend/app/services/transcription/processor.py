from decimal import ROUND_HALF_UP, Decimal

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models.job import Job
from app.models.media import Media, MediaKind
from app.models.meeting import Meeting, MeetingStatus
from app.models.speaker import Speaker
from app.models.transcript import (
    TranscriptKind,
    TranscriptSegment,
    TranscriptStatus,
    TranscriptVersion,
    TranscriptWord,
)
from app.services.analysis import AnalysisProcessingError, create_analysis_job
from app.services.analysis.processor import find_completed_final
from app.services.analysis.regeneration import ensure_capture_stopped, lock_meeting
from app.services.media import MediaStorage
from app.services.transcription.client import WhisperXClient, WhisperXError
from app.services.transcription.schemas import WhisperXResult
from app.services.transcription.speaker_turns import build_speaker_turns


def seconds_to_ms(seconds: float) -> int:
    return max(0, int((Decimal(str(seconds)) * 1000).quantize(Decimal("1"), ROUND_HALF_UP)))


def create_final_transcript_from_result(
    session: Session,
    meeting: Meeting,
    result: WhisperXResult,
    *,
    model: str,
    language: str,
) -> TranscriptVersion:
    speaker_turns = build_speaker_turns(result)
    if not speaker_turns:
        raise WhisperXError("WhisperXの応答に文字起こし区間がありません")

    current_version = session.scalar(
        select(func.max(TranscriptVersion.version)).where(
            TranscriptVersion.meeting_id == meeting.id,
            TranscriptVersion.kind == TranscriptKind.FINAL,
        )
    )
    transcript = TranscriptVersion(
        meeting_id=meeting.id,
        version=(current_version or 0) + 1,
        kind=TranscriptKind.FINAL,
        status=TranscriptStatus.COMPLETED,
        language=language,
        model=model,
        diarization_enabled=True,
        raw_response=result.raw_response,
    )
    session.add(transcript)

    speaker_by_name: dict[str, Speaker] = {
        speaker.internal_name: speaker
        for speaker in session.scalars(select(Speaker).where(Speaker.meeting_id == meeting.id))
    }
    duration_ms = 0
    for sequence, turn in enumerate(speaker_turns):
        speaker = None
        if turn.speaker:
            speaker = speaker_by_name.get(turn.speaker)
            if speaker is None:
                speaker = Speaker(meeting_id=meeting.id, internal_name=turn.speaker)
                session.add(speaker)
                speaker_by_name[turn.speaker] = speaker

        start_ms = seconds_to_ms(turn.start_seconds)
        end_ms = max(start_ms, seconds_to_ms(turn.end_seconds))
        duration_ms = max(duration_ms, end_ms)
        segment = TranscriptSegment(
            start_ms=start_ms,
            end_ms=end_ms,
            speaker=speaker,
            text=turn.text,
            confidence=turn.confidence,
            sequence=sequence,
        )
        for word_sequence, word in enumerate(turn.words):
            word_start_ms = seconds_to_ms(word.start_seconds)
            segment.words.append(
                TranscriptWord(
                    start_ms=word_start_ms,
                    end_ms=max(word_start_ms, seconds_to_ms(word.end_seconds)),
                    speaker=speaker,
                    text=word.text,
                    confidence=word.confidence,
                    sequence=word_sequence,
                )
            )
        transcript.segments.append(segment)

    session.flush()
    meeting.active_transcript_version_id = transcript.id
    meeting.duration_ms = max(meeting.duration_ms or 0, duration_ms)
    meeting.status = MeetingStatus.COMPLETED
    return transcript


def process_transcription_job(
    session: Session,
    job: Job,
    client: WhisperXClient,
    storage: MediaStorage,
) -> None:
    meeting = session.get(Meeting, job.meeting_id)
    if meeting is None:
        raise RuntimeError("Meeting no longer exists")
    ensure_capture_stopped(session, meeting)
    if job.analysis_request is not None and find_completed_final(session, meeting) is not None:
        _continue_regeneration(session, job, meeting)
        return
    media = session.scalar(
        select(Media).where(
            Media.meeting_id == meeting.id,
            Media.kind == MediaKind.TRANSCRIPTION_AUDIO,
        )
    )
    if media is None:
        media = session.scalar(
            select(Media).where(
                Media.meeting_id == meeting.id,
                Media.kind == MediaKind.ORIGINAL_AUDIO,
            )
        )
    if media is None:
        raise RuntimeError("Transcription audio is missing")

    meeting.status = MeetingStatus.TRANSCRIBING
    job.progress = 10
    session.commit()

    result = client.transcribe(
        storage.absolute_path(media.storage_path),
        media.mime_type,
        min_speakers=meeting.min_speakers,
        max_speakers=meeting.max_speakers,
    )
    create_final_transcript_from_result(
        session,
        meeting,
        result,
        model=client.model,
        language=client.language,
    )
    job.progress = 95
    session.commit()

    if job.analysis_request is not None:
        _continue_regeneration(session, job, meeting)
    elif not meeting.ai_disabled:
        try:
            create_analysis_job(session, meeting)
        except AnalysisProcessingError:
            session.rollback()


def _continue_regeneration(session: Session, job: Job, meeting: Meeting) -> None:
    meeting = lock_meeting(session, meeting)
    ensure_capture_stopped(session, meeting)
    request = job.analysis_request
    if request is None:
        raise AnalysisProcessingError("再生成設定がありません")
    if request.get("analysis_job_id") is not None:
        return
    _, analysis_job = create_analysis_job(session, meeting, frozen_request=request, commit=False)
    job.analysis_request = {**request, "analysis_job_id": str(analysis_job.id)}
    job.progress = 95
    session.commit()

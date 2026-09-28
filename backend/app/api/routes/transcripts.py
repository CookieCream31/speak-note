import uuid
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, status
from fastapi.responses import PlainTextResponse
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.api.dependencies import DbSession, MeetingDep
from app.models.job import Job, JobStatus, JobType
from app.models.media import Media, MediaKind
from app.models.meeting import MeetingSourceType, MeetingStatus
from app.models.realtime import RealtimeSession, RealtimeSessionStatus
from app.models.speaker import Speaker
from app.models.transcript import (
    TranscriptKind,
    TranscriptSegment,
    TranscriptStatus,
    TranscriptVersion,
)
from app.schemas.job import JobRead
from app.schemas.transcript import (
    SpeakerRead,
    SpeakerUpdate,
    TranscriptSegmentRead,
    TranscriptSegmentUpdate,
    TranscriptVersionRead,
)
from app.services.transcription import create_final_transcript_from_result
from app.services.transcription.schemas import WhisperXResult

router = APIRouter(prefix="/meetings", tags=["transcripts"])


def load_active_transcript(
    meeting_id: uuid.UUID, transcript_id: uuid.UUID, session: DbSession
) -> TranscriptVersion | None:
    return session.scalar(
        select(TranscriptVersion)
        .options(
            selectinload(TranscriptVersion.segments).selectinload(TranscriptSegment.speaker),
            selectinload(TranscriptVersion.segments).selectinload(TranscriptSegment.words),
        )
        .where(
            TranscriptVersion.id == transcript_id,
            TranscriptVersion.meeting_id == meeting_id,
            TranscriptVersion.status == TranscriptStatus.COMPLETED,
        )
    )


def _format_download_timestamp(milliseconds: int) -> str:
    total_seconds = milliseconds // 1000
    hours, remainder = divmod(total_seconds, 3600)
    minutes, seconds = divmod(remainder, 60)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}"


def _render_transcript_text(title: str, transcript: TranscriptVersion) -> str:
    lines = [title.strip(), ""]
    for segment in transcript.segments:
        speaker = "話者不明"
        if segment.speaker is not None:
            speaker = segment.speaker.display_name or segment.speaker.internal_name
        elif segment.provisional_speaker_label:
            speaker = segment.provisional_speaker_label
        lines.extend(
            [
                f"[{_format_download_timestamp(segment.start_ms)}] {speaker}",
                segment.text.strip(),
                "",
            ]
        )
    return "\n".join(lines).rstrip() + "\n"


def select_view_transcript(
    meeting: MeetingDep, session: DbSession, kind: TranscriptKind | None = None
) -> TranscriptVersion | None:
    if kind != TranscriptKind.LIVE and meeting.active_transcript_version_id is not None:
        active = load_active_transcript(meeting.id, meeting.active_transcript_version_id, session)
        if active is not None and (kind is None or active.kind == kind):
            return active
    if kind == TranscriptKind.FINAL:
        return None
    capture = session.scalar(
        select(RealtimeSession)
        .where(RealtimeSession.meeting_id == meeting.id)
        .order_by(RealtimeSession.started_at.desc())
        .limit(1)
    )
    if capture is None or capture.status != RealtimeSessionStatus.COMPLETED:
        return None
    return load_active_transcript(meeting.id, capture.transcript_version_id, session)


@router.get("/{meeting_id}/transcript", response_model=TranscriptVersionRead)
def get_active_transcript(
    meeting: MeetingDep, session: DbSession, kind: TranscriptKind | None = None
) -> TranscriptVersion:
    transcript = select_view_transcript(meeting, session, kind)
    if transcript is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Transcript not found")
    return transcript


@router.post(
    "/{meeting_id}/transcript",
    response_model=JobRead,
    status_code=status.HTTP_202_ACCEPTED,
)
def start_final_transcription(meeting: MeetingDep, session: DbSession) -> Job:
    # Explicit transcript reprocessing is separate from summary regeneration.
    from app.services.analysis.regeneration import lock_meeting

    meeting = lock_meeting(session, meeting)
    if meeting.source_type not in {
        MeetingSourceType.LIVE,
        MeetingSourceType.AUDIO_RECORDING,
    }:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="この操作はリアルタイム録音・録画でのみ使用できます",
        )
    active_capture = session.scalar(
        select(RealtimeSession.id).where(
            RealtimeSession.meeting_id == meeting.id,
            RealtimeSession.status.in_(
                (RealtimeSessionStatus.RECORDING, RealtimeSessionStatus.FINALIZING)
            ),
        )
    )
    if active_capture is not None:
        raise HTTPException(
            status_code=409, detail="録音・録画を停止してから高精度版を開始してください"
        )
    transcription_audio = session.scalar(
        select(Media.id).where(
            Media.meeting_id == meeting.id,
            Media.kind.in_(
                (MediaKind.TRANSCRIPTION_AUDIO, MediaKind.ORIGINAL_AUDIO)
                if meeting.source_type == MeetingSourceType.AUDIO_RECORDING
                else (MediaKind.TRANSCRIPTION_AUDIO,)
            ),
        )
    )
    if transcription_audio is None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                "録音の保存が完了してから確定版を開始してください"
                if meeting.source_type == MeetingSourceType.AUDIO_RECORDING
                else "動画変換が完了してから確定版を開始してください"
            ),
        )
    active_job = session.scalar(
        select(Job.id)
        .where(
            Job.meeting_id == meeting.id,
            Job.type.in_((JobType.TRANSCRIBE, JobType.ANALYZE)),
            Job.status.in_((JobStatus.QUEUED, JobStatus.RUNNING)),
        )
        .limit(1)
    )
    if active_job is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="確定版の文字起こしまたはAI解析はすでに処理中です",
        )

    job = Job(meeting_id=meeting.id, type=JobType.TRANSCRIBE, progress=0)
    meeting.status = MeetingStatus.QUEUED
    session.add(job)
    session.commit()
    session.refresh(job)
    return job


@router.get(
    "/{meeting_id}/transcript/download",
    response_class=PlainTextResponse,
)
def download_active_transcript(
    meeting: MeetingDep,
    session: DbSession,
    kind: TranscriptKind | None = None,
) -> PlainTextResponse:
    transcript = select_view_transcript(meeting, session, kind)
    if transcript is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Transcript not found")

    download_name = f"{meeting.title.strip() or 'meeting'}-transcript.txt"
    encoded_name = quote(download_name, safe="")
    return PlainTextResponse(
        _render_transcript_text(meeting.title, transcript),
        headers={
            "Content-Disposition": (
                f'attachment; filename="transcript-{meeting.id}.txt"; '
                f"filename*=UTF-8''{encoded_name}"
            ),
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.post(
    "/{meeting_id}/transcript/rebuild-speaker-turns",
    response_model=TranscriptVersionRead,
)
def rebuild_speaker_turns(meeting: MeetingDep, session: DbSession) -> TranscriptVersion:
    if meeting.active_transcript_version_id is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Transcript not found")
    source = session.get(TranscriptVersion, meeting.active_transcript_version_id)
    if source is None or source.raw_response is None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Raw WhisperX response is not available",
        )
    try:
        result = WhisperXResult.model_validate(source.raw_response)
        transcript = create_final_transcript_from_result(
            session,
            meeting,
            result,
            model=source.model,
            language=source.language,
        )
        session.commit()
    except ValidationError as exc:
        session.rollback()
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Raw WhisperX response is invalid",
        ) from exc
    except Exception:
        session.rollback()
        raise

    rebuilt = load_active_transcript(meeting.id, transcript.id, session)
    if rebuilt is None:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Rebuilt transcript could not be loaded",
        )
    return rebuilt


@router.get("/{meeting_id}/speakers", response_model=list[SpeakerRead])
def list_speakers(meeting: MeetingDep, session: DbSession) -> list[Speaker]:
    return list(
        session.scalars(
            select(Speaker).where(Speaker.meeting_id == meeting.id).order_by(Speaker.internal_name)
        )
    )


@router.patch("/{meeting_id}/speakers/{speaker_id}", response_model=SpeakerRead)
def update_speaker(
    speaker_id: uuid.UUID,
    payload: SpeakerUpdate,
    meeting: MeetingDep,
    session: DbSession,
) -> Speaker:
    speaker = session.scalar(
        select(Speaker).where(Speaker.id == speaker_id, Speaker.meeting_id == meeting.id)
    )
    if speaker is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Speaker not found")
    speaker.display_name = payload.display_name.strip() if payload.display_name else None
    session.commit()
    session.refresh(speaker)
    return speaker


@router.patch(
    "/{meeting_id}/transcript/segments/{segment_id}", response_model=TranscriptSegmentRead
)
def update_segment(
    segment_id: uuid.UUID,
    payload: TranscriptSegmentUpdate,
    meeting: MeetingDep,
    session: DbSession,
) -> TranscriptSegment:
    segment = session.scalar(
        select(TranscriptSegment)
        .join(TranscriptVersion)
        .options(
            selectinload(TranscriptSegment.speaker),
            selectinload(TranscriptSegment.words),
        )
        .where(
            TranscriptSegment.id == segment_id,
            TranscriptVersion.meeting_id == meeting.id,
        )
    )
    if segment is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Segment not found")
    segment.text = payload.text.strip()
    segment.words.clear()
    session.commit()
    session.refresh(segment)
    return segment

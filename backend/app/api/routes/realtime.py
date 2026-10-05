import uuid
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, WebSocket, WebSocketDisconnect, status
from fastapi.concurrency import run_in_threadpool
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.api.dependencies import DbSession, get_storage
from app.core.config import Settings, get_settings
from app.db.session import get_db
from app.models.meeting import Meeting
from app.models.realtime import RealtimeSession, RealtimeSessionStatus, RealtimeVideoPart
from app.models.realtime_analysis import RealtimeAnalysisState
from app.models.transcript import TranscriptSegment, TranscriptVersion
from app.schemas.realtime import RealtimeSessionRead
from app.schemas.realtime_analysis import (
    RealtimeAnalysisOutput,
    RealtimeAnalysisRead,
    RealtimeEvidenceRead,
)
from app.schemas.transcript import TranscriptSegmentRead
from app.schemas.transcription_settings import RealtimeTranscriptionTokenRead
from app.services.media import MediaStorage
from app.services.realtime import (
    RealtimeCaptureError,
    append_realtime_chunk,
    append_realtime_video_chunk,
    append_streaming_transcript_segment,
    close_interrupted_realtime_session,
    finalize_realtime_session,
    finish_realtime_video_part,
    resume_realtime_session,
    start_realtime_session,
    start_realtime_video_part,
)
from app.services.transcription.azure import AzureSpeechClient, AzureSpeechError
from app.services.transcription.settings import (
    RealtimeTranscriptionConfigurationError,
    build_realtime_transcription_client,
    resolve_realtime_transcription,
)

router = APIRouter(prefix="/meetings/{meeting_id}/live", tags=["realtime"])


def _load_latest_session(db: Session, meeting_id: uuid.UUID) -> RealtimeSession | None:
    return db.scalar(
        select(RealtimeSession)
        .where(RealtimeSession.meeting_id == meeting_id)
        .order_by(RealtimeSession.started_at.desc())
        .limit(1)
    )


def _serialize_realtime_analysis(
    db: Session, realtime_session: RealtimeSession
) -> RealtimeAnalysisRead | None:
    state = db.scalar(
        select(RealtimeAnalysisState).where(
            RealtimeAnalysisState.realtime_session_id == realtime_session.id
        )
    )
    if state is None:
        return None
    snapshot = (
        RealtimeAnalysisOutput.model_validate(state.snapshot)
        if state.snapshot is not None
        else None
    )
    return RealtimeAnalysisRead(
        status=state.status,
        input_revision=state.input_revision,
        processed_revision=state.processed_revision,
        analyzed_through_ms=state.analyzed_through_ms,
        model=state.model,
        error_message=state.error_message,
        updated_at=state.updated_at,
        completed_at=state.completed_at,
        snapshot=snapshot,
        evidence=[
            RealtimeEvidenceRead.model_validate(item) for item in (state.source_segments or [])
        ],
    )


def _serialize_session(db: Session, realtime_session: RealtimeSession) -> RealtimeSessionRead:
    transcript = db.scalar(
        select(TranscriptVersion)
        .where(TranscriptVersion.id == realtime_session.transcript_version_id)
        .options(
            selectinload(TranscriptVersion.segments).selectinload(TranscriptSegment.speaker),
            selectinload(TranscriptVersion.segments).selectinload(TranscriptSegment.words),
        )
    )
    if transcript is None:
        raise RealtimeCaptureError("Live Transcriptが見つかりません")
    return RealtimeSessionRead(
        id=realtime_session.id,
        status=realtime_session.status,
        has_system_audio=realtime_session.has_system_audio,
        transcription_provider=realtime_session.transcription_provider,
        transcription_region=realtime_session.transcription_region,
        chunk_count=realtime_session.chunk_count,
        received_bytes=realtime_session.received_bytes,
        duration_ms=realtime_session.duration_ms,
        started_at=realtime_session.started_at,
        ended_at=realtime_session.ended_at,
        transcript_status=transcript.status.value,
        segments=[TranscriptSegmentRead.model_validate(segment) for segment in transcript.segments],
    )


@router.get("", response_model=RealtimeSessionRead)
def get_live_session(meeting_id: uuid.UUID, db: DbSession) -> RealtimeSessionRead:
    meeting = db.get(Meeting, meeting_id)
    if meeting is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Meeting not found")
    realtime_session = _load_latest_session(db, meeting_id)
    if realtime_session is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Live session not found")
    return _serialize_session(db, realtime_session)


@router.get("/analysis", response_model=RealtimeAnalysisRead | None)
def get_live_analysis(meeting_id: uuid.UUID, db: DbSession) -> RealtimeAnalysisRead | None:
    meeting = db.get(Meeting, meeting_id)
    if meeting is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Meeting not found")
    realtime_session = _load_latest_session(db, meeting_id)
    if realtime_session is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Live session not found")
    return _serialize_realtime_analysis(db, realtime_session)


@router.post("/azure-token", response_model=RealtimeTranscriptionTokenRead)
def issue_azure_speech_token(
    meeting_id: uuid.UUID,
    db: DbSession,
) -> RealtimeTranscriptionTokenRead:
    meeting = db.get(Meeting, meeting_id)
    if meeting is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Meeting not found")
    realtime_session = _load_latest_session(db, meeting_id)
    if (
        realtime_session is None
        or realtime_session.status != RealtimeSessionStatus.RECORDING
        or realtime_session.transcription_provider != "azure_speech"
    ):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Azure AI Speechを使用中の録音セッションがありません",
        )
    try:
        client = build_realtime_transcription_client(db, realtime_session, get_settings())
    except RealtimeTranscriptionConfigurationError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(exc),
        ) from exc
    if not isinstance(client, AzureSpeechClient):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="Azure AI Speechは未使用です"
        )
    try:
        token = client.issue_token()
    except AzureSpeechError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc
    return RealtimeTranscriptionTokenRead(
        token=token,
        region=client.region,
        language=client.language,
    )


def _integer(message: dict[str, Any], field: str) -> int:

    value = message.get(field)
    if isinstance(value, bool) or not isinstance(value, int):
        raise RealtimeCaptureError(f"{field}は整数で指定してください")
    return value


def _optional_number(message: dict[str, Any], field: str) -> float | None:
    value = message.get(field)
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise RealtimeCaptureError(f"{field}は数値で指定してください")
    return float(value)


def _get_video_part(
    db: Session, realtime_session: RealtimeSession, part_sequence: int
) -> RealtimeVideoPart:
    part = db.scalar(
        select(RealtimeVideoPart).where(
            RealtimeVideoPart.session_id == realtime_session.id,
            RealtimeVideoPart.sequence == part_sequence,
        )
    )
    if part is None:
        raise RealtimeCaptureError("映像Partが見つかりません")
    return part


# Close codes a browser sends when the user ends the page or recorder on purpose.
# Anything else (network loss, server restart) keeps the session resumable.
_INTENTIONAL_CLOSE_CODES = frozenset({1000, 1001, 1005})


async def _open_session(
    websocket: WebSocket,
    db: Session,
    storage: MediaStorage,
    meeting_id: uuid.UUID,
    settings: Settings,
) -> RealtimeSession:
    first_message = await websocket.receive_json()
    if not isinstance(first_message, dict) or first_message.get("type") not in {
        "start",
        "resume",
    }:
        raise RealtimeCaptureError("最初にstartメッセージを送信してください")
    if first_message["type"] == "resume":
        try:
            session_id = uuid.UUID(str(first_message.get("session_id")))
        except ValueError as exc:
            raise RealtimeCaptureError("再開する録音セッションIDが不正です") from exc
        resumed = await run_in_threadpool(resume_realtime_session, db, meeting_id, session_id)
        await websocket.send_json(
            {
                "type": "resumed",
                "session_id": str(resumed.id),
                "chunk_ms": settings.realtime_chunk_ms,
                "transcription_provider": resumed.transcription_provider,
                "duration_ms": resumed.duration_ms,
            }
        )
        return resumed

    split_capture = first_message.get("capture_mode") == "split"
    mime_type = (
        first_message.get("video_mime_type") if split_capture else first_message.get("mime_type")
    )
    audio_mime_type = first_message.get("audio_mime_type") if split_capture else None
    has_system_audio = first_message.get("has_system_audio")
    if (
        not isinstance(mime_type, str)
        or not isinstance(has_system_audio, bool)
        or (split_capture and not isinstance(audio_mime_type, str))
    ):
        raise RealtimeCaptureError("startメッセージの形式が不正です")

    def start() -> tuple[RealtimeSession, str]:
        meeting = db.get(Meeting, meeting_id)
        if meeting is None:
            raise RealtimeCaptureError("会議が見つかりません")
        try:
            provider, model, language, region = resolve_realtime_transcription(db, settings)
        except RealtimeTranscriptionConfigurationError as exc:
            raise RealtimeCaptureError(str(exc)) from exc
        started = start_realtime_session(
            db,
            meeting,
            storage,
            mime_type=mime_type,
            has_system_audio=has_system_audio,
            model=model,
            language=language,
            transcription_provider=provider.value,
            transcription_region=region,
            split_capture=split_capture,
            audio_mime_type=audio_mime_type,
        )
        return started, language

    # The DB session and file writes are synchronous. Run them in the thread
    # pool so one recording never blocks other requests on the event loop.
    started_session, language = await run_in_threadpool(start)
    await websocket.send_json(
        {
            "type": "started",
            "session_id": str(started_session.id),
            "chunk_ms": settings.realtime_chunk_ms,
            "transcription_provider": started_session.transcription_provider,
            "transcription_region": started_session.transcription_region,
            "transcription_language": language,
        }
    )
    return started_session


@router.websocket("/ws")
async def realtime_websocket(
    websocket: WebSocket,
    meeting_id: uuid.UUID,
    db: Annotated[Session, Depends(get_db)],
    storage: Annotated[MediaStorage, Depends(get_storage)],
) -> None:
    await websocket.accept()
    realtime_session: RealtimeSession | None = None
    stopped_normally = False
    close_immediately = False
    settings = get_settings()
    try:
        realtime_session = await _open_session(websocket, db, storage, meeting_id, settings)

        while True:
            message = await websocket.receive_json()
            if not isinstance(message, dict):
                raise RealtimeCaptureError("メッセージ形式が不正です")
            message_type = message.get("type")
            if message_type == "ping":
                await websocket.send_json({"type": "pong"})
                continue
            if message_type == "azure_result":
                result_id = message.get("result_id")
                text = message.get("text")
                speaker_label = message.get("speaker_label")
                if not isinstance(result_id, str) or not isinstance(text, str):
                    raise RealtimeCaptureError("Azure認識結果の形式が不正です")
                if speaker_label is not None and not isinstance(speaker_label, str):
                    raise RealtimeCaptureError("Azure認識結果の話者ラベル形式が不正です")
                segment = await run_in_threadpool(
                    append_streaming_transcript_segment,
                    db,
                    realtime_session,
                    result_id=result_id,
                    start_ms=_integer(message, "start_ms"),
                    end_ms=_integer(message, "end_ms"),
                    text=text,
                    speaker_label=speaker_label,
                    confidence=_optional_number(message, "confidence"),
                )
                await websocket.send_json(
                    {
                        "type": "azure_result_saved",
                        "result_id": result_id,
                        "segment_id": str(segment.id),
                    }
                )
                continue
            if message_type in {"chunk", "audio_chunk"}:
                if message_type == "chunk" and realtime_session.split_capture:
                    raise RealtimeCaptureError("分離録画ではaudio_chunkを使用してください")
                if message_type == "audio_chunk" and not realtime_session.split_capture:
                    raise RealtimeCaptureError("この録画セッションは分離録画ではありません")
                content = await websocket.receive_bytes()
                chunk = await run_in_threadpool(
                    append_realtime_chunk,
                    db,
                    realtime_session,
                    storage,
                    sequence=_integer(message, "sequence"),
                    start_ms=_integer(message, "start_ms"),
                    end_ms=_integer(message, "end_ms"),
                    content=content,
                    window_ms=settings.realtime_window_ms,
                    step_ms=settings.realtime_chunk_ms,
                    max_chunk_bytes=settings.realtime_max_chunk_mb * 1024 * 1024,
                )
                await websocket.send_json(
                    {
                        "type": (
                            "audio_chunk_saved" if message_type == "audio_chunk" else "chunk_saved"
                        ),
                        "sequence": chunk.sequence,
                        "end_ms": chunk.end_ms,
                    }
                )
                continue
            if message_type == "video_part_start":
                started_part = await run_in_threadpool(
                    start_realtime_video_part,
                    db,
                    realtime_session,
                    storage,
                    sequence=_integer(message, "part_sequence"),
                    start_ms=_integer(message, "start_ms"),
                    mime_type=str(message.get("mime_type", "")),
                )
                await websocket.send_json(
                    {
                        "type": "video_part_started",
                        "part_sequence": started_part.sequence,
                    }
                )
                continue
            if message_type == "video_chunk":
                part = await run_in_threadpool(
                    _get_video_part, db, realtime_session, _integer(message, "part_sequence")
                )
                chunk_sequence = _integer(message, "chunk_sequence")
                content = await websocket.receive_bytes()
                part = await run_in_threadpool(
                    append_realtime_video_chunk,
                    db,
                    realtime_session,
                    part,
                    storage,
                    sequence=chunk_sequence,
                    content=content,
                    max_chunk_bytes=settings.realtime_max_chunk_mb * 1024 * 1024,
                )
                await websocket.send_json(
                    {
                        "type": "video_chunk_saved",
                        "part_sequence": part.sequence,
                        "chunk_sequence": chunk_sequence,
                    }
                )
                continue
            if message_type == "video_part_end":
                part = await run_in_threadpool(
                    _get_video_part, db, realtime_session, _integer(message, "part_sequence")
                )
                part = await run_in_threadpool(
                    finish_realtime_video_part,
                    db,
                    realtime_session,
                    part,
                    end_ms=_integer(message, "end_ms"),
                )
                await websocket.send_json(
                    {
                        "type": "video_part_finished",
                        "part_sequence": part.sequence,
                        "end_ms": part.end_ms,
                    }
                )
                continue
            if message_type == "stop":
                job = await run_in_threadpool(finalize_realtime_session, db, realtime_session)
                stopped_normally = True
                await websocket.send_json(
                    {
                        "type": "finalized",
                        "job_id": str(job.id) if job is not None else None,
                        "duration_ms": realtime_session.duration_ms,
                    }
                )
                await websocket.close(code=1000)
                return
            raise RealtimeCaptureError("未対応のメッセージです")
    except WebSocketDisconnect as exc:
        close_immediately = exc.code in _INTENTIONAL_CLOSE_CODES
    except RealtimeCaptureError as exc:
        close_immediately = True
        if websocket.client_state.name == "CONNECTED":
            await websocket.send_json({"type": "error", "message": str(exc)})
            await websocket.close(code=1008)
    finally:
        if (
            realtime_session is not None
            and not stopped_normally
            and close_immediately
            and realtime_session.status == RealtimeSessionStatus.RECORDING
        ):
            await run_in_threadpool(
                close_interrupted_realtime_session, db, realtime_session, storage
            )
        # Otherwise the session stays "recording" so the client can resume it; the
        # live worker finalizes it if no data arrives within the resume timeout.

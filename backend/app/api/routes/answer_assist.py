import uuid
from typing import Any

from fastapi import APIRouter, HTTPException, Response
from sqlalchemy import select

from app.api.dependencies import DbSession, MeetingDep
from app.models.answer_assist import AnswerAssistSession, LiveAnswer
from app.models.transcript import TranscriptSegment
from app.schemas.answer_assist import (
    AnswerRead,
    AnswerRequest,
    AssistRead,
    AssistStart,
    MonitorSettings,
)
from app.services.knowledge.answer_assist import (
    AnswerAssistError,
    active_capture,
    request_answer,
    start_assistance,
)
from app.services.knowledge.answer_monitor import configure_monitor

router = APIRouter(prefix="/meetings/{meeting_id}/answer-assist", tags=["answer-assist"])


@router.get("/session", response_model=AssistRead | None)
def get_session(meeting: MeetingDep, session: DbSession) -> AnswerAssistSession | None:
    return session.scalar(
        select(AnswerAssistSession)
        .where(AnswerAssistSession.meeting_id == meeting.id)
        .order_by(AnswerAssistSession.created_at.desc())
        .limit(1)
    )


@router.post("/session", response_model=AssistRead, status_code=201)
def start(payload: AssistStart, meeting: MeetingDep, session: DbSession) -> AnswerAssistSession:
    try:
        return start_assistance(session, meeting, payload.profile_id, consent=payload.consent)
    except AnswerAssistError as exc:
        raise HTTPException(409, str(exc)) from exc


@router.delete("/session/{assist_id}", status_code=204)
def stop(assist_id: uuid.UUID, meeting: MeetingDep, session: DbSession) -> Response:
    assist = session.scalar(
        select(AnswerAssistSession)
        .where(AnswerAssistSession.id == assist_id, AnswerAssistSession.meeting_id == meeting.id)
        .with_for_update()
    )
    if assist is None:
        raise HTTPException(404, "回答支援セッションが見つかりません")
    assist.enabled = False
    session.commit()
    return Response(status_code=204)


@router.get("/feed")
def feed(meeting: MeetingDep, session: DbSession) -> dict[str, Any]:
    capture = active_capture(session, meeting.id)
    if capture is None:
        return {"capture_id": None, "segments": []}
    segments = session.scalars(
        select(TranscriptSegment)
        .where(TranscriptSegment.transcript_version_id == capture.transcript_version_id)
        .order_by(TranscriptSegment.start_ms.desc(), TranscriptSegment.sequence.desc())
        .limit(30)
    )
    return {
        "capture_id": str(capture.id),
        "segments": [
            {
                "id": str(segment.id),
                "text": segment.text,
                "start_ms": segment.start_ms,
                "speaker": segment.provisional_speaker_label
                or (str(segment.speaker_id) if segment.speaker_id else "unknown"),
            }
            for segment in segments
        ],
    }


@router.get("/answers", response_model=list[AnswerRead])
def answers(meeting: MeetingDep, session: DbSession) -> list[LiveAnswer]:
    return list(
        session.scalars(
            select(LiveAnswer)
            .where(LiveAnswer.meeting_id == meeting.id, LiveAnswer.status != "ignored")
            .order_by(LiveAnswer.created_at.desc())
            .limit(30)
        )
    )


@router.post("/answers", response_model=AnswerRead, status_code=202)
def create_answer(payload: AnswerRequest, meeting: MeetingDep, session: DbSession) -> LiveAnswer:
    try:
        return request_answer(
            session,
            meeting,
            payload.session_id,
            payload.request_id,
            payload.question,
            brevity=payload.brevity,
        )
    except AnswerAssistError as exc:
        raise HTTPException(409, str(exc)) from exc


@router.patch("/session/{assist_id}/automatic", response_model=AssistRead)
def automatic(
    assist_id: uuid.UUID, payload: MonitorSettings, meeting: MeetingDep, session: DbSession
) -> AnswerAssistSession:
    assist = session.scalar(
        select(AnswerAssistSession)
        .where(AnswerAssistSession.id == assist_id, AnswerAssistSession.meeting_id == meeting.id)
        .with_for_update()
    )
    if assist is None:
        raise HTTPException(404, "回答支援セッションが見つかりません")
    try:
        return configure_monitor(
            session, assist, enabled=payload.enabled, target_speaker=payload.target_speaker
        )
    except AnswerAssistError as exc:
        raise HTTPException(409, str(exc)) from exc

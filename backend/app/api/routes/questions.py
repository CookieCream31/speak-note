from fastapi import APIRouter, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.api.dependencies import DbSession, MeetingDep
from app.models.question import MeetingQuestion
from app.schemas.question import MeetingQuestionCreate, MeetingQuestionRead
from app.services.questions import MeetingQuestionError, create_meeting_question_job

router = APIRouter(prefix="/meetings", tags=["questions"])


@router.get("/{meeting_id}/questions", response_model=list[MeetingQuestionRead])
def list_meeting_questions(
    meeting: MeetingDep,
    session: DbSession,
) -> list[MeetingQuestion]:
    return list(
        session.scalars(
            select(MeetingQuestion)
            .options(selectinload(MeetingQuestion.evidence))
            .where(MeetingQuestion.meeting_id == meeting.id)
            .order_by(MeetingQuestion.created_at)
        )
    )


@router.post(
    "/{meeting_id}/questions",
    response_model=MeetingQuestionRead,
    status_code=status.HTTP_202_ACCEPTED,
)
def ask_meeting_question(
    payload: MeetingQuestionCreate,
    meeting: MeetingDep,
    session: DbSession,
) -> MeetingQuestion:
    try:
        question, _job = create_meeting_question_job(
            session,
            meeting,
            payload.question,
        )
    except MeetingQuestionError as exc:
        session.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    return question

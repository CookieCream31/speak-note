from fastapi import APIRouter, HTTPException, status

from app.api.dependencies import DbSession, MeetingDep
from app.models.ai import AIProfile
from app.schemas.ai import MeetingAISelection
from app.schemas.meeting import MeetingRead

router = APIRouter(prefix="/meetings", tags=["ai-settings"])


@router.patch("/{meeting_id}/ai-profile", response_model=MeetingRead)
def select_meeting_ai_profile(
    payload: MeetingAISelection,
    meeting: MeetingDep,
    session: DbSession,
) -> MeetingRead:
    if payload.mode == "none":
        meeting.ai_profile_id = None
        meeting.ai_disabled = True
    elif payload.mode == "default":
        meeting.ai_profile_id = None
        meeting.ai_disabled = False
    else:
        profile = session.get(AIProfile, payload.profile_id)
        if profile is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Profile not found",
            )
        meeting.ai_profile_id = profile.id
        meeting.ai_disabled = False
    session.commit()
    session.refresh(meeting)
    return MeetingRead.model_validate(meeting)

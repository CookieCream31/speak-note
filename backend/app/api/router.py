from fastapi import APIRouter

from app.api.routes import (
    ai_settings,
    analysis,
    answer_assist,
    health,
    jobs,
    knowledge,
    media_content,
    meeting_ai,
    meeting_templates,
    meetings,
    questions,
    realtime,
    tags,
    transcription_settings,
    transcripts,
)

api_router = APIRouter()
api_router.include_router(health.router)
api_router.include_router(meetings.router)
api_router.include_router(meeting_templates.router)
api_router.include_router(knowledge.router)
api_router.include_router(answer_assist.router)
api_router.include_router(questions.router)
api_router.include_router(tags.router)
api_router.include_router(meeting_ai.router)
api_router.include_router(jobs.router)
api_router.include_router(media_content.router)
api_router.include_router(transcripts.router)
api_router.include_router(transcription_settings.router)
api_router.include_router(realtime.router)
api_router.include_router(ai_settings.router)
api_router.include_router(analysis.router)

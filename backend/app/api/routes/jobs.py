import uuid

from fastapi import APIRouter, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.dependencies import DbSession
from app.core.config import get_settings
from app.models.job import Job, JobStatus, JobType
from app.models.meeting import Meeting, MeetingStatus
from app.models.question import MeetingQuestion, MeetingQuestionStatus
from app.models.realtime import RealtimeChunk
from app.schemas.job import JobRead
from app.services.jobs.meeting_status import AUXILIARY_JOB_TYPES
from app.services.realtime.windows import build_realtime_transcription_windows

router = APIRouter(prefix="/jobs", tags=["jobs"])


def get_job_or_404(job_id: uuid.UUID, session: Session) -> Job:
    job = session.get(Job, job_id)
    if job is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found")
    return job


@router.get("/{job_id}", response_model=JobRead)
def get_job(job_id: uuid.UUID, session: DbSession) -> Job:
    return get_job_or_404(job_id, session)


@router.post("/{job_id}/retry", response_model=JobRead)
def retry_job(job_id: uuid.UUID, session: DbSession) -> Job:
    job = get_job_or_404(job_id, session)
    if job.type == JobType.ASK_MEETING:
        from app.models.transcript import TranscriptVersion
        from app.services.analysis.regeneration import lock_meeting
        from app.services.questions.processor import (
            MeetingQuestionError,
            validate_question_transcript,
        )

        meeting = session.get(Meeting, job.meeting_id)
        question = session.scalar(select(MeetingQuestion).where(MeetingQuestion.job_id == job.id))
        transcript = (
            session.get(TranscriptVersion, question.transcript_version_id) if question else None
        )
        if meeting is None or transcript is None:
            raise HTTPException(status_code=409, detail="質問対象の原文が見つかりません")
        meeting = lock_meeting(session, meeting)
        session.refresh(job)
        try:
            validate_question_transcript(session, meeting, transcript)
        except MeetingQuestionError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        pending = session.scalar(
            select(MeetingQuestion.id)
            .where(
                MeetingQuestion.meeting_id == meeting.id,
                MeetingQuestion.status.in_(
                    [MeetingQuestionStatus.QUEUED, MeetingQuestionStatus.PROCESSING]
                ),
            )
            .limit(1)
        )
        if pending is not None:
            raise HTTPException(status_code=409, detail="前の質問への回答完了を待ってください")
    if job.type == JobType.GENERATE_THUMBNAILS:
        from app.services.media.thumbnails import latest_thumbnail_job, saved_playback_video

        meeting = session.scalar(
            select(Meeting).where(Meeting.id == job.meeting_id).with_for_update()
        )
        session.refresh(job)
        latest = latest_thumbnail_job(session, job.meeting_id)
        if meeting is None or saved_playback_video(session, meeting) is None:
            raise HTTPException(
                status_code=409, detail="録音・録画と動画変換の完了を待ってください"
            )
        if (
            latest is not None
            and latest.id != job.id
            and latest.status
            in {
                JobStatus.QUEUED,
                JobStatus.RUNNING,
            }
        ):
            raise HTTPException(status_code=409, detail="サムネイルはすでに処理中です")
    if job.type in (JobType.TRANSCRIBE, JobType.ANALYZE):
        from app.services.analysis.processor import AnalysisProcessingError
        from app.services.analysis.regeneration import (
            ensure_capture_stopped,
            ensure_no_final_job,
            lock_meeting,
        )

        meeting = session.get(Meeting, job.meeting_id)
        if meeting is not None:
            try:
                meeting = lock_meeting(session, meeting)
                session.refresh(job)
                ensure_capture_stopped(session, meeting)
                ensure_no_final_job(session, meeting)
            except AnalysisProcessingError as exc:
                session.rollback()
                raise HTTPException(status_code=409, detail=str(exc)) from exc
    if job.status != JobStatus.FAILED:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Only failed jobs can be retried",
        )
    if (
        job.type == JobType.TRANSCRIBE_LIVE
        and job.realtime_chunk_id is not None
        and job.realtime_window_start_ms is None
    ):
        chunk = session.get(RealtimeChunk, job.realtime_chunk_id)
        if chunk is None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Realtime Chunkが見つかりません",
            )
        settings = get_settings()
        windows = build_realtime_transcription_windows(
            chunk,
            window_ms=settings.realtime_window_ms,
            step_ms=settings.realtime_chunk_ms,
        )
        first_window, *remaining_windows = windows
        job.realtime_window_start_ms = first_window.start_ms
        job.realtime_window_end_ms = first_window.end_ms
        job.realtime_commit_start_ms = first_window.commit_start_ms
        session.add_all(
            [
                Job(
                    meeting_id=job.meeting_id,
                    realtime_chunk_id=job.realtime_chunk_id,
                    realtime_window_start_ms=window.start_ms,
                    realtime_window_end_ms=window.end_ms,
                    realtime_commit_start_ms=window.commit_start_ms,
                    type=JobType.TRANSCRIBE_LIVE,
                    progress=0,
                )
                for window in remaining_windows
            ]
        )
    job.status = JobStatus.QUEUED
    job.progress = None if job.type in {JobType.ANALYZE, JobType.ASK_MEETING} else 0
    job.error_message = None
    job.started_at = None
    job.finished_at = None
    if job.type == JobType.ASK_MEETING:
        question = session.scalar(select(MeetingQuestion).where(MeetingQuestion.job_id == job.id))
        if question is not None:
            question.status = MeetingQuestionStatus.QUEUED
            question.error_message = None
            question.completed_at = None
    meeting = session.get(Meeting, job.meeting_id)
    if meeting is not None and job.type not in AUXILIARY_JOB_TYPES:
        meeting.status = MeetingStatus.QUEUED
    session.commit()
    session.refresh(job)
    return job

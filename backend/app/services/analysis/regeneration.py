"""Reserve a final-only generation with immutable settings and a meeting lock."""

import uuid
from copy import deepcopy
from typing import Any

from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.ai import AIProviderConfig
from app.models.analysis import AnalysisVersion
from app.models.job import Job, JobStatus, JobType
from app.models.media import Media, MediaKind
from app.models.meeting import Meeting, MeetingStatus
from app.models.meeting_template import MeetingTemplate
from app.models.realtime import RealtimeSession, RealtimeSessionStatus
from app.schemas.analysis import AnalysisGenerateRequest
from app.schemas.meeting_template import TemplateDefinition
from app.services.analysis.processor import (
    AnalysisProcessingError,
    create_analysis_job,
    find_completed_final,
    resolve_analysis_profile,
)

FINAL_JOB_TYPES = (JobType.PREPROCESS_MEDIA, JobType.TRANSCRIBE, JobType.ANALYZE)


def lock_meeting(session: Session, meeting: Meeting) -> Meeting:
    locked = session.scalar(
        select(Meeting)
        .where(Meeting.id == meeting.id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if locked is None:
        raise AnalysisProcessingError("会議が見つかりません")
    return locked


def ensure_capture_stopped(session: Session, meeting: Meeting) -> None:
    if meeting.status == MeetingStatus.RECORDING:
        raise AnalysisProcessingError("録音・録画を停止してから要約を再生成してください")
    active = session.scalar(
        select(RealtimeSession.id)
        .where(
            RealtimeSession.meeting_id == meeting.id,
            RealtimeSession.status.in_(
                (RealtimeSessionStatus.RECORDING, RealtimeSessionStatus.FINALIZING)
            ),
        )
        .limit(1)
    )
    if active is not None:
        raise AnalysisProcessingError("録音・録画の停止と保存完了後に要約を再生成してください")


def ensure_no_final_job(session: Session, meeting: Meeting) -> None:
    active = session.scalar(
        select(Job.id)
        .where(
            Job.meeting_id == meeting.id,
            Job.type.in_(FINAL_JOB_TYPES),
            Job.status.in_((JobStatus.QUEUED, JobStatus.RUNNING)),
        )
        .limit(1)
    )
    if active is not None:
        raise AnalysisProcessingError("全体文字起こしまたは要約生成はすでに処理中です")


def build_analysis_request(
    session: Session,
    meeting: Meeting,
    profile_id: uuid.UUID | None = None,
    template_id: uuid.UUID | None = None,
    template_revision: int | None = None,
) -> dict[str, Any]:
    profile = resolve_analysis_profile(session, meeting, profile_id)
    provider = session.get(AIProviderConfig, profile.provider_id)
    if provider is None or not provider.enabled:
        raise AnalysisProcessingError("選択されたAI Providerが無効です")
    snapshot = deepcopy(meeting.template_snapshot)
    if template_id is not None:
        template = session.get(MeetingTemplate, template_id)
        if template is None:
            raise AnalysisProcessingError("議事録テンプレートが見つかりません")
        if template_revision is not None and template.revision != template_revision:
            raise AnalysisProcessingError(
                "テンプレートが更新されています。設定を開き直してください"
            )
        snapshot = {
            "template_id": str(template.id),
            "revision": template.revision,
            "name": template.name,
            "definition": deepcopy(template.definition),
        }
    if snapshot:
        try:
            TemplateDefinition.model_validate(snapshot["definition"])
        except (ValidationError, KeyError) as exc:
            raise AnalysisProcessingError("議事録テンプレートの定義が不正です") from exc
    return {
        "profile_id": str(profile.id),
        "provider_id": str(provider.id),
        "provider_type": provider.provider_type.value,
        "base_url": provider.base_url,
        "model": profile.model,
        "temperature": profile.temperature,
        "template_snapshot": snapshot,
    }


def regenerate_summary(
    session: Session,
    meeting: Meeting,
    payload: AnalysisGenerateRequest,
) -> tuple[AnalysisVersion | None, Job]:
    meeting = lock_meeting(session, meeting)
    if payload.request_id is not None:
        previous = session.scalar(select(Job).where(Job.request_id == payload.request_id))
        if previous is not None:
            if previous.meeting_id != meeting.id:
                raise AnalysisProcessingError("再生成リクエストIDが別の会議で使用されています")
            analysis = session.scalar(
                select(AnalysisVersion).where(AnalysisVersion.job_id == previous.id)
            )
            return analysis, previous
    ensure_capture_stopped(session, meeting)
    ensure_no_final_job(session, meeting)
    request = build_analysis_request(
        session, meeting, payload.profile_id, payload.template_id, payload.template_revision
    )
    if find_completed_final(session, meeting) is not None:
        analysis, job = create_analysis_job(session, meeting, frozen_request=request, commit=False)
    else:
        audio = session.scalar(
            select(Media.id)
            .where(
                Media.meeting_id == meeting.id,
                Media.kind.in_((MediaKind.TRANSCRIPTION_AUDIO, MediaKind.ORIGINAL_AUDIO)),
            )
            .limit(1)
        )
        if audio is None:
            raise AnalysisProcessingError("録音の保存または動画変換の完了を待ってください")
        job = Job(
            meeting_id=meeting.id, type=JobType.TRANSCRIBE, progress=0, analysis_request=request
        )
        session.add(job)
        meeting.status = MeetingStatus.QUEUED
        analysis = None
    job.request_id = payload.request_id
    session.commit()
    session.refresh(job)
    return analysis, job

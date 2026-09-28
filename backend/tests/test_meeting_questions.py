import uuid

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import get_settings
from app.models.ai import AIProfile, AIProviderConfig, AIProviderType
from app.models.job import Job, JobStatus, JobType
from app.models.meeting import Meeting, MeetingSourceType, MeetingStatus
from app.models.question import MeetingQuestion, MeetingQuestionStatus
from app.models.transcript import (
    TranscriptKind,
    TranscriptSegment,
    TranscriptStatus,
    TranscriptVersion,
)
from app.schemas.question import MeetingAnswerOutput
from app.services.jobs import fail_job
from app.services.questions import process_meeting_question_job


class FakeQuestionProvider:
    def __init__(self, result: dict[str, object]) -> None:
        self.result = result
        self.prompt = ""

    async def generate_structured(self, system_prompt, prompt, schema):
        assert "文字起こしだけ" in system_prompt
        assert "evidence_id=" in prompt
        self.prompt = prompt
        assert schema is MeetingAnswerOutput
        return schema.model_validate(self.result)

    async def test_connection(self) -> None:
        return None

    async def list_models(self) -> list[str]:
        return ["test-model"]


def seed_question_context(
    session: Session,
) -> tuple[Meeting, TranscriptVersion, TranscriptSegment, AIProfile]:
    meeting = Meeting(
        title="質問テスト",
        source_type=MeetingSourceType.AUDIO_UPLOAD,
        status=MeetingStatus.COMPLETED,
    )
    session.add(meeting)
    session.flush()
    segment = TranscriptSegment(
        start_ms=12_000,
        end_ms=18_000,
        text="JWT認証を採用します。田中さんが実装を担当します。",
        sequence=0,
    )
    transcript = TranscriptVersion(
        meeting_id=meeting.id,
        version=1,
        kind=TranscriptKind.FINAL,
        status=TranscriptStatus.COMPLETED,
        language="ja",
        model="large-v3",
        diarization_enabled=True,
        segments=[segment],
    )
    provider = AIProviderConfig(
        provider_type=AIProviderType.OLLAMA,
        name=f"question-provider-{uuid.uuid4()}",
        base_url="http://host.docker.internal:11434",
        enabled=True,
    )
    session.add_all([transcript, provider])
    session.flush()
    profile = AIProfile(
        name=f"question-profile-{uuid.uuid4()}",
        provider_id=provider.id,
        model="test-model",
        temperature=0.2,
        is_default=True,
    )
    session.add(profile)
    session.flush()
    meeting.active_transcript_version_id = transcript.id
    session.commit()
    return meeting, transcript, segment, profile


def test_question_api_enqueues_and_worker_stores_grounded_answer(
    client: TestClient,
    session_factory: sessionmaker[Session],
) -> None:
    with session_factory() as session:
        meeting, transcript, segment, _profile = seed_question_context(session)
        meeting_id = meeting.id
        transcript_id = transcript.id
        segment_id = segment.id

    response = client.post(
        f"/api/v1/meetings/{meeting_id}/questions",
        json={"question": "認証の実装担当は誰ですか？"},
    )
    assert response.status_code == 202
    assert response.json()["status"] == "queued"

    duplicate = client.post(
        f"/api/v1/meetings/{meeting_id}/questions",
        json={"question": "方式は何ですか？"},
    )
    assert duplicate.status_code == 409

    with session_factory() as session:
        question = session.scalar(select(MeetingQuestion))
        assert question is not None
        job = session.get(Job, question.job_id)
        assert job is not None
        assert job.type == JobType.ASK_MEETING
        provider = FakeQuestionProvider(
            {
                "answer": "実装担当は田中さんです。",
                "evidence_segment_ids": [str(uuid.UUID(int=1))],
                "insufficient_information": False,
            }
        )
        process_meeting_question_job(
            session,
            job,
            get_settings(),
            provider_override=provider,
        )
        session.refresh(question)
        assert question.status == MeetingQuestionStatus.COMPLETED
        assert question.transcript_version_id == transcript_id
        assert question.answer == "実装担当は田中さんです。"
        assert [item.segment_id for item in question.evidence] == [segment_id]
        assert "認証の実装担当は誰ですか？" in provider.prompt

    listed = client.get(f"/api/v1/meetings/{meeting_id}/questions")
    assert listed.status_code == 200
    assert listed.json()[0]["answer"] == "実装担当は田中さんです。"
    assert listed.json()[0]["evidence"] == [{"segment_id": str(segment_id)}]


def test_failed_question_does_not_mark_meeting_failed(
    session_factory: sessionmaker[Session],
) -> None:
    with session_factory() as session:
        meeting, transcript, _segment, profile = seed_question_context(session)
        job = Job(
            meeting_id=meeting.id,
            type=JobType.ASK_MEETING,
            status=JobStatus.RUNNING,
        )
        session.add(job)
        session.flush()
        question = MeetingQuestion(
            meeting_id=meeting.id,
            transcript_version_id=transcript.id,
            provider_id=profile.provider_id,
            profile_id=profile.id,
            job_id=job.id,
            question="会議外の情報は？",
            model=profile.model,
            status=MeetingQuestionStatus.PROCESSING,
        )
        session.add(question)
        session.commit()

        fail_job(session, job, "AI unavailable")

        assert job.status == JobStatus.FAILED
        assert question.status == MeetingQuestionStatus.FAILED
        assert meeting.status == MeetingStatus.COMPLETED


def test_unsupported_answer_may_have_no_evidence() -> None:
    result = MeetingAnswerOutput.model_validate(
        {
            "answer": "文字起こしからは確認できません。",
            "evidence_segment_ids": [],
            "insufficient_information": True,
        }
    )
    assert result.evidence_segment_ids == []


def test_unsupported_answer_rejects_evidence() -> None:
    with pytest.raises(ValidationError):
        MeetingAnswerOutput.model_validate(
            {
                "answer": "文字起こしからは確認できません。",
                "evidence_segment_ids": [str(uuid.uuid4())],
                "insufficient_information": True,
            }
        )

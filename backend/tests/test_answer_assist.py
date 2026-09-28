import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import get_settings
from app.models.ai import AIProfile, AIProviderConfig, AIProviderType
from app.models.job import Job, JobStatus, JobType
from app.models.media import Media, MediaKind
from app.models.meeting import Meeting, MeetingSourceType, MeetingStatus
from app.models.realtime import RealtimeSession, RealtimeSessionStatus
from app.models.transcript import (
    TranscriptKind,
    TranscriptSegment,
    TranscriptStatus,
    TranscriptVersion,
)
from app.services.jobs import claim_next_job, fail_job, recover_interrupted_jobs
from app.services.knowledge.answer_assist import (
    AnswerAssistError,
    process_answer,
    request_answer,
    start_assistance,
)


def seed(session: Session, provider_type=AIProviderType.OLLAMA):
    meeting = Meeting(title="回答支援", source_type=MeetingSourceType.LIVE)
    session.add(meeting)
    session.flush()
    media = Media(
        meeting_id=meeting.id,
        kind=MediaKind.ORIGINAL_VIDEO,
        storage_path=f"{uuid.uuid4()}.webm",
        mime_type="video/webm",
        size_bytes=0,
    )
    transcript = TranscriptVersion(
        meeting_id=meeting.id,
        version=1,
        kind=TranscriptKind.LIVE,
        status=TranscriptStatus.PROCESSING,
        language="ja",
        model="test",
        diarization_enabled=True,
        segments=[
            TranscriptSegment(start_ms=0, end_ms=1000, text="Pythonを使っています", sequence=0)
        ],
    )
    provider = AIProviderConfig(
        provider_type=provider_type,
        name=str(uuid.uuid4()),
        enabled=True,
        base_url="http://host.docker.internal:11434",
    )
    session.add_all([media, transcript, provider])
    session.flush()
    profile = AIProfile(
        name=str(uuid.uuid4()), provider_id=provider.id, model="test-model", temperature=0.2
    )
    capture = RealtimeSession(
        meeting_id=meeting.id,
        media_id=media.id,
        transcript_version_id=transcript.id,
        mime_type="video/webm",
    )
    session.add_all([profile, capture])
    session.commit()
    return meeting, profile, capture


class FakeProvider:
    def __init__(self, source_id, callback=None):
        self.source_ids = source_id if isinstance(source_id, list) else [source_id]
        self.callback = callback
        self.calls = 0
        self.prompts = []

    async def generate_structured(self, system_prompt, prompt, schema):
        self.calls += 1
        self.prompts.append(prompt)
        assert "捏造せず" in system_prompt
        assert "Python" in prompt
        if self.callback:
            self.callback()
        source_id = self.source_ids[min(self.calls - 1, len(self.source_ids) - 1)]
        return schema.model_validate(
            {
                "short_answer": "Pythonの経験があります。",
                "detailed_answer": "会話に基づく回答です。",
                "insufficient_information": False,
                "source_ids": [source_id] if source_id else [],
            }
        )


@pytest.mark.parametrize("provider_type", list(AIProviderType))
def test_all_existing_providers_and_idempotent_requests(
    session_factory: sessionmaker[Session], provider_type
):
    with session_factory() as session:
        meeting, profile, _ = seed(session, provider_type)
        assist = start_assistance(session, meeting, profile.id, consent=True)
        assert assist.configuration["provider_type"] == provider_type.value
        answer = request_answer(session, meeting, assist.id, uuid.uuid4(), "経験は？")
        duplicate = request_answer(session, meeting, assist.id, answer.request_id, "経験は？")
        assert duplicate.id == answer.id
        provider = FakeProvider(answer.input_snapshot["sources"][0]["id"])
        process_answer(
            session, session.get(Job, answer.job_id), get_settings(), provider_override=provider
        )
        assert answer.status == "completed"
        assert provider.calls == 1
        assert answer.short_answer == "Pythonの経験があります。"


def test_consent_and_recording_required(client: TestClient, session_factory: sessionmaker[Session]):
    with session_factory() as session:
        meeting, profile, capture = seed(session)
        meeting_id, profile_id = meeting.id, profile.id
        with pytest.raises(AnswerAssistError, match="送信許可"):
            start_assistance(session, meeting, profile.id, consent=False)
        capture.status = RealtimeSessionStatus.COMPLETED
        session.commit()
    url = f"/api/v1/meetings/{meeting_id}/answer-assist/session"
    assert client.post(url, json={"profile_id": str(profile_id)}).status_code == 422
    assert (
        client.post(url, json={"profile_id": str(profile_id), "consent": False}).status_code == 422
    )
    assert (
        client.post(url, json={"profile_id": str(profile_id), "consent": True}).status_code == 409
    )


def test_profile_switch_prevents_old_queued_send(session_factory: sessionmaker[Session]):
    with session_factory() as session:
        meeting, profile, _ = seed(session)
        first = start_assistance(session, meeting, profile.id, consent=True)
        answer = request_answer(session, meeting, first.id, uuid.uuid4(), "経験は？")
        start_assistance(session, meeting, profile.id, consent=True)
        provider = FakeProvider("unused")
        process_answer(
            session, session.get(Job, answer.job_id), get_settings(), provider_override=provider
        )
        assert answer.status == "superseded"
        assert provider.calls == 0


def test_latest_request_supersedes_queued_and_inflight(session_factory: sessionmaker[Session]):
    with session_factory() as session:
        meeting, profile, _ = seed(session)
        assist = start_assistance(session, meeting, profile.id, consent=True)
        first = request_answer(session, meeting, assist.id, uuid.uuid4(), "経験は？")
        second = request_answer(session, meeting, assist.id, uuid.uuid4(), "得意分野は？")
        assert first.status == "superseded"
        assert session.get(Job, first.job_id).status == JobStatus.COMPLETED
        provider = FakeProvider(
            second.input_snapshot["sources"][0]["id"],
            callback=lambda: request_answer(
                session, meeting, assist.id, uuid.uuid4(), "次の質問は？"
            ),
        )
        process_answer(
            session, session.get(Job, second.job_id), get_settings(), provider_override=provider
        )
        assert second.status == "superseded"


@pytest.mark.parametrize("bad_id", ["fake-id", ""])
def test_invalid_evidence_is_corrected_once(session_factory: sessionmaker[Session], bad_id: str):
    with session_factory() as session:
        meeting, profile, _ = seed(session)
        assist = start_assistance(session, meeting, profile.id, consent=True)
        answer = request_answer(session, meeting, assist.id, uuid.uuid4(), "経験は？")
        valid_id = answer.input_snapshot["sources"][0]["id"]
        provider = FakeProvider([bad_id, valid_id])
        process_answer(
            session, session.get(Job, answer.job_id), get_settings(), provider_override=provider
        )
        assert provider.calls == 2
        assert valid_id in provider.prompts[1]
        assert answer.status == "completed"
        assert answer.source_ids == [valid_id]


def test_invalid_evidence_does_not_retry_after_recording_stops(
    session_factory: sessionmaker[Session],
):
    with session_factory() as session:
        meeting, profile, capture = seed(session)
        assist = start_assistance(session, meeting, profile.id, consent=True)
        answer = request_answer(session, meeting, assist.id, uuid.uuid4(), "経験は？")

        def stop_recording():
            capture.status = RealtimeSessionStatus.COMPLETED
            session.commit()

        provider = FakeProvider("fake-id", callback=stop_recording)
        process_answer(
            session, session.get(Job, answer.job_id), get_settings(), provider_override=provider
        )
        assert provider.calls == 1
        assert answer.status == "superseded"


def test_unknown_evidence_fails_only_answer(session_factory: sessionmaker[Session]):
    with session_factory() as session:
        meeting, profile, _ = seed(session)
        initial_status = meeting.status
        assist = start_assistance(session, meeting, profile.id, consent=True)
        previous = request_answer(session, meeting, assist.id, uuid.uuid4(), "経験は？")
        valid_id = previous.input_snapshot["sources"][0]["id"]
        process_answer(
            session,
            session.get(Job, previous.job_id),
            get_settings(),
            provider_override=FakeProvider(valid_id),
        )
        answer = request_answer(session, meeting, assist.id, uuid.uuid4(), "次の経験は？")
        job = session.get(Job, answer.job_id)
        provider = FakeProvider("fake-id")
        with pytest.raises(AnswerAssistError, match="存在しない"):
            process_answer(session, job, get_settings(), provider_override=provider)
        fail_job(session, job, "根拠エラー")
        assert provider.calls == 2
        assert answer.status == "failed"
        assert previous.status == "completed"
        assert meeting.status == initial_status
        assert meeting.status != MeetingStatus.FAILED


def test_general_worker_does_not_claim_or_recover_answers(session_factory: sessionmaker[Session]):
    with session_factory() as session:
        meeting, _, _ = seed(session)
        queued = Job(meeting_id=meeting.id, type=JobType.ANSWER_LIVE)
        running = Job(meeting_id=meeting.id, type=JobType.ANSWER_LIVE, status=JobStatus.RUNNING)
        session.add_all([queued, running])
        session.commit()
        assert claim_next_job(session) is None
        assert recover_interrupted_jobs(session) == 0
        assert running.status == JobStatus.RUNNING


def test_changed_destination_is_not_sent(session_factory: sessionmaker[Session]):
    with session_factory() as session:
        meeting, profile, _ = seed(session)
        assist = start_assistance(session, meeting, profile.id, consent=True)
        answer = request_answer(session, meeting, assist.id, uuid.uuid4(), "経験は？")
        session.get(AIProviderConfig, profile.provider_id).base_url = "http://changed.invalid"
        session.commit()
        provider = FakeProvider("unused")
        with pytest.raises(AnswerAssistError, match="送信先が変更"):
            process_answer(
                session, session.get(Job, answer.job_id), get_settings(), provider_override=provider
            )
        assert provider.calls == 0


def test_stop_during_generation_does_not_publish_latest(session_factory: sessionmaker[Session]):
    with session_factory() as session:
        meeting, profile, capture = seed(session)
        assist = start_assistance(session, meeting, profile.id, consent=True)
        answer = request_answer(session, meeting, assist.id, uuid.uuid4(), "経験は？")

        def stop_recording():
            capture.status = RealtimeSessionStatus.COMPLETED
            session.commit()

        provider = FakeProvider(answer.input_snapshot["sources"][0]["id"], callback=stop_recording)
        process_answer(
            session, session.get(Job, answer.job_id), get_settings(), provider_override=provider
        )
        assert answer.status == "superseded"


def test_api_start_generate_feed_and_stop(
    client: TestClient, session_factory: sessionmaker[Session]
):
    with session_factory() as session:
        meeting, profile, capture = seed(session)
        meeting_id, profile_id, capture_id = meeting.id, profile.id, capture.id
    base = f"/api/v1/meetings/{meeting_id}/answer-assist"
    assert client.get(base + "/session").json() is None
    started = client.post(base + "/session", json={"profile_id": str(profile_id), "consent": True})
    assert started.status_code == 201
    assist_id = started.json()["id"]
    assert started.json()["configuration"]["model"] == "test-model"
    feed = client.get(base + "/feed")
    assert feed.status_code == 200
    assert feed.json()["capture_id"] == str(capture_id)
    assert feed.json()["segments"][0]["text"] == "Pythonを使っています"
    request = {"session_id": assist_id, "request_id": str(uuid.uuid4()), "question": "経験は？"}
    created = client.post(base + "/answers", json=request)
    assert created.status_code == 202
    assert client.post(base + "/answers", json=request).json()["id"] == created.json()["id"]
    assert len(client.get(base + "/answers").json()) == 1
    assert client.delete(base + f"/session/{assist_id}").status_code == 204
    assert client.get(base + "/session").json()["enabled"] is False
    assert (
        client.post(
            base + "/answers", json={**request, "request_id": str(uuid.uuid4())}
        ).status_code
        == 409
    )

import json
import uuid

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker
from test_answer_assist import seed

from app.core.config import get_settings
from app.models.answer_assist import LiveAnswer
from app.models.job import Job
from app.models.realtime import RealtimeSessionStatus
from app.models.transcript import TranscriptSegment
from app.services.knowledge.answer_assist import AnswerAssistError, process_answer, start_assistance
from app.services.knowledge.answer_monitor import configure_monitor, enqueue_monitor_checks


class Detector:
    def __init__(
        self, decision=True, question="経験を説明してください", callback=None, invalid=False
    ):
        self.decision = decision
        self.question = question
        self.callback = callback
        self.invalid = invalid
        self.calls = 0
        self.prompt = {}

    async def generate_structured(self, system, prompt, schema):
        self.calls += 1
        assert "文脈" in system
        self.prompt = json.loads(prompt)
        if self.callback:
            self.callback()
        return schema.model_validate(
            {
                "should_answer": self.decision,
                "question": self.question,
                "trigger_segment_ids": [
                    str(uuid.uuid4()) if self.invalid else self.prompt["changed_ids"][-1]
                ],
            }
        )


def begin(session):
    meeting, profile, capture = seed(session)
    assist = start_assistance(session, meeting, profile.id, consent=True)
    configure_monitor(session, assist, enabled=True, target_speaker=None)
    return meeting, capture, assist


def add_question(
    session, capture, sequence=1, text="経験についてお聞かせください", speaker="SPEAKER_01"
):
    segment = TranscriptSegment(
        transcript_version_id=capture.transcript_version_id,
        start_ms=sequence * 2000,
        end_ms=sequence * 2000 + 1000,
        text=text,
        sequence=sequence,
        provisional_speaker_label=speaker,
    )
    session.add(segment)
    session.commit()
    return segment


def check_job(session):
    check = session.scalar(select(LiveAnswer).where(LiveAnswer.status == "checking"))
    assert check is not None
    return session.get(Job, check.job_id), check


def test_checks_only_new_conversation_and_queues_grounded_answer(
    session_factory: sessionmaker[Session],
):
    with session_factory() as session:
        _, capture, assist = begin(session)
        assert enqueue_monitor_checks(session) == 0
        segment = add_question(session, capture)
        assert enqueue_monitor_checks(session) == 1
        assert enqueue_monitor_checks(session) == 0
        job, check = check_job(session)
        detector = Detector()
        process_answer(session, job, get_settings(), provider_override=detector)
        answer = session.scalar(select(LiveAnswer).where(LiveAnswer.sequence == 1))
        assert answer is not None
        assert answer.question == "経験を説明してください"
        assert (
            answer.input_snapshot["automatic_revision"]
            == assist.configuration["automatic"]["revision"]
        )
        assert answer.input_snapshot["trigger_segment_ids"] == [str(segment.id)]
        assert check.status == "ignored"
        assert len(detector.prompt["conversation"]) == 2
        assert detector.prompt["conversation"][0]["text"] == "Pythonを使っています"


def test_nonquestion_does_not_generate_answer(session_factory: sessionmaker[Session]):
    with session_factory() as session:
        _, capture, _ = begin(session)
        add_question(session, capture, text="そうですね")
        enqueue_monitor_checks(session)
        job, check = check_job(session)
        process_answer(session, job, get_settings(), provider_override=Detector(decision=False))
        assert check.status == "ignored"
        assert session.scalar(select(LiveAnswer.id).where(LiveAnswer.sequence > 0)) is None


@pytest.mark.parametrize("when", ["before", "during"])
def test_off_prevents_late_detection_from_generating(session_factory: sessionmaker[Session], when):
    with session_factory() as session:
        _, capture, assist = begin(session)
        add_question(session, capture)
        enqueue_monitor_checks(session)
        job, check = check_job(session)

        def off():
            configure_monitor(session, assist, enabled=False, target_speaker=None)

        detector = Detector(callback=off if when == "during" else None)
        if when == "before":
            off()
        process_answer(session, job, get_settings(), provider_override=detector)
        assert detector.calls == (0 if when == "before" else 1)
        assert check.status == "ignored"
        assert session.scalar(select(LiveAnswer.id).where(LiveAnswer.sequence > 0)) is None


def test_auto_answer_is_not_sent_after_off(session_factory: sessionmaker[Session]):
    with session_factory() as session:
        _, capture, assist = begin(session)
        add_question(session, capture)
        enqueue_monitor_checks(session)
        job, _ = check_job(session)
        process_answer(session, job, get_settings(), provider_override=Detector())
        answer = session.scalar(select(LiveAnswer).where(LiveAnswer.sequence == 1))
        configure_monitor(session, assist, enabled=False, target_speaker=None)
        detector = Detector()
        process_answer(
            session, session.get(Job, answer.job_id), get_settings(), provider_override=detector
        )
        assert answer.status == "superseded"
        assert detector.calls == 0


def test_invalid_detection_evidence_is_rejected(session_factory: sessionmaker[Session]):
    with session_factory() as session:
        _, capture, _ = begin(session)
        add_question(session, capture)
        enqueue_monitor_checks(session)
        job, _ = check_job(session)
        with pytest.raises(AnswerAssistError, match="根拠が不正"):
            process_answer(session, job, get_settings(), provider_override=Detector(invalid=True))
        assert session.scalar(select(LiveAnswer.id).where(LiveAnswer.sequence > 0)) is None


def test_off_or_ended_recording_is_not_checked(session_factory: sessionmaker[Session]):
    with session_factory() as session:
        _, capture, assist = begin(session)
        configure_monitor(session, assist, enabled=False, target_speaker=None)
        add_question(session, capture)
        assert enqueue_monitor_checks(session) == 0
        configure_monitor(session, assist, enabled=True, target_speaker=None)
        add_question(session, capture, sequence=2)
        capture.status = RealtimeSessionStatus.COMPLETED
        session.commit()
        assert enqueue_monitor_checks(session) == 0


def test_same_question_is_not_regenerated(session_factory: sessionmaker[Session]):
    from app.models.job import JobStatus

    with session_factory() as session:
        _, capture, assist = begin(session)
        segment = add_question(session, capture)
        enqueue_monitor_checks(session)
        job, _ = check_job(session)
        process_answer(session, job, get_settings(), provider_override=Detector())
        job.status = JobStatus.COMPLETED
        first = session.scalar(select(LiveAnswer).where(LiveAnswer.sequence == 1))
        first.status = "completed"
        session.get(Job, first.job_id).status = JobStatus.COMPLETED
        segment.text += "お願いします"
        config = dict(assist.configuration)
        config["automatic"] = {**config["automatic"], "last_check_at": 0}
        assist.configuration = config
        session.commit()
        assert enqueue_monitor_checks(session) == 1
        next_job, _ = check_job(session)
        process_answer(session, next_job, get_settings(), provider_override=Detector())
        assert len(list(session.scalars(select(LiveAnswer).where(LiveAnswer.sequence > 0)))) == 1


def test_wrong_target_speaker_is_rejected(session_factory: sessionmaker[Session]):
    with session_factory() as session:
        _, capture, assist = begin(session)
        configure_monitor(session, assist, enabled=True, target_speaker="SPEAKER_00")
        add_question(session, capture, speaker="SPEAKER_01")
        enqueue_monitor_checks(session)
        job, _ = check_job(session)
        with pytest.raises(AnswerAssistError, match="対象話者"):
            process_answer(session, job, get_settings(), provider_override=Detector())
        assert session.scalar(select(LiveAnswer.id).where(LiveAnswer.sequence > 0)) is None


def test_api_can_enable_and_disable_monitor(client, session_factory: sessionmaker[Session]):
    with session_factory() as session:
        meeting, profile, _ = seed(session)
        assist = start_assistance(session, meeting, profile.id, consent=True)
        meeting_id, assist_id = meeting.id, assist.id
    endpoint = f"/api/v1/meetings/{meeting_id}/answer-assist/session/{assist_id}/automatic"
    enabled = client.patch(endpoint, json={"enabled": True, "target_speaker": "SPEAKER_01"})
    assert enabled.status_code == 200
    config = enabled.json()["configuration"]["automatic"]
    assert config["enabled"] is True
    assert config["target_speaker"] == "SPEAKER_01"
    disabled = client.patch(endpoint, json={"enabled": False})
    assert disabled.status_code == 200
    assert disabled.json()["configuration"]["automatic"]["enabled"] is False
    assert disabled.json()["configuration"]["automatic"]["revision"] != config["revision"]
    restored = client.get(f"/api/v1/meetings/{meeting_id}/answer-assist/session")
    assert restored.json()["configuration"]["automatic"]["enabled"] is False

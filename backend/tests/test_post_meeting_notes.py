import uuid
from unittest.mock import Mock

import pytest
from sqlalchemy import select
from test_analysis_phase5 import FakeProvider, result_for
from test_meeting_questions import FakeQuestionProvider
from test_saved_transcript_summary import saved_live
from test_summary_regeneration import count

from app.core.config import get_settings
from app.models.ai import AIProfile, AIProviderConfig
from app.models.analysis import AnalysisItemState, AnalysisStatus, AnalysisVersion
from app.models.job import Job, JobType
from app.models.meeting import Meeting, MeetingStatus
from app.models.question import MeetingQuestion
from app.models.realtime import RealtimeSession, RealtimeSessionStatus
from app.models.transcript import (
    TranscriptKind,
    TranscriptSegment,
    TranscriptStatus,
    TranscriptVersion,
)
from app.schemas.analysis import AnalysisGenerateRequest
from app.services.analysis import process_analysis_job
from app.services.analysis.regeneration import regenerate_summary
from app.services.jobs import fail_job, finish_job
from app.services.questions import MeetingQuestionError, process_meeting_question_job


@pytest.fixture
def notes(session_factory):
    with session_factory() as db:
        meeting, live, segment, profile, _, capture = saved_live(db)
        segment.provisional_speaker_name = "田中"
        db.commit()
        analysis, job = regenerate_summary(
            db,
            meeting,
            AnalysisGenerateRequest(
                profile_id=profile.id,
                reuse_saved_transcript=True,
            ),
        )
        process_analysis_job(
            db, job, get_settings(), provider_override=FakeProvider(result_for(segment.id))
        )
        finish_job(db, job)
        return {
            "meeting": meeting.id,
            "live": live.id,
            "segment": segment.id,
            "profile": profile.id,
            "analysis": analysis.id,
            "capture": capture.id,
        }


def ask(client, notes, **fields):
    return client.post(
        f"/api/v1/meetings/{notes['meeting']}/questions",
        json={"question": "結論は？", "analysis_id": str(notes["analysis"]), **fields},
    )


def test_saved_live_questions_keep_source_profile_and_model_after_final_appears(
    client,
    session_factory,
    notes,
    monkeypatch,
):
    response = ask(client, notes)
    assert response.status_code == 202
    assert response.json()["transcript_kind"] == "live"
    assert response.json()["transcript_version_id"] == str(notes["live"])
    assert response.json()["profile_id"] == str(notes["profile"])
    assert ask(client, notes).status_code == 409
    with session_factory() as db:
        question = db.get(MeetingQuestion, uuid.UUID(response.json()["id"]))
        job = db.get(Job, question.job_id)
        final = TranscriptVersion(
            meeting_id=notes["meeting"],
            version=1,
            kind=TranscriptKind.FINAL,
            status=TranscriptStatus.COMPLETED,
            language="ja",
            model="whisperx",
            diarization_enabled=True,
            segments=[
                TranscriptSegment(sequence=0, start_ms=0, end_ms=1000, text="Final-only text")
            ],
        )
        db.add(final)
        db.flush()
        meeting = db.get(Meeting, notes["meeting"])
        meeting.active_transcript_version_id = final.id
        db.get(AIProfile, notes["profile"]).model = "model-changed-after-enqueue"
        db.commit()
        runtime = FakeQuestionProvider(
            {"answer": "保存済み原文の結論です", "evidence_segment_ids": [str(notes["segment"])]}
        )
        runtime.generate_structured = Mock(wraps=runtime.generate_structured)
        build = Mock(return_value=runtime)
        monkeypatch.setattr("app.services.questions.processor.build_llm_provider", build)
        process_meeting_question_job(db, job, get_settings())
        finish_job(db, job)
        assert build.call_args.kwargs["model"] == question.model
        assert build.call_args.kwargs["model"] != "model-changed-after-enqueue"
        system, prompt, _schema = runtime.generate_structured.call_args.args
        assert "リアルタイム文字起こし（暫定）" in system
        assert "田中（暫定）" in prompt
        assert "Final-only text" not in prompt
        assert [item.segment_id for item in question.evidence] == [notes["segment"]]
        assert question.transcript_version_id == notes["live"]
        assert meeting.ai_disabled is True
        assert count(db, Job, Job.type == JobType.TRANSCRIBE) == 0
    listed = client.get(f"/api/v1/meetings/{notes['meeting']}/questions").json()
    assert listed[0]["transcript_kind"] == "live"
    assert listed[0]["answer"] == "保存済み原文の結論です"


def test_question_without_analysis_id_uses_active_saved_live_summary_if_no_final(
    client,
    session_factory,
    notes,
):
    assert ask(client, notes, analysis_id=None).status_code == 202
    with session_factory() as db:
        assert db.scalar(select(MeetingQuestion)).transcript_version_id == notes["live"]
        assert db.get(Meeting, notes["meeting"]).ai_disabled


def test_live_summary_edit_and_confirmation_survive_regeneration(client, session_factory, notes):
    path = f"/api/v1/meetings/{notes['meeting']}/analyses/{notes['analysis']}"
    before = client.get(path).json()
    item = next(item for item in before["items"] if item["kind"] == "summary")
    update = client.patch(f"{path}/items/{item['id']}", json={"content": "ユーザーが修正した要約"})
    assert update.status_code == 200 and update.json()["state"] == "edited"
    confirmed = client.patch(f"{path}/items/{item['id']}", json={"state": "confirmed"})
    assert confirmed.status_code == 200 and confirmed.json()["state"] == "confirmed"
    assert confirmed.json()["evidence"] == item["evidence"]
    with session_factory() as db:
        meeting = db.get(Meeting, notes["meeting"])
        analysis, job = regenerate_summary(
            db,
            meeting,
            AnalysisGenerateRequest(profile_id=notes["profile"], reuse_saved_transcript=True),
        )
        process_analysis_job(
            db, job, get_settings(), provider_override=FakeProvider(result_for(notes["segment"]))
        )
        finish_job(db, job)
        assert any(
            row.content == "ユーザーが修正した要約" and row.state == AnalysisItemState.CONFIRMED
            for row in analysis.items
        )
        assert analysis.transcript_version_id == notes["live"]
        assert count(db, Job, Job.type == JobType.TRANSCRIBE) == 0
        assert db.get(TranscriptVersion, notes["live"]).kind == TranscriptKind.LIVE
    after = client.get(path).json()
    assert after["template_snapshot"] == before["template_snapshot"]
    assert (
        next(row for row in after["items"] if row["id"] == item["id"])["content"]
        == "ユーザーが修正した要約"
    )


@pytest.mark.parametrize(
    "invalid",
    [
        "recording",
        "finalizing",
        "failed_capture",
        "failed_transcript",
        "empty",
        "processing_summary",
        "failed_summary",
    ],
)
def test_incomplete_sources_cannot_be_edited_or_asked(client, session_factory, notes, invalid):
    path = f"/api/v1/meetings/{notes['meeting']}/analyses/{notes['analysis']}"
    original = client.get(path).json()
    item = original["items"][0]
    with session_factory() as db:
        capture = db.get(RealtimeSession, notes["capture"])
        transcript = db.get(TranscriptVersion, notes["live"])
        if invalid in {"recording", "finalizing"}:
            capture.status = RealtimeSessionStatus(invalid)
        elif invalid == "failed_capture":
            capture.status = RealtimeSessionStatus.FAILED
        elif invalid == "failed_transcript":
            transcript.status = TranscriptStatus.FAILED
        elif invalid == "empty":
            transcript.segments.clear()
        else:
            db.get(AnalysisVersion, notes["analysis"]).status = (
                AnalysisStatus.PROCESSING
                if invalid == "processing_summary"
                else AnalysisStatus.FAILED
            )
        db.commit()
    assert ask(client, notes).status_code == 409
    edited = client.patch(f"{path}/items/{item['id']}", json={"content": "Cannot be saved"})
    assert edited.status_code == 409
    with session_factory() as db:
        assert count(db, Job, Job.type == JobType.ASK_MEETING) == 0
    after = client.get(path).json()
    assert after["template_snapshot"] == original["template_snapshot"]
    assert after["items"][0]["content"] == item["content"]


def test_other_meeting_and_realtime_snapshot_are_not_post_meeting_sources(
    client, session_factory, notes
):
    with session_factory() as db:
        other = Meeting(title="Other", source_type=db.get(Meeting, notes["meeting"]).source_type)
        db.add(other)
        db.commit()
        other_id = other.id
    assert (
        client.post(
            f"/api/v1/meetings/{other_id}/questions",
            json={"question": "誰？", "analysis_id": str(notes["analysis"])},
        ).status_code
        == 409
    )
    assert ask(client, notes, analysis_id=str(uuid.uuid4())).status_code == 409
    assert ask(client, notes, analysis_id="realtime").status_code == 422
    with session_factory() as db:
        assert count(db, Job, Job.type == JobType.ASK_MEETING) == 0


def test_external_failure_and_invalid_evidence_keep_notes_and_original_source(
    client, session_factory, notes
):
    before = client.get(f"/api/v1/meetings/{notes['meeting']}/analysis").json()
    created = ask(client, notes).json()
    with session_factory() as db:
        question = db.get(MeetingQuestion, uuid.UUID(created["id"]))
        job = db.get(Job, question.job_id)
        with pytest.raises(MeetingQuestionError, match="存在しないEvidence"):
            process_meeting_question_job(
                db,
                job,
                get_settings(),
                provider_override=FakeQuestionProvider(
                    {
                        "answer": "誤った根拠",
                        "evidence_segment_ids": [str(uuid.uuid4())],
                    }
                ),
            )
        fail_job(db, job, "external API failed")
        assert db.get(Meeting, notes["meeting"]).status == MeetingStatus.COMPLETED
    assert client.get(f"/api/v1/meetings/{notes['meeting']}/analysis").json() == before
    assert client.post(f"/api/v1/jobs/{created['job_id']}/retry").status_code == 200
    with session_factory() as db:
        question = db.get(MeetingQuestion, uuid.UUID(created["id"]))
        assert question.transcript_version_id == notes["live"]
        db.get(RealtimeSession, notes["capture"]).status = RealtimeSessionStatus.FINALIZING
        question.status = "failed"
        db.get(Job, question.job_id).status = "failed"
        db.commit()
    assert client.post(f"/api/v1/jobs/{created['job_id']}/retry").status_code == 409


def test_disabled_provider_does_not_enqueue_or_change_summary(client, session_factory, notes):
    with session_factory() as db:
        profile = db.get(AIProfile, notes["profile"])
        db.get(AIProviderConfig, profile.provider_id).enabled = False
        db.commit()
    assert ask(client, notes).status_code == 409
    with session_factory() as db:
        assert count(db, Job, Job.type == JobType.ASK_MEETING) == 0
        assert db.get(AnalysisVersion, notes["analysis"]).status == AnalysisStatus.COMPLETED


def test_failed_question_cannot_retry_while_another_question_is_pending(
    client, session_factory, notes
):
    first = ask(client, notes).json()
    with session_factory() as db:
        fail_job(db, db.get(Job, uuid.UUID(first["job_id"])), "temporary API failure")
    second = ask(client, notes)
    assert second.status_code == 202
    assert client.post(f"/api/v1/jobs/{first['job_id']}/retry").status_code == 409
    with session_factory() as db:
        assert db.get(MeetingQuestion, uuid.UUID(first["id"])).status == "failed"
        assert db.get(MeetingQuestion, uuid.UUID(second.json()["id"])).status == "queued"
        assert count(db, Job, Job.type == JobType.ASK_MEETING) == 2
        assert db.get(Meeting, notes["meeting"]).status == MeetingStatus.COMPLETED

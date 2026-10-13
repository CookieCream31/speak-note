import uuid
from copy import deepcopy
from unittest.mock import Mock

import pytest
from test_analysis_phase5 import FakeProvider, result_for
from test_summary_regeneration import count, seed, template_definition

from app.core.config import get_settings
from app.models.ai import AIProfile
from app.models.analysis import AnalysisItemState, AnalysisVersion
from app.models.job import Job, JobType
from app.models.meeting import Meeting
from app.models.meeting_template import MeetingTemplate
from app.models.realtime import RealtimeSession, RealtimeSessionStatus
from app.models.transcript import TranscriptKind, TranscriptStatus, TranscriptVersion
from app.schemas.analysis import AnalysisGenerateRequest
from app.services.analysis import AnalysisProcessingError, process_analysis_job
from app.services.analysis.regeneration import regenerate_summary
from app.services.jobs import fail_job, finish_job


def saved_live(db):
    meeting, live, segment, profile, template, media = seed(db, final=False)
    meeting.ai_disabled = True
    segment.provisional_speaker_label = "話者 2"
    capture = RealtimeSession(
        meeting_id=meeting.id,
        media_id=media.id,
        transcript_version_id=live.id,
        status=RealtimeSessionStatus.COMPLETED,
        mime_type="audio/webm",
    )
    db.add(capture)
    db.commit()
    return meeting, live, segment, profile, template, capture


def test_saved_live_only_reserves_analysis_and_freezes_model_template_and_evidence(
    client, session_factory, monkeypatch
):
    with session_factory() as db:
        meeting, live, segment, profile, template, _ = saved_live(db)
        meeting_id, live_id, segment_id = meeting.id, live.id, segment.id
        settings = deepcopy(meeting.template_snapshot)
        profile_id, template_id = profile.id, template.id
    path = f"/api/v1/meetings/{meeting_id}/analyses"
    payload = {
        "profile_id": str(profile_id),
        "template_id": str(template_id),
        "request_id": str(uuid.uuid4()),
        "reuse_saved_transcript": True,
    }
    response = client.post(path, json=payload)
    assert response.status_code == 202
    assert response.json()["analysis"]["transcript_kind"] == "live"
    assert client.post(path, json=payload).json()["job_id"] == response.json()["job_id"]
    assert client.post(path, json={**payload, "request_id": str(uuid.uuid4())}).status_code == 409
    with session_factory() as db:
        job = db.get(Job, uuid.UUID(response.json()["job_id"]))
        assert job.type == JobType.ANALYZE
        assert count(db, Job, Job.type == JobType.TRANSCRIBE) == 0
        analysis = db.get(AnalysisVersion, uuid.UUID(response.json()["analysis"]["id"]))
        assert analysis.transcript_version_id == live_id
        assert job.analysis_request["transcript_version_id"] == str(live_id)
        assert db.get(Meeting, meeting_id).template_snapshot == settings
        db.get(AIProfile, profile_id).model = "changed-model"
        selected = db.get(MeetingTemplate, template_id)
        selected.definition, selected.revision = {"realtime": [], "final": []}, 3
        db.get(Meeting, meeting_id).template_snapshot = {
            "definition": {"realtime": [], "final": []}
        }
        db.commit()
        output = result_for(segment_id)
        output["template_values"] = [
            {
                "card_id": "custom",
                "row_id": "row:0",
                "field_id": "value",
                "field_type": "short_text",
                "text_value": "結論",
                "evidence_segment_ids": [str(segment_id)],
            }
        ]
        runtime = FakeProvider(output)
        runtime.generate_structured = Mock(wraps=runtime.generate_structured)
        build = Mock(return_value=runtime)
        monkeypatch.setattr("app.services.analysis.processor.build_llm_provider", build)
        process_analysis_job(db, job, get_settings())
        finish_job(db, job)
        assert build.call_args.kwargs["model"] == "test-model"
        prompt = runtime.generate_structured.call_args.args[1]
        assert "保存済みリアルタイム文字起こし（暫定）" in prompt
        assert "話者 2（暫定）" in prompt
        assert "議論から確認できる結論を短く書く" in prompt
        assert analysis.template_snapshot["revision"] == 2
        assert analysis.template_snapshot["definition"] == template_definition()
        assert all(
            evidence.segment_id == segment_id
            for item in analysis.items
            for evidence in item.evidence
        )
        assert count(db, TranscriptVersion, TranscriptVersion.kind == TranscriptKind.FINAL) == 0
        assert db.get(Meeting, meeting_id).ai_disabled
    assert client.get(f"/api/v1/meetings/{meeting_id}/analysis").json()["transcript_kind"] == "live"
    assert client.get(path).json()[0]["transcript_kind"] == "live"
    assert client.get(f"/api/v1/meetings/{meeting_id}/transcript?version_id={live_id}").json()[
        "id"
    ] == str(live_id)


def test_final_is_preferred_even_when_the_active_transcript_is_live(client, session_factory):
    with session_factory() as db:
        meeting, final, _, profile, _, media = seed(db)
        live = TranscriptVersion(
            meeting_id=meeting.id,
            version=2,
            kind=TranscriptKind.LIVE,
            status=TranscriptStatus.COMPLETED,
            language="ja",
            model="live",
            diarization_enabled=False,
        )
        db.add(live)
        db.flush()
        db.add(
            RealtimeSession(
                meeting_id=meeting.id,
                media_id=media.id,
                transcript_version_id=live.id,
                status=RealtimeSessionStatus.COMPLETED,
                mime_type="audio/webm",
            )
        )
        meeting.active_transcript_version_id = live.id
        db.commit()
        analysis, job = regenerate_summary(
            db, meeting, AnalysisGenerateRequest(profile_id=profile.id, reuse_saved_transcript=True)
        )
        assert analysis.transcript_version_id == final.id
        assert job.type == JobType.ANALYZE
        assert count(db, Job, Job.type == JobType.TRANSCRIBE) == 0
        meeting_id, final_id = meeting.id, final.id
    assert client.get(f"/api/v1/meetings/{meeting_id}/transcript?kind=final").json()["id"] == str(
        final_id
    )


@pytest.mark.parametrize(
    "unavailable",
    ["recording", "finalizing", "failed_capture", "processing", "failed_transcript", "empty"],
)
def test_saved_only_request_never_falls_back_to_transcription(client, session_factory, unavailable):
    with session_factory() as db:
        meeting, live, _, profile, _, capture = saved_live(db)
        if unavailable in {"recording", "finalizing"}:
            capture.status = RealtimeSessionStatus(unavailable)
        elif unavailable == "failed_capture":
            capture.status = RealtimeSessionStatus.FAILED
        elif unavailable == "empty":
            live.segments.clear()
        else:
            live.status = (
                TranscriptStatus.PROCESSING
                if unavailable == "processing"
                else TranscriptStatus.FAILED
            )
        db.commit()
        meeting_id, profile_id, live_id = meeting.id, profile.id, live.id
    response = client.post(
        f"/api/v1/meetings/{meeting_id}/analyses",
        json={"profile_id": str(profile_id), "reuse_saved_transcript": True},
    )
    assert response.status_code == 409
    with session_factory() as db:
        assert count(db, Job) == 0
        assert db.get(TranscriptVersion, live_id) is not None


def test_live_worker_revalidates_capture_and_frozen_source_before_contacting_ai(session_factory):
    with session_factory() as db:
        meeting, live, _, profile, _, capture = saved_live(db)
        _, job = regenerate_summary(
            db, meeting, AnalysisGenerateRequest(profile_id=profile.id, reuse_saved_transcript=True)
        )
        runtime = Mock()
        job.analysis_request = {**job.analysis_request, "transcript_version_id": str(uuid.uuid4())}
        db.commit()
        with pytest.raises(AnalysisProcessingError, match="生成予約と一致"):
            process_analysis_job(db, job, get_settings(), provider_override=runtime)
        job.analysis_request = {**job.analysis_request, "transcript_version_id": str(live.id)}
        capture.status = RealtimeSessionStatus.FINALIZING
        db.commit()
        with pytest.raises(AnalysisProcessingError):
            process_analysis_job(db, job, get_settings(), provider_override=runtime)
        runtime.generate_structured.assert_not_called()


def test_live_summary_retries_and_protected_edits_do_not_retranscribe(client, session_factory):
    with session_factory() as db:
        meeting, live, segment, profile, _, _ = saved_live(db)
        analysis, job = regenerate_summary(
            db, meeting, AnalysisGenerateRequest(profile_id=profile.id, reuse_saved_transcript=True)
        )
        process_analysis_job(
            db, job, get_settings(), provider_override=FakeProvider(result_for(segment.id))
        )
        finish_job(db, job)
        protected = analysis.items[0]
        protected.content, protected.state = "ユーザー確認済み", AnalysisItemState.CONFIRMED
        db.commit()
        second, retry_job = regenerate_summary(
            db, meeting, AnalysisGenerateRequest(profile_id=profile.id, reuse_saved_transcript=True)
        )
        snapshot = deepcopy(second.template_snapshot)
        failing = Mock()
        failing.generate_structured = Mock(side_effect=RuntimeError("外部API障害"))
        with pytest.raises(RuntimeError):
            process_analysis_job(db, retry_job, get_settings(), provider_override=failing)
        fail_job(db, retry_job, "外部API障害")
        assert meeting.active_analysis_version_id == analysis.id
        assert client.post(f"/api/v1/jobs/{retry_job.id}/retry").status_code == 200
        assert client.post(f"/api/v1/jobs/{retry_job.id}/retry").status_code == 409
        db.refresh(retry_job)
        process_analysis_job(
            db, retry_job, get_settings(), provider_override=FakeProvider(result_for(segment.id))
        )
        finish_job(db, retry_job)
        assert second.template_snapshot == snapshot
        assert any(
            item.content == "ユーザー確認済み" and item.state == AnalysisItemState.CONFIRMED
            for item in second.items
        )
        assert count(db, Job, Job.type == JobType.TRANSCRIBE) == 0
        assert count(db, TranscriptVersion, TranscriptVersion.kind == TranscriptKind.FINAL) == 0
        assert meeting.active_transcript_version_id == live.id


def test_transcript_history_ids_are_meeting_scoped_and_live_questions_remain_unavailable(
    client, session_factory
):
    with session_factory() as db:
        meeting, live, _, _, _, _ = saved_live(db)
        meeting.ai_disabled = False
        other = Meeting(title="Other meeting", source_type=meeting.source_type)
        db.add(other)
        db.commit()
        meeting_id, other_id, live_id = meeting.id, other.id, live.id
    assert (
        client.get(f"/api/v1/meetings/{other_id}/transcript?version_id={live_id}").status_code
        == 404
    )
    assert (
        client.get(
            f"/api/v1/meetings/{meeting_id}/transcript?version_id={live_id}&kind=final"
        ).status_code
        == 404
    )
    assert (
        client.post(
            f"/api/v1/meetings/{meeting_id}/questions", json={"question": "決定事項は？"}
        ).status_code
        == 409
    )


def test_live_summary_keeps_its_source_when_final_is_created_explicitly(
    client, session_factory, tmp_path
):
    from test_transcription_processor import FakeWhisperXClient

    from app.services.media import MediaStorage
    from app.services.transcription.processor import process_transcription_job

    with session_factory() as db:
        meeting, live, segment, profile, _, _ = saved_live(db)
        analysis, job = regenerate_summary(
            db, meeting, AnalysisGenerateRequest(profile_id=profile.id, reuse_saved_transcript=True)
        )
        process_analysis_job(
            db, job, get_settings(), provider_override=FakeProvider(result_for(segment.id))
        )
        finish_job(db, job)
        meeting_id, analysis_id, live_id = meeting.id, analysis.id, live.id
        frozen = deepcopy(analysis.template_snapshot)
    response = client.post(f"/api/v1/meetings/{meeting_id}/transcript")
    assert response.status_code == 202
    (tmp_path / "test.webm").write_bytes(b"RIFF-fake")
    with session_factory() as db:
        transcription = db.get(Job, uuid.UUID(response.json()["id"]))
        process_transcription_job(
            db, transcription, FakeWhisperXClient(), MediaStorage(tmp_path, 1)
        )
        finish_job(db, transcription)
        old = db.get(AnalysisVersion, analysis_id)
        assert old.transcript_version_id == live_id
        assert old.template_snapshot == frozen
        assert old.transcript_kind == TranscriptKind.LIVE
        meeting = db.get(Meeting, meeting_id)
        next_analysis, next_job = regenerate_summary(
            db, meeting, AnalysisGenerateRequest(profile_id=profile.id, reuse_saved_transcript=True)
        )
        assert next_analysis.transcript_kind == TranscriptKind.FINAL
        assert next_job.type == JobType.ANALYZE
        assert count(db, Job, Job.type == JobType.TRANSCRIBE) == 1


def test_invalid_saved_summary_configuration_keeps_transcripts_and_results(client, session_factory):
    with session_factory() as db:
        meeting, live, _, profile, _, _ = saved_live(db)
        meeting_id, live_id = meeting.id, live.id
    response = client.post(
        f"/api/v1/meetings/{meeting_id}/analyses",
        json={"profile_id": str(uuid.uuid4()), "reuse_saved_transcript": True},
    )
    assert response.status_code == 409
    with session_factory() as db:
        assert db.get(TranscriptVersion, live_id) is not None
        assert count(db, Job) == 0
        assert count(db, AnalysisVersion) == 0

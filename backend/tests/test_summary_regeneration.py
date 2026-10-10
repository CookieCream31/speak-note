import uuid
from copy import deepcopy
from unittest.mock import Mock

import pytest
from sqlalchemy import func, select
from test_analysis_phase5 import FakeProvider, result_for, seed_transcript_and_profile
from test_transcription_processor import FakeWhisperXClient

from app.core.config import get_settings
from app.models.ai import AIProfile, AIProviderConfig
from app.models.analysis import AnalysisItemState, AnalysisStatus, AnalysisVersion
from app.models.job import Job, JobType
from app.models.media import Media, MediaKind
from app.models.meeting import Meeting, MeetingSourceType
from app.models.meeting_template import MeetingTemplate
from app.models.realtime import RealtimeSession, RealtimeSessionStatus
from app.models.transcript import TranscriptKind, TranscriptVersion
from app.schemas.analysis import AnalysisGenerateRequest
from app.services.analysis import AnalysisProcessingError, process_analysis_job
from app.services.analysis.regeneration import regenerate_summary
from app.services.jobs import fail_job, finish_job
from app.services.media import MediaStorage
from app.services.transcription.processor import process_transcription_job


def template_definition():
    return {
        "realtime": [],
        "final": [
            {
                "id": "custom",
                "title": "選択したカード",
                "visible": True,
                "core_kind": None,
                "instructions": "議論から確認できる結論を短く書く",
                "fields": [{"id": "value", "name": "結論", "type": "short_text"}],
            }
        ],
    }


def seed(db, *, final=True):
    meeting, transcript, segment, profile = seed_transcript_and_profile(db)
    meeting.ai_profile_id = profile.id
    meeting.summary_format = "bullet"
    meeting.template_snapshot = {
        "template_id": str(uuid.uuid4()),
        "revision": 8,
        "name": "会議設定",
        "definition": {"realtime": [], "final": []},
    }
    meeting.source_type = MeetingSourceType.AUDIO_RECORDING
    meeting.min_speakers, meeting.max_speakers = 2, 4
    media = Media(
        meeting_id=meeting.id,
        kind=MediaKind.ORIGINAL_AUDIO,
        storage_path="test.webm",
        mime_type="audio/webm",
        size_bytes=1,
    )
    selected = MeetingTemplate(name="再生成用", revision=2, definition=template_definition())
    db.add_all([media, selected])
    if not final:
        transcript.kind = TranscriptKind.LIVE
    db.commit()
    return meeting, transcript, segment, profile, selected, media


def count(db, model, *conditions):
    return db.scalar(select(func.count()).select_from(model).where(*conditions))


def test_existing_final_only_enqueues_analysis_and_request_is_idempotent(client, session_factory):
    with session_factory() as db:
        meeting, transcript, _, profile, template, _ = seed(db)
        meeting_id = meeting.id
        original_settings = (meeting.ai_profile_id, deepcopy(meeting.template_snapshot))
        payload = {
            "profile_id": str(profile.id),
            "template_id": str(template.id),
            "request_id": str(uuid.uuid4()),
        }
    path = f"/api/v1/meetings/{meeting_id}/analyses"
    response = client.post(path, json=payload)
    assert response.status_code == 202
    assert client.post(path, json=payload).json()["job_id"] == response.json()["job_id"]
    assert client.post(path, json={**payload, "request_id": str(uuid.uuid4())}).status_code == 409
    with session_factory() as db:
        assert count(db, Job, Job.type == JobType.TRANSCRIBE) == 0
        assert count(db, Job, Job.type == JobType.ANALYZE) == 1
        analysis = db.get(AnalysisVersion, uuid.UUID(response.json()["analysis"]["id"]))
        assert analysis.transcript_version_id == transcript.id
        assert analysis.template_snapshot["revision"] == 2
        meeting = db.get(Meeting, meeting_id)
        assert (meeting.ai_profile_id, meeting.template_snapshot) == original_settings


@pytest.mark.parametrize(
    "source",
    [MeetingSourceType.LIVE, MeetingSourceType.AUDIO_RECORDING, MeetingSourceType.SHARED_AUDIO],
)
def test_first_whole_transcription_freezes_selection_and_retries_reuse_final(
    client,
    session_factory,
    tmp_path,
    monkeypatch,
    source,
):
    with session_factory() as db:
        meeting, live, _, profile, template, media = seed(db, final=False)
        meeting.source_type = source
        meeting.ai_disabled = True  # Explicit regeneration works without changing meeting settings.
        if source == MeetingSourceType.LIVE:
            media.kind = MediaKind.TRANSCRIPTION_AUDIO
        capture = RealtimeSession(
            meeting_id=meeting.id,
            media_id=media.id,
            transcript_version_id=live.id,
            status=RealtimeSessionStatus.COMPLETED,
            mime_type="audio/webm",
        )
        db.add(capture)
        db.commit()
        meeting_id = meeting.id
        saved_snapshot = deepcopy(meeting.template_snapshot)
        profile_id, template_id = profile.id, template.id
        provider_id = profile.provider_id
    payload = {
        "profile_id": str(profile_id),
        "template_id": str(template_id),
        "request_id": str(uuid.uuid4()),
    }
    path = f"/api/v1/meetings/{meeting_id}/analyses"
    response = client.post(path, json=payload)
    assert response.status_code == 202 and response.json()["analysis"] is None
    assert client.post(path, json={**payload, "request_id": str(uuid.uuid4())}).status_code == 409
    with session_factory() as db:
        job = db.get(Job, uuid.UUID(response.json()["job_id"]))
        assert job.type == JobType.TRANSCRIBE
        assert count(db, Job, Job.type == JobType.ANALYZE) == 0
        profile = db.get(AIProfile, profile_id)
        profile.model, profile.temperature = "changed-model", 0.9
        template = db.get(MeetingTemplate, template_id)
        template.definition, template.revision = {"realtime": [], "final": []}, 3
        db.commit()
        whisper = FakeWhisperXClient()
        whisper.transcribe = Mock(wraps=whisper.transcribe)
        real_create = __import__(
            "app.services.transcription.processor", fromlist=["create_analysis_job"]
        ).create_analysis_job
        # Simulate a failure after Final has been persisted but before the continuation is reserved.
        monkeypatch.setattr(
            "app.services.transcription.processor.create_analysis_job",
            Mock(side_effect=AnalysisProcessingError("一時的な予約失敗")),
        )
        with pytest.raises(AnalysisProcessingError, match="予約失敗"):
            process_transcription_job(db, job, whisper, MediaStorage(tmp_path, 1))
        db.rollback()
        assert count(db, TranscriptVersion, TranscriptVersion.kind == TranscriptKind.FINAL) == 1
        fail_job(db, job, "一時的な予約失敗")
        assert client.post(f"/api/v1/jobs/{job.id}/retry").status_code == 200
        monkeypatch.setattr("app.services.transcription.processor.create_analysis_job", real_create)
        process_transcription_job(db, job, whisper, MediaStorage(tmp_path, 1))
        # A restart after scheduling the continuation must not enqueue it twice.
        process_transcription_job(db, job, whisper, MediaStorage(tmp_path, 1))
        assert whisper.transcribe.call_count == 1
        assert count(db, Job, Job.type == JobType.ANALYZE) == 1
        finish_job(db, job)
        analysis = db.scalar(select(AnalysisVersion))
        assert analysis.profile_id == profile_id and analysis.provider_id == provider_id
        assert analysis.model == "test-model" and analysis.temperature == 0.2
        assert analysis.template_snapshot["revision"] == 2
        assert analysis.template_snapshot["definition"] == template_definition()
        final = db.get(TranscriptVersion, analysis.transcript_version_id)
        assert final.kind == TranscriptKind.FINAL and final.id != live.id
        assert client.get(f"/api/v1/meetings/{meeting_id}/transcript?kind=live").json()[
            "id"
        ] == str(live.id)
        result = result_for(final.segments[-1].id)
        for row in [*result["chapters"], *result["highlights"]]:
            row["start_ms"], row["end_ms"] = 0, 2000
        runtime = FakeProvider(result)
        build = Mock(return_value=runtime)
        monkeypatch.setattr("app.services.analysis.processor.build_llm_provider", build)
        analysis_job = db.get(Job, analysis.job_id)
        process_analysis_job(db, analysis_job, get_settings())
        assert build.call_args.kwargs["model"] == "test-model"
        assert build.call_args.kwargs["temperature"] == 0.2
        finish_job(db, analysis_job)
        meeting = db.get(Meeting, meeting_id)
        assert meeting.ai_disabled and meeting.template_snapshot == saved_snapshot
        second = client.post(path, json={**payload, "request_id": str(uuid.uuid4())})
        assert second.status_code == 202
        assert count(db, Job, Job.type == JobType.TRANSCRIBE) == 1
        assert count(db, TranscriptVersion, TranscriptVersion.kind == TranscriptKind.FINAL) == 1


def test_snapshot_drives_prompt_validation_and_survives_later_template_edits(
    session_factory,
    monkeypatch,
    client,
):
    with session_factory() as db:
        meeting, _, segment, profile, template, _ = seed(db)
        analysis, job = regenerate_summary(
            db, meeting, AnalysisGenerateRequest(profile_id=profile.id, template_id=template.id)
        )
        frozen = deepcopy(analysis.template_snapshot)
        template.definition, template.revision = {"realtime": [], "final": []}, 3
        meeting.template_snapshot = {"definition": {"realtime": [], "final": []}}
        db.commit()
        output = result_for(segment.id)
        output["template_values"] = [
            {
                "card_id": "custom",
                "row_id": "row:0",
                "field_id": "value",
                "field_type": "short_text",
                "text_value": "結論",
                "evidence_segment_ids": [str(uuid.UUID(int=1))],
            }
        ]
        runtime = FakeProvider(output)
        original = runtime.generate_structured
        prompts = []

        async def capture(system, prompt, schema):
            prompts.append(prompt)
            return await original(system, prompt, schema)

        runtime.generate_structured = capture
        process_analysis_job(db, job, get_settings(), provider_override=runtime)
        assert "選択したカード" in prompts[0]
        assert "議論から確認できる結論を短く書く" in prompts[0]
        assert "重要事項を短い箇条書き" not in prompts[0]
        assert analysis.template_values[0]["evidence_segment_ids"] == [str(segment.id)]
        db.expire(analysis)
        assert analysis.template_snapshot == frozen
        finish_job(db, job)
        db.expire(template)
        assert template.revision == 3
        edited = client.patch(
            f"/api/v1/meeting-templates/{template.id}",
            json={
                "name": "後から編集",
                "expected_revision": 3,
            },
        )
        assert edited.status_code == 200 and edited.json()["revision"] == 4
        history = client.get(f"/api/v1/meetings/{meeting.id}/analyses/{analysis.id}")
        assert history.json()["template_snapshot"] == frozen


@pytest.mark.parametrize("invalid", ["profile", "template", "disabled", "unknown_field"])
def test_invalid_settings_do_not_create_jobs_or_replace_existing_results(
    client, session_factory, invalid
):
    with session_factory() as db:
        meeting, _, _, profile, _, _ = seed(db)
        meeting_id = meeting.id
        original_transcript = meeting.active_transcript_version_id
        if invalid == "disabled":
            db.get(AIProviderConfig, profile.provider_id).enabled = False
            db.commit()
        payload = {"profile_id": str(profile.id)}
        if invalid == "profile":
            payload["profile_id"] = str(uuid.uuid4())
        if invalid == "template":
            payload["template_id"] = str(uuid.uuid4())
        if invalid == "unknown_field":
            payload["summary_format"] = "bullet"
    response = client.post(f"/api/v1/meetings/{meeting_id}/analyses", json=payload)
    assert response.status_code == (422 if invalid == "unknown_field" else 409)
    with session_factory() as db:
        assert count(db, Job) == 0 and count(db, AnalysisVersion) == 0
        assert db.get(Meeting, meeting_id).active_transcript_version_id == original_transcript


@pytest.mark.parametrize(
    "status", [RealtimeSessionStatus.RECORDING, RealtimeSessionStatus.FINALIZING]
)
def test_recording_blocks_regeneration_even_with_final(client, session_factory, status):
    with session_factory() as db:
        meeting, transcript, _, profile, _, media = seed(db)
        db.add(
            RealtimeSession(
                meeting_id=meeting.id,
                media_id=media.id,
                transcript_version_id=transcript.id,
                status=status,
                mime_type="audio/webm",
            )
        )
        db.commit()
        meeting_id = meeting.id
    response = client.post(
        f"/api/v1/meetings/{meeting_id}/analyses", json={"profile_id": str(profile.id)}
    )
    assert response.status_code == 409
    with session_factory() as db:
        assert count(db, Job) == 0


def test_external_failure_keeps_old_results_and_retry_is_blocked_by_other_work(
    client, session_factory
):
    with session_factory() as db:
        meeting, _, segment, profile, _, _ = seed(db)
        first, first_job = regenerate_summary(
            db, meeting, AnalysisGenerateRequest(profile_id=profile.id)
        )
        process_analysis_job(
            db, first_job, get_settings(), provider_override=FakeProvider(result_for(segment.id))
        )
        finish_job(db, first_job)
        first.items[0].content, first.items[0].state = (
            "ユーザー確定済み",
            AnalysisItemState.CONFIRMED,
        )
        db.commit()
        second, job = regenerate_summary(
            db, meeting, AnalysisGenerateRequest(profile_id=profile.id)
        )
        runtime = Mock()
        runtime.generate_structured = Mock(side_effect=RuntimeError("外部API障害"))
        with pytest.raises(RuntimeError, match="外部API障害"):
            process_analysis_job(db, job, get_settings(), provider_override=runtime)
        db.rollback()
        fail_job(db, job, "外部API障害")
        assert second.status == AnalysisStatus.FAILED and second.error_message == "外部API障害"
        assert meeting.active_analysis_version_id == first.id
        assert first.items[0].content == "ユーザー確定済み"
        third, third_job = regenerate_summary(
            db, meeting, AnalysisGenerateRequest(profile_id=profile.id)
        )
        assert client.post(f"/api/v1/jobs/{job.id}/retry").status_code == 409
        process_analysis_job(
            db, third_job, get_settings(), provider_override=FakeProvider(result_for(segment.id))
        )
        finish_job(db, third_job)
        assert any(
            item.content == "ユーザー確定済み" and item.state == AnalysisItemState.CONFIRMED
            for item in third.items
        )
        assert client.post(f"/api/v1/jobs/{job.id}/retry").status_code == 200
        assert client.post(f"/api/v1/jobs/{job.id}/retry").status_code == 409


def test_worker_refuses_live_input_and_changed_connection(session_factory):
    with session_factory() as db:
        meeting, transcript, _, profile, _, _ = seed(db)
        analysis, job = regenerate_summary(
            db, meeting, AnalysisGenerateRequest(profile_id=profile.id)
        )
        transcript.kind = TranscriptKind.LIVE
        db.commit()
        runtime = Mock()
        with pytest.raises(AnalysisProcessingError, match="確定Transcript"):
            process_analysis_job(db, job, get_settings(), provider_override=runtime)
        runtime.generate_structured.assert_not_called()
        transcript.kind = TranscriptKind.FINAL
        db.get(AIProviderConfig, profile.provider_id).base_url = "http://changed.invalid"
        db.commit()
        with pytest.raises(AnalysisProcessingError, match="接続先"):
            process_analysis_job(db, job, get_settings(), provider_override=runtime)
        runtime.generate_structured.assert_not_called()


def test_final_is_reused_even_when_active_points_to_live(session_factory):
    with session_factory() as db:
        meeting, final, _, profile, _, _ = seed(db)
        live = TranscriptVersion(
            meeting_id=meeting.id,
            version=1,
            kind=TranscriptKind.LIVE,
            status=final.status,
            language="ja",
            model="live",
            diarization_enabled=False,
        )
        db.add(live)
        db.flush()
        meeting.active_transcript_version_id = live.id
        db.commit()
        analysis, job = regenerate_summary(
            db, meeting, AnalysisGenerateRequest(profile_id=profile.id)
        )
        assert analysis.transcript_version_id == final.id and job.type == JobType.ANALYZE
        assert count(db, Job, Job.type == JobType.TRANSCRIBE) == 0


def test_default_uses_meeting_snapshot_and_explicit_selection_uses_latest_revision(session_factory):
    with session_factory() as db:
        meeting, _, segment, _, template, _ = seed(db)
        frozen = deepcopy(meeting.template_snapshot)
        meeting.template_snapshot = {**meeting.template_snapshot, "template_id": str(template.id)}
        frozen["template_id"] = str(template.id)
        db.commit()
        first, job = regenerate_summary(db, meeting, AnalysisGenerateRequest())
        assert first.template_snapshot == frozen
        assert first.profile_id == meeting.ai_profile_id
        process_analysis_job(
            db, job, get_settings(), provider_override=FakeProvider(result_for(segment.id))
        )
        finish_job(db, job)
        second, _ = regenerate_summary(
            db, meeting, AnalysisGenerateRequest(template_id=template.id)
        )
        assert second.template_snapshot["revision"] == 2
        assert meeting.template_snapshot == frozen


@pytest.mark.parametrize(
    "condition", ["stale_template", "revision_without_id", "missing_audio", "preprocessing"]
)
def test_unavailable_or_conflicting_settings_leave_existing_data(
    client, session_factory, condition
):
    with session_factory() as db:
        meeting, live, _, profile, template, media = seed(db, final=False)
        meeting_id = meeting.id
        payload = {"profile_id": str(profile.id)}
        if condition == "stale_template":
            payload.update(template_id=str(template.id), template_revision=1)
        elif condition == "revision_without_id":
            payload["template_revision"] = 1
        elif condition == "missing_audio":
            db.delete(media)
        elif condition == "preprocessing":
            db.add(Job(meeting_id=meeting.id, type=JobType.PREPROCESS_MEDIA))
        db.commit()
    response = client.post(f"/api/v1/meetings/{meeting_id}/analyses", json=payload)
    assert response.status_code == (422 if condition == "revision_without_id" else 409)
    with session_factory() as db:
        assert count(db, Job, Job.type.in_((JobType.TRANSCRIBE, JobType.ANALYZE))) == 0
        assert db.get(TranscriptVersion, live.id) is not None

import copy
import json
import uuid

import pytest
from sqlalchemy import select
from test_realtime_analysis import FakeRealtimeProvider, _seed

from app.core.config import get_settings
from app.models import Job, JobStatus, JobType, RealtimeSession, TranscriptSegment
from app.models.realtime import RealtimeSessionStatus
from app.models.realtime_analysis import RealtimeAnalysisStatus
from app.services.analysis.realtime import (
    RealtimeAnalysisError,
    process_realtime_analysis_job,
    schedule_realtime_analysis,
)
from app.services.jobs import finish_job
from app.workers import realtime_ai


class TemplateProvider(FakeRealtimeProvider):
    def __init__(self, values, *, invalid_evidence=False, unavailable=False):
        super().__init__()
        self.values = values
        self.invalid_evidence = invalid_evidence
        self.unavailable = unavailable

    async def generate_structured(self, system_prompt, prompt, schema):
        payload = json.loads(prompt.splitlines()[-1])
        self.payloads.append(payload)
        if self.unavailable:
            raise RuntimeError("AI接続に失敗しました")
        evidence_id = payload["changes"]["upsert_segments"][-1]["evidence_id"]
        template_evidence_id = str(uuid.uuid4()) if self.invalid_evidence else evidence_id
        return schema.model_validate(
            {
                "input_revision": payload["input_revision"],
                "as_of_ms": payload["as_of_ms"],
                "summary": {"content": "確認した内容", "evidence_segment_ids": [evidence_id]},
                "template_values": [
                    {
                        "card_id": "custom",
                        "row_id": "custom:0",
                        "field_id": kind,
                        "field_type": kind,
                        key: value,
                        "evidence_segment_ids": [] if value is None else [template_evidence_id],
                    }
                    for kind, key, value in self.values
                ],
            }
        )


@pytest.fixture
def template_capture(session_factory, tmp_path, monkeypatch):
    monkeypatch.setattr(realtime_ai, "SessionLocal", session_factory)
    with session_factory() as session:
        meeting, capture, transcript = _seed(session, tmp_path)
        capture.transcription_provider = "soniox"
        transcript.model = "stt-rt-v5"
        capture.transcription_request = {
            "provider": "soniox",
            "model": transcript.model,
            "language": "ja",
            "language_hints": ["ja"],
            "language_hints_strict": False,
        }
        meeting.template_snapshot = {
            "definition": {
                "realtime": [
                    {
                        "id": "custom",
                        "title": "追加情報",
                        "visible": True,
                        "fields": [
                            {"id": kind, "name": kind, "type": kind}
                            for kind in ["short_text", "long_text", "number", "date", "boolean"]
                        ]
                        + [
                            {
                                "id": "single_select",
                                "name": "状態",
                                "type": "single_select",
                                "options": ["確認済み", "未確認"],
                            }
                        ],
                    }
                ],
                "final": [],
            }
        }
        transcript.segments.append(
            TranscriptSegment(
                start_ms=1000,
                end_ms=8000,
                text="担当者は田中、件数は0、完了はfalse、日付は2026-10-14です。",
                provisional_speaker_label="SPEAKER_00",
                sequence=0,
            )
        )
        capture.duration_ms = 15_000
        session.commit()
        return capture.id


def queue_analysis(session, capture):
    state = schedule_realtime_analysis(session, capture, force=True)
    assert state is not None
    job = session.scalar(
        select(Job).where(Job.meeting_id == capture.meeting_id, Job.status == JobStatus.QUEUED)
    )
    assert job is not None and job.type == JobType.ANALYZE_REALTIME
    job.status = JobStatus.RUNNING
    session.commit()
    return state, job


def complete_analysis(session, capture, provider):
    state, job = queue_analysis(session, capture)
    process_realtime_analysis_job(session, job, get_settings(), provider_override=provider)
    finish_job(session, job)
    session.expire_all()
    assert state.status == RealtimeAnalysisStatus.COMPLETED
    assert state.error_message is None
    return state


def add_next_segment(session, capture):
    session.add(
        TranscriptSegment(
            transcript_version_id=capture.transcript_version_id,
            start_ms=16_000,
            end_ms=24_000,
            text="担当者の変更を確認しました。",
            provisional_speaker_label="SPEAKER_00",
            sequence=1,
        )
    )
    capture.duration_ms = 30_000
    session.commit()


@pytest.mark.parametrize(
    ("kind", "key", "value"),
    [
        ("short_text", "text_value", "田中"),
        ("long_text", "text_value", "確認した会議内容です。"),
        ("number", "number_value", 0),
        ("date", "text_value", "2026-10-14"),
        ("boolean", "boolean_value", False),
        ("single_select", "text_value", "確認済み"),
        ("short_text", "text_value", None),
    ],
)
def test_processor_saves_typed_template_values(
    client, session_factory, template_capture, kind, key, value
):
    with session_factory() as session:
        capture = session.get(RealtimeSession, template_capture)
        state = complete_analysis(session, capture, TemplateProvider([(kind, key, value)]))
        saved = state.snapshot["template_values"]
        assert len(saved) == 1
        assert saved[0]["field_id"] == saved[0]["field_type"] == kind
        assert saved[0][key] == value
        assert saved[0]["evidence_segment_ids"] == (
            [] if value is None else [state.source_segments[0]["evidence_id"]]
        )
        assert state.snapshot["input_revision"] == state.processed_revision == 1
        assert capture.status == RealtimeSessionStatus.RECORDING
        response = client.get(f"/api/v1/meetings/{capture.meeting_id}/live/analysis")
        assert response.status_code == 200
        assert response.json()["status"] == "completed"
        assert response.json()["snapshot"]["template_values"] == saved


def test_processor_retains_previous_zero_false_and_null_values_when_updating(
    session_factory, template_capture
):
    with session_factory() as session:
        capture = session.get(RealtimeSession, template_capture)
        state = complete_analysis(
            session,
            capture,
            TemplateProvider(
                [
                    ("short_text", "text_value", "田中"),
                    ("number", "number_value", 0),
                    ("boolean", "boolean_value", False),
                    ("date", "text_value", None),
                ]
            ),
        )
        previous = copy.deepcopy(state.snapshot["template_values"])
        add_next_segment(session, capture)
        state = complete_analysis(
            session, capture, TemplateProvider([("short_text", "text_value", "佐藤")])
        )
        saved = {item["field_id"]: item for item in state.snapshot["template_values"]}
        assert len(saved) == 4
        assert saved["short_text"]["text_value"] == "佐藤"
        assert saved["short_text"]["evidence_segment_ids"] == [
            state.source_segments[1]["evidence_id"]
        ]
        for item in previous:
            if item["field_id"] != "short_text":
                assert saved[item["field_id"]] == item
        assert state.processed_revision == state.snapshot["input_revision"] == 2


@pytest.mark.parametrize("failure", ["evidence", "choice", "api"])
def test_processor_failure_preserves_previous_snapshot_and_retry_succeeds(
    client, session_factory, template_capture, failure
):
    with session_factory() as session:
        capture = session.get(RealtimeSession, template_capture)
        state = complete_analysis(
            session, capture, TemplateProvider([("short_text", "text_value", "田中")])
        )
        previous_snapshot = copy.deepcopy(state.snapshot)
        previous_source = copy.deepcopy(state.source_segments)
        add_next_segment(session, capture)
        state, job = queue_analysis(session, capture)
        values = [("short_text", "text_value", "佐藤")]
        if failure == "choice":
            values = [("single_select", "text_value", "不正な選択肢")]
        provider = TemplateProvider(
            values, invalid_evidence=failure == "evidence", unavailable=failure == "api"
        )
        expected = "AI接続" if failure == "api" else "Evidence|フィールド型"
        with pytest.raises((RealtimeAnalysisError, RuntimeError), match=expected) as error:
            process_realtime_analysis_job(session, job, get_settings(), provider_override=provider)
        session.rollback()
        realtime_ai._fail(job.id, str(error.value))
        session.expire_all()
        assert state.status == RealtimeAnalysisStatus.FAILED
        assert job.status == JobStatus.FAILED
        assert state.snapshot == previous_snapshot
        assert state.source_segments == previous_source
        assert capture.status == RealtimeSessionStatus.RECORDING
        response = client.get(f"/api/v1/meetings/{capture.meeting_id}/live/analysis")
        assert response.status_code == 200
        assert response.json()["status"] == "failed"
        assert response.json()["snapshot"] == previous_snapshot

        retried = client.post(f"/api/v1/jobs/{job.id}/retry")
        assert retried.status_code == 200
        session.expire_all()
        job.status = JobStatus.RUNNING
        session.commit()
        process_realtime_analysis_job(
            session,
            job,
            get_settings(),
            provider_override=TemplateProvider([("short_text", "text_value", "佐藤")]),
        )
        finish_job(session, job)
        session.expire_all()
        assert state.status == RealtimeAnalysisStatus.COMPLETED
        assert state.error_message is None
        assert state.snapshot["template_values"][0]["text_value"] == "佐藤"
        assert state.processed_revision == state.snapshot["input_revision"] == 2
        assert len(state.source_segments) == 2
        assert all(item.type == JobType.ANALYZE_REALTIME for item in session.scalars(select(Job)))

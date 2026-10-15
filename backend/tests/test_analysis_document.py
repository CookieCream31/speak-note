import importlib.util
import uuid
from copy import deepcopy
from pathlib import Path

import pytest
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine, inspect, text
from test_analysis_phase5 import FakeProvider, result_for
from test_meeting_questions import FakeQuestionProvider
from test_post_meeting_notes import notes as notes
from test_summary_regeneration import count

from app.core.config import get_settings
from app.models.analysis import AnalysisStatus, AnalysisVersion
from app.models.job import Job, JobType
from app.models.meeting import Meeting
from app.models.question import MeetingQuestion
from app.models.realtime import RealtimeSession, RealtimeSessionStatus
from app.models.transcript import TranscriptKind, TranscriptStatus, TranscriptVersion
from app.schemas.analysis import AnalysisGenerateRequest, AnalysisItemRead
from app.services.analysis import process_analysis_job
from app.services.analysis.regeneration import regenerate_summary
from app.services.analysis_document import render_analysis_document
from app.services.jobs import finish_job
from app.services.questions import process_meeting_question_job


def analysis_path(notes):
    return f"/api/v1/meetings/{notes['meeting']}/analyses/{notes['analysis']}"


@pytest.mark.parametrize("kind", [TranscriptKind.LIVE, TranscriptKind.FINAL])
def test_whole_document_save_reload_and_conflict_preserve_generated_data(
    client, session_factory, notes, kind
):
    with session_factory() as db:
        db.get(TranscriptVersion, notes["live"]).kind = kind
        db.get(AnalysisVersion, notes["analysis"]).template_snapshot = None
        db.commit()
    path = analysis_path(notes)
    before = client.get(path).json()
    original = client.get(
        f"/api/v1/meetings/{notes['meeting']}/transcript?version_id={notes['live']}"
    ).json()
    assert before["document_revision"] == 0 and before["document_content"] is None
    assert before["items"][0]["content"] in before["document_text"]
    content = "\n自由な見出し\n\n  追記したメモ\n" + "長い本文" * 6000 + "\n "
    saved = client.patch(path + "/document", json={"content": content, "expected_revision": 0})
    assert saved.status_code == 200 and saved.json()["content"] == content
    assert saved.json()["revision"] == 1 and saved.json()["updated_at"]
    assert (
        client.patch(
            path + "/document", json={"content": "古い編集", "expected_revision": 0}
        ).status_code
        == 409
    )
    reloaded = client.get(path).json()
    active = client.get(f"/api/v1/meetings/{notes['meeting']}/analysis").json()
    assert active["document_text"] == reloaded["document_text"] == content
    assert reloaded["document_content"] == content
    assert reloaded["document_revision"] == 1
    for field in (
        "items",
        "template_values",
        "template_snapshot",
        "transcript_version_id",
        "transcript_kind",
    ):
        assert reloaded[field] == before[field]
    assert (
        client.get(
            f"/api/v1/meetings/{notes['meeting']}/transcript?version_id={notes['live']}"
        ).json()
        == original
    )
    with session_factory() as db:
        assert count(db, Job, Job.type == JobType.TRANSCRIBE) == 0
        assert count(db, Job, Job.type == JobType.ANALYZE) == 1


def test_document_can_be_cleared_without_falling_back_to_ai_text(client, notes):
    path = analysis_path(notes)
    assert (
        client.patch(path + "/document", json={"content": "", "expected_revision": 0}).status_code
        == 200
    )
    assert client.get(path).json()["document_text"] == ""
    assert (
        client.patch(
            path + "/document", json={"content": "メモのみ", "expected_revision": 1}
        ).status_code
        == 200
    )
    assert client.get(path).json()["document_text"] == "メモのみ"


def test_freeform_notes_do_not_become_question_evidence(client, session_factory, notes):
    path = analysis_path(notes)
    memo = "ユーザーだけが追記した架空のメモ"
    assert (
        client.patch(path + "/document", json={"content": memo, "expected_revision": 0}).status_code
        == 200
    )
    question = client.post(
        f"/api/v1/meetings/{notes['meeting']}/questions",
        json={"question": "会議での結論は？", "analysis_id": str(notes["analysis"])},
    ).json()
    runtime = FakeQuestionProvider(
        {"answer": "保存された発言からの回答", "evidence_segment_ids": [str(notes["segment"])]}
    )
    with session_factory() as db:
        process_meeting_question_job(
            db,
            db.get(Job, uuid.UUID(question["job_id"])),
            get_settings(),
            provider_override=runtime,
        )
        assert memo not in runtime.prompt
        saved = db.get(MeetingQuestion, uuid.UUID(question["id"]))
        assert saved.transcript_version_id == notes["live"]
        assert [item.segment_id for item in saved.evidence] == [notes["segment"]]


def test_document_prefers_the_existing_protected_summary(client, notes):
    data = client.get(analysis_path(notes)).json()
    original = next(item for item in data["items"] if item["kind"] == "summary")
    protected = AnalysisItemRead.model_validate(
        {**original, "state": "confirmed", "content": "確認した本文"}
    )
    regenerated = protected.model_copy(
        update={"state": "generated", "content": "新しく生成した本文", "sequence": 100}
    )
    result = render_analysis_document([protected, regenerated], None, [])
    assert result.count("確認した本文") == 1
    assert "新しく生成した本文" not in result


def test_saved_template_order_fields_and_protected_items_form_one_document(
    client, session_factory, notes
):
    with session_factory() as db:
        analysis = db.get(AnalysisVersion, notes["analysis"])
        summary = next(item for item in analysis.items if item.kind == "summary")
        summary.state, summary.content = "confirmed", "以前に確認した要約"
        snapshot = deepcopy(analysis.template_snapshot)
        snapshot["definition"]["final"] = [
            {
                "id": "custom",
                "title": "追記用の情報",
                "fields": [
                    {"id": "count", "name": "件数", "type": "number"},
                    {"id": "checked", "name": "対応済み", "type": "boolean"},
                    {"id": "memo", "name": "説明", "type": "long_text"},
                ],
            },
            {"id": "summary", "title": "保存時の会議概要", "core_kind": "summary", "fields": []},
            {
                "id": "hidden",
                "title": "非表示カード",
                "visible": False,
                "show_when_empty": True,
                "fields": [],
            },
            {"id": "empty", "title": "空のカード", "fields": []},
        ]
        analysis.template_snapshot = snapshot
        analysis.template_values = [
            {
                "card_id": "custom",
                "row_id": "row:0",
                "field_id": "count",
                "field_type": "number",
                "number_value": 0,
            },
            {
                "card_id": "custom",
                "row_id": "row:0",
                "field_id": "checked",
                "field_type": "boolean",
                "boolean_value": False,
            },
        ]
        db.get(Meeting, notes["meeting"]).template_snapshot = {
            "definition": {"realtime": [], "final": []}
        }
        db.commit()
    result = client.get(analysis_path(notes)).json()
    assert (
        result["document_text"] == "追記用の情報\n件数: 0\n対応済み: いいえ\n説明: 未入力\n\n"
        "保存時の会議概要\n以前に確認した要約"
    )
    assert result["template_snapshot"] == snapshot


def test_legacy_items_and_action_metadata_are_kept_in_document(client, session_factory, notes):
    with session_factory() as db:
        db.get(AnalysisVersion, notes["analysis"]).template_snapshot = None
        db.commit()
    before = client.get(analysis_path(notes)).json()
    for item in before["items"]:
        if item["kind"] != "highlight":
            assert item["content"] in before["document_text"]
    assert "担当:" in before["document_text"]
    item = next(item for item in before["items"] if item["kind"] == "summary")
    assert (
        client.patch(
            analysis_path(notes) + f"/items/{item['id']}", json={"content": "既存の項目編集"}
        ).status_code
        == 200
    )
    assert (
        client.patch(
            analysis_path(notes) + "/document", json={"content": "古い本文", "expected_revision": 0}
        ).status_code
        == 409
    )
    assert "既存の項目編集" in client.get(analysis_path(notes)).json()["document_text"]


@pytest.mark.parametrize(
    "invalid",
    [
        "recording",
        "finalizing",
        "failed_capture",
        "processing",
        "failed",
        "failed_transcript",
        "empty",
    ],
)
def test_document_edit_rejects_unfinished_or_unsaved_sources(
    client, session_factory, notes, invalid
):
    with session_factory() as db:
        if invalid in {"recording", "finalizing", "failed_capture"}:
            db.get(RealtimeSession, notes["capture"]).status = RealtimeSessionStatus(
                invalid.removesuffix("_capture")
            )
        elif invalid in {"processing", "failed"}:
            db.get(AnalysisVersion, notes["analysis"]).status = AnalysisStatus(invalid)
        elif invalid == "empty":
            transcript = db.get(TranscriptVersion, notes["live"])
            transcript.segments.clear()
        else:
            db.get(TranscriptVersion, notes["live"]).status = TranscriptStatus.FAILED
        db.commit()
    assert (
        client.patch(
            analysis_path(notes) + "/document", json={"content": "保存不可", "expected_revision": 0}
        ).status_code
        == 409
    )
    with session_factory() as db:
        analysis = db.get(AnalysisVersion, notes["analysis"])
        assert analysis.document_content is None and analysis.document_revision == 0


def test_document_input_and_meeting_boundaries(client, session_factory, notes):
    path = analysis_path(notes) + "/document"
    for payload in (
        {"content": "revisionなし"},
        {"content": None, "expected_revision": 0},
        {"content": "x", "expected_revision": -1},
        {"content": "x", "expected_revision": 0, "state": "generated"},
        {"content": "x" * 5_000_001, "expected_revision": 0},
    ):
        assert client.patch(path, json=payload).status_code == 422
    with session_factory() as db:
        meeting = Meeting(
            title="別の会議", source_type=db.get(Meeting, notes["meeting"]).source_type
        )
        db.add(meeting)
        db.commit()
        other_id = meeting.id
    assert (
        client.patch(
            f"/api/v1/meetings/{other_id}/analyses/{notes['analysis']}/document",
            json={"content": "x", "expected_revision": 0},
        ).status_code
        == 404
    )
    assert (
        client.patch(
            path.replace(str(notes["analysis"]), "realtime"),
            json={"content": "x", "expected_revision": 0},
        ).status_code
        == 422
    )


def test_regeneration_keeps_edited_document_in_its_original_history(client, session_factory, notes):
    path = analysis_path(notes)
    assert (
        client.patch(
            path + "/document", json={"content": "ユーザーの追記メモ", "expected_revision": 0}
        ).status_code
        == 200
    )
    before = client.get(path).json()
    with session_factory() as db:
        next_analysis, job = regenerate_summary(
            db,
            db.get(Meeting, notes["meeting"]),
            AnalysisGenerateRequest(profile_id=notes["profile"], reuse_saved_transcript=True),
        )
        process_analysis_job(
            db, job, get_settings(), provider_override=FakeProvider(result_for(notes["segment"]))
        )
        finish_job(db, job)
        assert next_analysis.document_content is None and next_analysis.document_revision == 0
        assert next_analysis.id != notes["analysis"]
    assert client.get(path).json() == before
    assert (
        client.get(f"/api/v1/meetings/{notes['meeting']}/analysis").json()["document_text"]
        != "ユーザーの追記メモ"
    )


def test_analysis_document_migration_preserves_existing_rows() -> None:
    path = Path(__file__).parents[1] / "alembic/versions/20261016_0032_analysis_document.py"
    spec = importlib.util.spec_from_file_location("analysis_document_migration", path)
    assert spec is not None and spec.loader is not None
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    assert migration.down_revision == "20261014_0031"
    engine = create_engine("sqlite://")
    with engine.begin() as connection:
        connection.execute(
            text("CREATE TABLE analysis_versions (id TEXT PRIMARY KEY, template_snapshot TEXT)")
        )
        connection.execute(text("INSERT INTO analysis_versions VALUES ('existing', 'snapshot')"))
        with Operations.context(MigrationContext.configure(connection)):
            migration.upgrade()
            row = connection.execute(text("SELECT * FROM analysis_versions")).mappings().one()
            assert row["document_content"] is None and row["document_revision"] == 0
            assert row["document_updated_at"] is None and row["template_snapshot"] == "snapshot"
            connection.execute(
                text(
                    "UPDATE analysis_versions SET document_content = '自由な本文', "
                    "document_revision = 1"
                )
            )
            migration.downgrade()
        assert [
            column["name"] for column in inspect(connection).get_columns("analysis_versions")
        ] == ["id", "template_snapshot"]
        assert (
            connection.execute(text("SELECT template_snapshot FROM analysis_versions")).scalar_one()
            == "snapshot"
        )
    engine.dispose()

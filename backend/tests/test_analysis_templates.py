import uuid

import pytest

from app.schemas.analysis import TemplateValueOutput
from app.services.analysis.realtime_templates import (
    RealtimeTemplateValueError,
    merge_realtime_template_values,
    validate_realtime_template_values,
)
from app.services.analysis.templates import TemplateValueError, validate_template_values


def value(field_type: str, **kwargs: object) -> TemplateValueOutput:
    return TemplateValueOutput(
        card_id="custom",
        row_id="row:0",
        field_id="value",
        field_type=field_type,
        **kwargs,
    )


def final_snapshot(field_type: str = "single_select") -> dict:
    return {
        "definition": {
            "final": [{
                "id": "custom",
                "visible": True,
                "core_kind": None,
                "fields": [{
                    "id": "value",
                    "type": field_type,
                    "options": ["進行中", "完了"] if field_type == "single_select" else [],
                }],
            }],
        },
    }


def test_final_template_values_validate_type_option_and_transcript_evidence() -> None:
    evidence_id = uuid.uuid4()
    segments = {evidence_id: object()}
    valid = value("single_select", text_value="完了", evidence_segment_ids=[evidence_id])

    assert validate_template_values([valid], final_snapshot(), segments, set()) == [{
        "card_id": "custom",
        "row_id": "row:0",
        "field_id": "value",
        "field_type": "single_select",
        "text_value": "完了",
        "number_value": None,
        "boolean_value": None,
        "state": "generated",
        "evidence_segment_ids": [str(evidence_id)],
    }]

    with pytest.raises(TemplateValueError, match="一致しません"):
        validate_template_values(
            [value("short_text", text_value="完了", evidence_segment_ids=[evidence_id])],
            final_snapshot(), segments, set(),
        )
    with pytest.raises(TemplateValueError, match="型または選択肢"):
        validate_template_values(
            [value("single_select", text_value="保留", evidence_segment_ids=[evidence_id])],
            final_snapshot(), segments, set(),
        )
    with pytest.raises(TemplateValueError, match="存在しない"):
        validate_template_values(
            [value("single_select", text_value="完了", evidence_segment_ids=[uuid.uuid4()])],
            final_snapshot(), segments, set(),
        )


def test_final_null_value_cannot_claim_evidence() -> None:
    evidence_id = uuid.uuid4()
    with pytest.raises(TemplateValueError, match="不明値"):
        validate_template_values(
            [value("single_select", text_value=None, evidence_segment_ids=[evidence_id])],
            final_snapshot(), {evidence_id: object()}, set(),
        )


def test_realtime_template_validation_and_value_merge_keep_supported_values() -> None:
    evidence_id = uuid.uuid4()
    live = [{"evidence_id": str(evidence_id)}]
    realtime_snapshot = {
        "definition": {
            "realtime": [{
                "id": "custom", "visible": True, "core_kind": None,
                "fields": [{"id": "value", "type": "single_select", "options": ["進行中", "完了"]}],
            }],
        },
    }
    current = value("single_select", text_value="進行中", evidence_segment_ids=[evidence_id])
    serialized = validate_realtime_template_values([current], realtime_snapshot, live, set())
    assert serialized[0]["value"] == "進行中"
    assert serialized[0]["text_value"] == "進行中"
    assert serialized[0]["evidence_segment_ids"] == [str(evidence_id)]

    with pytest.raises(RealtimeTemplateValueError, match="Evidence"):
        validate_realtime_template_values(
            [current], realtime_snapshot, [{"evidence_id": str(uuid.uuid4())}], set()
        )

    previous = {"template_values": [
        {"card_id": "custom", "row_id": "row:0", "field_id": "value", "field_type": "single_select",
         "value": "進行中", "text_value": "進行中", "evidence_segment_ids": [str(evidence_id)]},
        {"card_id": "custom", "row_id": "row:1", "field_id": "value", "field_type": "single_select",
         "value": None, "text_value": None, "evidence_segment_ids": []},
    ]}
    replacement = {**serialized[0], "value": "完了", "text_value": "完了"}
    merged = merge_realtime_template_values(previous, [replacement], live)
    assert len(merged) == 2
    assert merged[0]["value"] == "完了"
    assert merged[0]["text_value"] == "完了"
    assert merged[1]["value"] is None


def test_legacy_meeting_without_template_snapshot_remains_valid(client) -> None:
    response = client.post(
        "/api/v1/meetings", json={"title": "Legacy style", "source_type": "audio_upload"}
    )
    assert response.status_code == 201
    assert response.json()["template_id"] is None
    assert response.json()["template_snapshot"] is None

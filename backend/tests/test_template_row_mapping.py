import uuid
from types import SimpleNamespace

from app.models.analysis import AnalysisItemKind
from app.schemas.analysis import StructuredMinutesOutput
from app.schemas.realtime_analysis import RealtimeAnalysisOutput
from app.services.analysis.realtime import (
    _core_row_identities,
    _remap_realtime_core_values,
    _stabilize_snapshot,
)
from app.services.analysis.realtime_templates import merge_realtime_template_values
from app.services.analysis.template_rows import remap_final_core_rows


def test_realtime_core_values_follow_rows_after_stabilization() -> None:
    evidence_id = uuid.uuid4()
    template_snapshot = {
        "definition": {
            "realtime": [{"id": "decisions", "core_kind": "decision"}],
        },
    }
    previous = {
        "decisions": [
            {
                "content": "維持する決定",
                "status": "explicit",
                "evidence_segment_ids": [str(evidence_id)],
            },
            {
                "content": "撤回された決定",
                "status": "explicit",
                "evidence_segment_ids": [str(evidence_id)],
            },
        ],
        "template_values": [
            {
                "card_id": "decisions", "row_id": "decision:0", "field_id": "note",
                "field_type": "short_text", "text_value": "前回値", "value": "前回値",
                "evidence_segment_ids": [str(evidence_id)],
            },
            {
                "card_id": "decisions", "row_id": "decision:1", "field_id": "note",
                "field_type": "short_text", "text_value": "削除値", "value": "削除値",
                "evidence_segment_ids": [str(evidence_id)],
            },
        ],
    }
    result = RealtimeAnalysisOutput.model_validate(
        {
            "input_revision": 2,
            "as_of_ms": 1000,
            "summary": {"content": "要約です。", "evidence_segment_ids": [evidence_id]},
            "decisions": [
                {"content": "新しい決定", "evidence_segment_ids": [evidence_id]},
                {"content": "維持する決定", "evidence_segment_ids": [evidence_id]},
            ],
            "superseded": {
                "decisions": [{"index": 1, "evidence_segment_ids": [evidence_id]}]
            },
            "template_values": [],
        }
    )
    ai_values = [
        {
            "card_id": "decisions", "row_id": "decision:0", "field_id": "note",
            "field_type": "short_text", "text_value": "新値", "value": "新値",
            "evidence_segment_ids": [str(evidence_id)],
        },
        {
            "card_id": "decisions", "row_id": "decision:1", "field_id": "note",
            "field_type": "short_text", "text_value": "AI維持値", "value": "AI維持値",
            "evidence_segment_ids": [str(evidence_id)],
        },
    ]

    previous_rows = _core_row_identities(previous)
    ai_rows = _core_row_identities(result)
    _stabilize_snapshot(previous, result, [{"evidence_id": str(evidence_id)}])
    final_rows = _core_row_identities(result)

    assert [item.content for item in result.decisions] == ["維持する決定", "新しい決定"]
    assert _remap_realtime_core_values(
        template_snapshot, ai_rows, final_rows, ai_values
    ) == [
        {**ai_values[0], "row_id": "decision:1"},
        {**ai_values[1], "row_id": "decision:0"},
    ]
    assert _remap_realtime_core_values(
        template_snapshot, previous_rows, final_rows, previous["template_values"]
    ) == [{**previous["template_values"][0], "row_id": "decision:0"}]


def test_final_core_values_follow_saved_item_order() -> None:
    evidence_id = uuid.uuid4()
    result = StructuredMinutesOutput.model_validate(
        {
            "summary": "要約",
            "summary_evidence_segment_ids": [evidence_id],
            "decisions": [
                {"content": "新しい決定", "evidence_segment_ids": [evidence_id]},
                {"content": "確認済み決定", "evidence_segment_ids": [evidence_id]},
            ],
        }
    )
    snapshot = {
        "definition": {
            "final": [{"id": "decisions", "core_kind": "decision"}],
        },
    }
    values = [
        {"card_id": "decisions", "row_id": "decision:0", "field_id": "note", "value": "新規値"},
        {"card_id": "decisions", "row_id": "decision:1", "field_id": "note", "value": "確認値"},
    ]
    saved_items = [
        SimpleNamespace(kind="decision", content="確認済み決定"),
        SimpleNamespace(kind="decision", content="新しい決定"),
    ]

    assert remap_final_core_rows(snapshot, result, saved_items, values) == [
        {**values[0], "row_id": "decision:1"},
        {**values[1], "row_id": "decision:0"},
    ]


def test_ambiguous_duplicate_core_rows_are_hidden() -> None:
    evidence_id = uuid.uuid4()
    template_snapshot = {
        "definition": {"realtime": [{"id": "decisions", "core_kind": "decision"}]},
    }
    duplicate = {
        "content": "同じ決定",
        "status": "explicit",
        "evidence_segment_ids": [str(evidence_id)],
    }
    previous = {"decisions": [duplicate, duplicate]}
    result = RealtimeAnalysisOutput.model_validate(
        {
            "input_revision": 2,
            "as_of_ms": 1000,
            "summary": {"content": "要約", "evidence_segment_ids": [evidence_id]},
            "decisions": [],
            "superseded": {"decisions": [{"index": 0, "evidence_segment_ids": [evidence_id]}]},
        }
    )
    _stabilize_snapshot(previous, result, [{"evidence_id": str(evidence_id)}])
    values = [{
        "card_id": "decisions", "row_id": "decision:0", "field_id": "note",
        "field_type": "short_text", "text_value": "曖昧な値", "value": "曖昧な値",
        "evidence_segment_ids": [str(evidence_id)],
    }]

    assert _remap_realtime_core_values(
        template_snapshot, _core_row_identities(previous), _core_row_identities(result), values
    ) == []


def test_realtime_merge_reads_typed_values_when_legacy_value_is_null() -> None:
    evidence_id = str(uuid.uuid4())
    previous = {
        "template_values": [
            {
                "card_id": "custom", "row_id": "row:0", "field_id": "flag",
                "field_type": "boolean", "value": None,
                "text_value": None, "number_value": None, "boolean_value": False,
                "evidence_segment_ids": [evidence_id],
            },
            {
                "card_id": "custom", "row_id": "row:1", "field_id": "count",
                "field_type": "number", "value": None,
                "text_value": None, "number_value": 0, "boolean_value": None,
                "evidence_segment_ids": [evidence_id],
            },
        ],
    }

    merged = merge_realtime_template_values(previous, [], [])

    assert merged == []
    retained = merge_realtime_template_values(
        previous, [], [{"evidence_id": evidence_id}]
    )
    assert [item["boolean_value"] for item in retained] == [False, None]
    assert [item["number_value"] for item in retained] == [None, 0]
    assert str(AnalysisItemKind.DECISION) == "decision"


def test_final_duplicate_rows_require_unique_evidence_match() -> None:
    evidence_id = uuid.uuid4()
    result = StructuredMinutesOutput.model_validate(
        {
            "summary": "要約",
            "summary_evidence_segment_ids": [evidence_id],
            "decisions": [
                {"content": "同じ決定", "evidence_segment_ids": [evidence_id]},
                {"content": "同じ決定", "evidence_segment_ids": [evidence_id]},
            ],
        }
    )
    saved_items = [
        SimpleNamespace(
            kind=AnalysisItemKind.DECISION,
            content="同じ決定",
            evidence=[SimpleNamespace(segment_id=evidence_id)],
        ),
        SimpleNamespace(
            kind=AnalysisItemKind.DECISION,
            content="同じ決定",
            evidence=[SimpleNamespace(segment_id=evidence_id)],
        ),
    ]
    values = [
        {
            "card_id": "decisions",
            "row_id": f"decision:{index}",
            "field_id": "note",
            "value": str(index),
        }
        for index in range(2)
    ]
    snapshot = {"definition": {"final": [{"id": "decisions", "core_kind": "decision"}]}}

    assert remap_final_core_rows(snapshot, result, saved_items, values) == []

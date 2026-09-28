from __future__ import annotations

from typing import Any

from app.schemas.analysis import StructuredMinutesOutput


def remap_final_core_rows(
    snapshot: dict[str, Any] | None,
    result: StructuredMinutesOutput,
    saved_items: list[Any],
    values: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    if not snapshot or not values:
        return values
    card_kinds = {
        card["id"]: card.get("core_kind")
        for card in snapshot.get("definition", {}).get("final", [])
    }
    source_groups: dict[str, list[tuple[str, set[str]]]] = {
        "summary": [(result.summary, {str(item) for item in result.summary_evidence_segment_ids})],
        "decision": [
            (item.content, {str(evidence_id) for evidence_id in item.evidence_segment_ids})
            for item in result.decisions
        ],
        "action_item": [
            (item.content, {str(evidence_id) for evidence_id in item.evidence_segment_ids})
            for item in result.action_items
        ],
        "open_question": [
            (item.content, {str(evidence_id) for evidence_id in item.evidence_segment_ids})
            for item in result.open_questions
        ],
        "important_point": [
            (item.content, {str(evidence_id) for evidence_id in item.evidence_segment_ids})
            for item in result.important_points
        ],
        "chapter": [
            (item.title, {str(evidence_id) for evidence_id in item.evidence_segment_ids})
            for item in result.chapters
        ],
        "suggested_question": [
            (item.content, {str(evidence_id) for evidence_id in item.evidence_segment_ids})
            for item in result.suggested_questions
        ],
        "highlight": [
            (item.title, {str(evidence_id) for evidence_id in item.evidence_segment_ids})
            for item in result.highlights
        ],
    }
    kind_to_item_kind = {
        "summary": "summary", "decision": "decision", "action_item": "action_item",
        "open_question": "open_question", "important_point": "important_point",
        "chapter": "chapter", "suggested_question": "suggested_question", "highlight": "highlight",
    }
    remapped: list[dict[str, Any]] = []
    mapped_rows: dict[tuple[str, int], int | None] = {}
    for value in values:
        core_kind = card_kinds.get(value["card_id"])
        if core_kind is None:
            remapped.append(value)
            continue
        try:
            source_index = int(value["row_id"].rsplit(":", 1)[1])
            source_content, source_evidence = source_groups[core_kind][source_index]
        except (KeyError, IndexError, ValueError):
            continue
        source_content = source_content.strip()
        item_kind = kind_to_item_kind[core_kind]
        same_kind = [item for item in saved_items if str(item.kind) == item_kind]
        source_key = (core_kind, source_index)
        if source_key not in mapped_rows:
            candidates = [
                (index, item)
                for index, item in enumerate(same_kind)
                if item.content.strip() == source_content
            ]
            if len(candidates) == 1:
                mapped_rows[source_key] = candidates[0][0]
            else:
                exact_evidence_matches = [
                    index
                    for index, item in candidates
                    if {
                        str(evidence.segment_id) for evidence in getattr(item, "evidence", [])
                    } == source_evidence
                ]
                mapped_rows[source_key] = (
                    exact_evidence_matches[0]
                    if len(exact_evidence_matches) == 1
                    else None
                )
        mapped_index = mapped_rows[source_key]
        if mapped_index is None:
            continue
        remapped.append({**value, "row_id": f"{core_kind}:{mapped_index}"})
    return remapped


import math
import uuid
from typing import Any

from app.schemas.analysis import TemplateValueOutput


class RealtimeTemplateValueError(ValueError):
    pass


def validate_realtime_template_values(
    values: list[TemplateValueOutput],
    snapshot: dict[str, Any] | None,
    current: list[dict[str, Any]],
    core_rows: set[tuple[str, str]],
) -> list[dict[str, Any]]:
    if not values:
        return []
    if not snapshot:
        raise RealtimeTemplateValueError("テンプレートのRealtime snapshotがありません")
    cards = {
        card["id"]: card
        for card in snapshot.get("definition", {}).get("realtime", [])
        if card.get("visible", True)
    }
    allowed = {uuid.UUID(str(item["evidence_id"])) for item in current}
    seen: set[tuple[str, str, str]] = set()
    serialized: list[dict[str, Any]] = []
    for item in values:
        card = cards.get(item.card_id)
        if card is None:
            raise RealtimeTemplateValueError("未知または非表示のRealtimeカードです")
        field = next((f for f in card.get("fields", []) if f.get("id") == item.field_id), None)
        if field is None or item.field_type != field.get("type"):
            raise RealtimeTemplateValueError("RealtimeフィールドIDまたは型が不正です")
        core_kind = card.get("core_kind")
        if core_kind and (core_kind, item.row_id) not in core_rows:
            raise RealtimeTemplateValueError("Realtime core row_idが標準項目に対応しません")
        key = (item.card_id, item.row_id, item.field_id)
        if key in seen:
            raise RealtimeTemplateValueError("Realtimeフィールド値が重複しています")
        seen.add(key)
        value = item.value
        kind = field.get("type")
        valid = (
            value is None
            or (kind in {"short_text", "long_text"} and isinstance(value, str)
                and len(value) <= (500 if kind == "short_text" else 5000))
            or (kind == "number" and isinstance(value, (int, float)) and not isinstance(value, bool)
                and math.isfinite(value))
            or (kind == "date" and isinstance(value, str) and _is_date(value))
            or (kind == "boolean" and isinstance(value, bool))
            or (
                kind == "single_select"
                and isinstance(value, str)
                and value in field.get("options", [])
            )
        )
        if not valid:
            raise RealtimeTemplateValueError("Realtime値がフィールド型または選択肢と不一致です")
        evidence_ids = item.evidence_segment_ids
        if (value is None and evidence_ids) or (value is not None and not evidence_ids):
            raise RealtimeTemplateValueError("Realtime値とEvidenceの組み合わせが不正です")
        if set(evidence_ids) - allowed:
            raise RealtimeTemplateValueError("現在のLive TranscriptにないRealtime Evidenceです")
        serialized.append({
            "card_id": item.card_id, "row_id": item.row_id, "field_id": item.field_id,
            "field_type": item.field_type, "value": value, "text_value": item.text_value,
            "number_value": item.number_value, "boolean_value": item.boolean_value,
            "evidence_segment_ids": [str(value) for value in evidence_ids],
        })
    return serialized


def realtime_core_rows(snapshot: Any) -> set[tuple[str, str]]:
    rows: set[tuple[str, str]] = {("summary", "summary:0")}
    groups = {
        "decision": snapshot.decisions,
        "action_item": snapshot.action_items,
        "open_question": snapshot.attention_items,
        "important_point": snapshot.key_facts,
    }
    for kind, items in groups.items():
        rows.update((kind, f"{kind}:{index}") for index in range(len(items)))
    return rows


def merge_realtime_template_values(
    previous: dict[str, Any] | None,
    new_values: list[dict[str, Any]],
    current: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    allowed = {str(item["evidence_id"]) for item in current}
    kept: dict[tuple[str, str, str], dict[str, Any]] = {}
    for item in (previous or {}).get("template_values", []):
        evidence = [value for value in item.get("evidence_segment_ids", []) if value in allowed]
        raw_value = item.get("value")
        if raw_value is None:
            field_type = item.get("field_type")
            if field_type == "number":
                raw_value = item.get("number_value")
            elif field_type == "boolean":
                raw_value = item.get("boolean_value")
            else:
                raw_value = item.get("text_value")
        if raw_value is None or evidence:
            copied = {**item, "evidence_segment_ids": evidence}
            key = (
                copied.get("card_id", ""),
                copied.get("row_id", ""),
                copied.get("field_id", ""),
            )
            kept[key] = copied
    for item in new_values:
        key = (item["card_id"], item["row_id"], item["field_id"])
        kept[key] = item
    return list(kept.values())


def _is_date(value: str) -> bool:
    from datetime import date

    try:
        date.fromisoformat(value)
        return True
    except ValueError:
        return False


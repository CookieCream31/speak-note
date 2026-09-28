import math
import uuid
from datetime import date
from typing import Any

from app.models.transcript import TranscriptSegment
from app.schemas.analysis import StructuredMinutesOutput, TemplateValueOutput


class TemplateValueError(ValueError):
    pass


def template_instruction(snapshot: dict[str, Any] | None, view: str) -> str:
    if not snapshot:
        return ""
    cards = snapshot.get("definition", {}).get(view, [])
    cards = [card for card in cards if card.get("visible", True)]
    if not cards:
        return ""
    import json

    concise = [
        {
            "card_id": card["id"],
            "title": card["title"],
            "core_kind": card.get("core_kind"),
            "instructions": card.get("instructions", ""),
            "fields": [
                {
                    "field_id": field["id"],
                    "name": field["name"],
                    "type": field["type"],
                    "options": field.get("options", []),
                    "required": field.get("required", False),
                }
                for field in card.get("fields", [])
            ],
        }
        for card in cards
    ]
    return (
        "追加のテンプレート値が必要です。カードとフィールドのIDをそのまま使い、"
        "値に対応するevidence_segment_idsを必ず指定してください。根拠がない値はnullとし、"
        "根拠IDも空配列にします。core_kind付きカードのrow_idはsummaryの場合summary:0、"
        "その他は対応するcore_kindと0始まりの項目番号を使います。例: decision:0、action_item:1。"
        "独自カードだけ任意の安定row_idを使います。\n"
        "template_valuesの形式: [{card_id, row_id, field_id, field_type, "
        "text_value, number_value, boolean_value, evidence_segment_ids}]\n"
        "テンプレート定義: " + json.dumps(concise, ensure_ascii=False)
    )


def core_rows(result: StructuredMinutesOutput) -> set[tuple[str, str]]:
    rows: set[tuple[str, str]] = {("summary", "summary:0")}
    collections: dict[str, list[Any]] = {
        "decision": result.decisions,
        "action_item": result.action_items,
        "open_question": result.open_questions,
        "important_point": result.important_points,
        "chapter": result.chapters,
        "suggested_question": result.suggested_questions,
        "highlight": result.highlights,
    }
    for kind, items in collections.items():
        rows.update((kind, f"{kind}:{index}") for index in range(len(items)))
    return rows


def validate_template_values(
    values: list[TemplateValueOutput],
    snapshot: dict[str, Any] | None,
    segment_by_id: dict[uuid.UUID, TranscriptSegment],
    valid_core_rows: set[tuple[str, str]],
) -> list[dict[str, Any]]:
    if not values:
        return []
    if not snapshot:
        raise TemplateValueError("テンプレート未選択の会議にカスタム値が返されました")
    cards = {
        card["id"]: card
        for card in snapshot.get("definition", {}).get("final", [])
        if card.get("visible", True)
    }
    seen: set[tuple[str, str, str]] = set()
    result: list[dict[str, Any]] = []
    for item in values:
        card = cards.get(item.card_id)
        if card is None:
            raise TemplateValueError(f"未知または非表示のカードID: {item.card_id}")
        field = next(
            (entry for entry in card.get("fields", []) if entry.get("id") == item.field_id),
            None,
        )
        if field is None:
            raise TemplateValueError(f"未知のフィールドID: {item.field_id}")
        if card.get("core_kind") and (card["core_kind"], item.row_id) not in valid_core_rows:
            raise TemplateValueError("core card row_idが既存の標準項目に対応しません")
        key = (item.card_id, item.row_id, item.field_id)
        if key in seen:
            raise TemplateValueError("カード行内でフィールド値が重複しています")
        seen.add(key)
        value = item.value
        kind = field.get("type")
        if item.field_type != kind:
            raise TemplateValueError(
                f"AI field typeがテンプレート定義と一致しません: {item.field_id}"
            )
        valid = (
            value is None
            or (
                kind in {"short_text", "long_text"}
                and isinstance(value, str)
                and len(value) <= (500 if kind == "short_text" else 5000)
            )
            or (
                kind == "number"
                and isinstance(value, (int, float))
                and not isinstance(value, bool)
                and math.isfinite(value)
            )
            or (kind == "date" and isinstance(value, str) and _valid_date(value))
            or (kind == "boolean" and isinstance(value, bool))
            or (
                kind == "single_select"
                and isinstance(value, str)
                and value in field.get("options", [])
            )
        )
        if not valid:
            raise TemplateValueError(f"フィールドの型または選択肢が不正です: {item.field_id}")
        evidence_ids = item.evidence_segment_ids
        if value is None and evidence_ids:
            raise TemplateValueError("不明値にはevidenceを設定できません")
        if value is not None and not evidence_ids:
            raise TemplateValueError("値にはTranscript根拠が必要です")
        if any(segment_id not in segment_by_id for segment_id in evidence_ids):
            raise TemplateValueError("存在しないTranscript Segment IDが含まれています")
        result.append(
            {
                "card_id": item.card_id,
                "row_id": item.row_id,
                "field_id": item.field_id,
                "field_type": item.field_type,
                "text_value": item.text_value,
                "number_value": item.number_value,
                "boolean_value": item.boolean_value,
                "state": "generated",
                "evidence_segment_ids": [str(segment_id) for segment_id in evidence_ids],
            }
        )
    return result


def _valid_date(value: str) -> bool:
    try:
        date.fromisoformat(value)
        return True
    except ValueError:
        return False

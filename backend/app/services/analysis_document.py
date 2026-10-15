"""Build the editable meeting document from the saved analysis, without invoking AI."""

from collections.abc import Mapping, Sequence
from datetime import date, datetime
from typing import Any, Protocol

from app.models.analysis import AnalysisItemKind, AnalysisItemState
from app.schemas.meeting_template import TemplateCard, TemplateDefinition


class DocumentItem(Protocol):
    kind: AnalysisItemKind
    state: AnalysisItemState
    content: str
    assignee: str | None
    deadline: date | None
    sequence: int
    created_at: datetime
    updated_at: datetime


LABELS = {
    "summary": "要約",
    "decision": "決定事項",
    "action_item": "Action Item",
    "open_question": "確認ポイント",
    "important_point": "重要情報",
    "chapter": "チャプター",
    "suggested_question": "質問候補",
}


def _field_value(value: Mapping[str, Any] | None) -> str:
    if value is None:
        return "未入力"
    raw = value.get("value")
    if "value" not in value:
        key = {
            "number": "number_value",
            "boolean": "boolean_value",
        }.get(value.get("field_type", ""), "text_value")
        raw = value.get(key)
    if raw is None or raw == "":
        return "未入力"
    if isinstance(raw, bool):
        return "はい" if raw else "いいえ"
    return str(raw)


def _item_text(item: DocumentItem) -> str:
    if item.kind != AnalysisItemKind.ACTION_ITEM:
        return item.content
    suffix = f"担当: {item.assignee or '担当者不明'}"
    if item.deadline is not None:
        suffix += f" / 期限: {item.deadline.isoformat()}"
    return f"{item.content}\n{suffix}"


def render_analysis_document(
    items: Sequence[DocumentItem],
    snapshot: Mapping[str, Any] | None,
    values: Sequence[Mapping[str, Any]],
) -> str:
    by_kind: dict[str, list[DocumentItem]] = {}
    for item in sorted(items, key=lambda item: item.sequence):
        by_kind.setdefault(item.kind, []).append(item)
    summaries = by_kind.get("summary", [])
    if len(summaries) > 1:
        protected = [item for item in summaries if item.state != AnalysisItemState.GENERATED]
        by_kind["summary"] = [
            max(
                protected or summaries,
                key=lambda item: (
                    (item.updated_at if protected else item.created_at).isoformat(),
                    item.sequence,
                ),
            )
        ]
    if snapshot is None:
        return "\n\n".join(
            f"{title}\n" + ("\n\n".join(_item_text(item) for item in rows) or "まだありません")
            for kind, title in LABELS.items()
            if (rows := by_kind.get(kind, [])) or kind not in {"chapter", "suggested_question"}
        )

    cards = TemplateDefinition.model_validate(snapshot["definition"]).final
    return "\n\n".join(
        text for card in cards if card.visible if (text := _card_text(card, by_kind, values))
    )


def _card_text(
    card: TemplateCard,
    by_kind: dict[str, list[DocumentItem]],
    values: Sequence[Mapping[str, Any]],
) -> str:
    fields_by_row: dict[str, dict[str, Mapping[str, Any]]] = {}
    for value in values:
        if value.get("card_id") == card.id:
            fields_by_row.setdefault(value["row_id"], {})[value["field_id"]] = value

    def fields(row_id: str) -> str:
        row = fields_by_row.get(row_id, {})
        return "\n".join(
            f"{field.name}: {_field_value(row.get(field.id))}" for field in card.fields
        )

    rows: list[str] = []
    if card.core_kind is not None:
        for index, item in enumerate(by_kind.get(card.core_kind, [])):
            row_id = f"{card.core_kind}:{index}"
            rows.append("\n".join(filter(None, [_item_text(item), fields(row_id)])))
    else:
        rows = [
            fields(row_id)
            for row_id, row_values in fields_by_row.items()
            if any(_field_value(value) != "未入力" for value in row_values.values())
        ]
    if not rows and not card.show_when_empty:
        return ""
    return f"{card.title}\n" + ("\n\n".join(rows) or "まだありません")

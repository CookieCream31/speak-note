from typing import Any

from app.schemas.realtime_analysis import RealtimeAnalysisOutput


def _rows(kind: str, snapshot: Any) -> list[Any]:
    return {
        "summary": [snapshot.summary],
        "decision": snapshot.decisions,
        "action_item": snapshot.action_items,
        "open_question": snapshot.attention_items,
        "important_point": snapshot.key_facts,
    }.get(kind, [])


def _identity(kind: str, item: Any) -> str:
    if kind == "summary":
        return "summary"
    if kind == "open_question":
        return str(item.type) + ":" + " ".join(item.title.split()).casefold()
    if kind == "important_point":
        return " ".join(item.label.split()).casefold()
    return " ".join(item.content.split()).casefold()


def _snapshot_rows(kind: str, snapshot: dict[str, Any] | None) -> list[dict[str, Any]]:
    if not snapshot:
        return []
    if kind == "summary":
        return [snapshot.get("summary", {})]
    return {
        "decision": snapshot.get("decisions", []),
        "action_item": snapshot.get("action_items", []),
        "open_question": snapshot.get("attention_items", []),
        "important_point": snapshot.get("key_facts", []),
    }.get(kind, [])


def _snapshot_identity(kind: str, item: dict[str, Any]) -> str:
    if kind == "summary":
        return "summary"
    if kind == "open_question":
        return str(item.get("type", "")) + ":" + " ".join(
            str(item.get("title", "")).split()
        ).casefold()
    if kind == "important_point":
        return " ".join(str(item.get("label", "")).split()).casefold()
    return " ".join(str(item.get("content", "")).split()).casefold()


def remap_realtime_core_values(
    values: list[dict[str, Any]],
    source_snapshot: dict[str, Any] | None,
    stable_result: RealtimeAnalysisOutput,
    template_snapshot: dict[str, Any] | None,
) -> list[dict[str, Any]]:
    if not values or not template_snapshot:
        return values
    cards = {
        card["id"]: card
        for card in template_snapshot.get("definition", {}).get("realtime", [])
    }
    result: list[dict[str, Any]] = []
    for value in values:
        kind = cards.get(value.get("card_id"), {}).get("core_kind")
        if not kind:
            result.append(value)
            continue
        try:
            old_index = int(value["row_id"].rsplit(":", 1)[1])
        except (KeyError, ValueError, IndexError):
            continue
        source = _snapshot_rows(kind, source_snapshot)
        if old_index >= len(source):
            continue
        identity = _snapshot_identity(kind, source[old_index])
        final = _rows(kind, stable_result)
        new_index = next(
            (index for index, item in enumerate(final) if _identity(kind, item) == identity),
            None,
        )
        if new_index is None:
            continue
        result.append({**value, "row_id": f"{kind}:{new_index}"})
    return result
